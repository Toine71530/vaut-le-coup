// Production bootstrap with resilient Gemini fallback.
// The UI/market stack stays unchanged; this layer only makes Gemini image analysis
// tolerant of temporary 429/503/5xx model-capacity spikes.
import http from "node:http";

const nativeFetch = globalThis.fetch;
const INTERNAL_PORT = 10003;
const PUBLIC_PORT = Number(process.env.PORT || 10000);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isGeminiGenerate(url) {
  return typeof url === "string" &&
    url.includes("generativelanguage.googleapis.com") &&
    url.includes(":generateContent");
}

function replaceModel(url, model) {
  return url.replace(/\/models\/[^:]+:generateContent/, `/models/${model}:generateContent`);
}

async function resilientGeminiFetch(input, init) {
  const originalUrl = typeof input === "string" ? input : input?.url;
  if (!isGeminiGenerate(originalUrl)) return nativeFetch(input, init);

  // Primary stable model first; if Google reports temporary capacity/rate limits,
  // retry briefly and finally fall back to another stable free-tier Flash model.
  const models = ["gemini-3.6-flash", "gemini-3.6-flash", "gemini-3.6-flash", "gemini-3.5-flash"];
  let lastResponse;

  for (let i = 0; i < models.length; i++) {
    const url = replaceModel(originalUrl, models[i]);
    const request = typeof input === "string" ? url : new Request(url, input);
    const response = await nativeFetch(request, init);
    lastResponse = response;

    if (response.ok) return response;
    if (![429, 500, 502, 503, 504].includes(response.status)) return response;
    if (i < models.length - 1) await sleep(1000 * (i + 1));
  }

  return lastResponse;
}

globalThis.fetch = resilientGeminiFetch;
process.env.PORT = String(INTERNAL_PORT);
await import("./ui-final.js");

const server = http.createServer((req, res) => {
  const options = {
    hostname: "127.0.0.1",
    port: INTERNAL_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}` }
  };

  const upstream = http.request(options, upstreamRes => {
    const isAnalyze = req.url?.split("?")[0] === "/api/analyze";
    const chunks = [];

    upstreamRes.on("data", chunk => {
      if (isAnalyze) chunks.push(chunk);
      else res.write(chunk);
    });

    upstreamRes.on("end", () => {
      const headers = { ...upstreamRes.headers };
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) res.setHeader(key, value);
      }
      res.statusCode = upstreamRes.statusCode || 502;

      if (isAnalyze) {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          const parsed = JSON.parse(raw);
          const normalized = parsed?.vehicle
            ? parsed
            : parsed?.make || parsed?.model || parsed?.year || parsed?.price_eur
              ? { ok: true, vehicle: parsed }
              : parsed;
          const body = JSON.stringify(normalized);
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("content-length", Buffer.byteLength(body));
          res.end(body);
        } catch {
          res.end(raw);
        }
        return;
      }
      res.end();
    });
  });

  upstream.on("error", err => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Backend indisponible", detail: err.message }));
    } else res.end();
  });

  req.pipe(upstream);
});

server.listen(PUBLIC_PORT, () => {
  console.log(`Vaut le Coup public proxy listening on ${PUBLIC_PORT}`);
});
