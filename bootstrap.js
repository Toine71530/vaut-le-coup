// Production bootstrap with resilient Gemini fallback.
// Public proxy buffers complete responses before sending headers/body.
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
    const chunks = [];
    upstreamRes.on("data", chunk => chunks.push(chunk));
    upstreamRes.on("end", () => {
      const headers = { ...upstreamRes.headers };
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      delete headers["content-encoding"];
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) res.setHeader(key, value);
      }
      res.statusCode = upstreamRes.statusCode || 502;
      const body = Buffer.concat(chunks);
      res.setHeader("content-length", body.length);
      res.end(body);
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
