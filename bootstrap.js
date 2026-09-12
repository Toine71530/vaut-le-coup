// Production bootstrap.
// ui-final runs internally; this public proxy keeps the frontend contract stable.
import http from "node:http";

const INTERNAL_PORT = 10003;
const PUBLIC_PORT = Number(process.env.PORT || 10000);
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
