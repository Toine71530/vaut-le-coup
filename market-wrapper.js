import express from "express";
import http from "http";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 10001);
const TARGET = `http://127.0.0.1:${INTERNAL_PORT}`;

app.use(express.json({ limit: "2mb" }));

const text = (v) => String(v ?? "").toUpperCase();

function generation(v) {
  const s = [v?.model, v?.version, v?.trim, v?.title, v?.name].map(text).join(" ");
  if (/\b(?:PRIUS\s*5|PRIUS\s*V|GEN(?:ERATION)?\s*5|MK\s*5)\b/.test(s)) return 5;
  if (/\b(?:PRIUS\s*4|PRIUS\s*IV|GEN(?:ERATION)?\s*4|MK\s*4)\b/.test(s)) return 4;
  if (/\b(?:PRIUS\s*3|PRIUS\s*III|GEN(?:ERATION)?\s*3|MK\s*3)\b/.test(s)) return 3;
  const year = Number(v?.year);
  if (/\bPRIUS\b/.test(s) && Number.isFinite(year) && year >= 2023) return 5;
  return null;
}

function energyKind(v) {
  const s = [v?.energy, v?.version, v?.title, v?.name].map(text).join(" ");
  if (/RECHARGEABLE|PHEV|PLUG.?IN|HYBRIDE\s+RECHARGEABLE/.test(s)) return "phev";
  if (/HYBRIDE|HEV/.test(s)) return "hybrid";
  if (/ELECTRIQUE|\bEV\b/.test(s)) return "ev";
  return null;
}

function power(v) {
  const direct = Number(v?.power_hp);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const s = [v?.version, v?.title, v?.name].map(text).join(" ");
  const m = s.match(/(?:^|\D)(\d{3})\s*(?:CH|HP)(?:\D|$)/);
  return m ? Number(m[1]) : null;
}

function year(v) {
  const n = Number(v?.year);
  return Number.isFinite(n) ? n : null;
}

function km(v) {
  const n = Number(v?.mileage_km);
  return Number.isFinite(n) ? n : null;
}

function isToyotaPrius(v) {
  const s = [v?.make, v?.model, v?.version, v?.title, v?.name].map(text).join(" ");
  return /TOYOTA/.test(s) && /PRIUS/.test(s);
}

function compatible(target, c) {
  if (!isToyotaPrius(c)) return false;

  const tg = generation(target);
  const cg = generation(c);
  if (tg && cg && tg !== cg) return false;
  if (tg === 5 && cg !== 5) return false;

  const te = energyKind(target);
  const ce = energyKind(c);
  if (te && ce && te !== ce) return false;
  if (te === "phev" && ce !== "phev") return false;

  const tp = power(target);
  const cp = power(c);
  if (tp && cp && Math.abs(tp - cp) > 20) return false;
  if (tp && !cp) return false;

  const ty = year(target);
  const cy = year(c);
  if (ty && cy && Math.abs(ty - cy) > 2) return false;

  return true;
}

function score(target, c) {
  let s = 0;
  const tg = generation(target), cg = generation(c);
  const te = energyKind(target), ce = energyKind(c);
  const tp = power(target), cp = power(c);
  const ty = year(target), cy = year(c);
  const tk = km(target), ck = km(c);

  if (tg && cg && tg === cg) s += 40;
  if (te && ce && te === ce) s += 30;
  if (tp && cp) s += Math.max(0, 20 - Math.abs(tp - cp));
  if (ty && cy) s += Math.max(0, 10 - Math.abs(ty - cy) * 3);
  if (tk && ck) s += Math.max(0, 10 - Math.min(10, Math.abs(tk - ck) / 10000));
  return s;
}

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

function percentile(values, p) {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return null;
  if (a.length === 1) return a[0];
  const i = (a.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

function targetFromBody(body) {
  if (!body || typeof body !== "object") return body || {};
  if (body.vehicle && typeof body.vehicle === "object") return body.vehicle;
  if (body.target && typeof body.target === "object") return body.target;
  if (body.analysis && typeof body.analysis === "object") return body.analysis;
  return body;
}

function rebuild(data, target) {
  if (!data || !Array.isArray(data.comparables)) return data;

  const filtered = data.comparables
    .filter((c) => compatible(target, c))
    .sort((a, b) => score(target, b) - score(target, a));

  // Do not manufacture a valuation from an insufficient sample.
  const prices = filtered.map((c) => Number(c.price_eur)).filter((n) => Number.isFinite(n) && n > 0);
  if (prices.length < 2) {
    return {
      ...data,
      comparables: filtered,
      confidence: Math.min(Number(data.confidence) || 0, 20),
      median: null,
      median_display: "Non déterminé",
      low: null,
      high: null,
      low_display: "Non déterminé",
      high_display: "Non déterminé",
      gap_text: "Pas assez de comparables réellement compatibles pour estimer le prix du marché.",
      warning: `Seulement ${prices.length} comparable(s) réellement compatible(s) après filtrage. Aucune médiane n'est calculée.`,
      label: "Données de marché insuffisantes"
    };
  }

  const med = median(prices);
  const low = percentile(prices, 0.15);
  const high = percentile(prices, 0.85);
  const asking = Number(target?.price_eur ?? data.asking_price_eur);
  const gap = Number.isFinite(asking) && med ? Math.round((asking / med - 1) * 100) : null;

  return {
    ...data,
    comparables: filtered,
    median: med,
    median_display: Number.isFinite(med) ? Math.round(med).toLocaleString("fr-FR") + " €" : "Non déterminé",
    low,
    high,
    low_display: Number.isFinite(low) ? Math.round(low).toLocaleString("fr-FR") + " €" : "Non déterminé",
    high_display: Number.isFinite(high) ? Math.round(high).toLocaleString("fr-FR") + " €" : "Non déterminé",
    confidence: Math.min(100, Math.max(35, 35 + prices.length * 10)),
    gap_text: gap == null ? "Écart au marché non déterminé." : `Le prix demandé est ${Math.abs(gap)}% ${gap >= 0 ? "au-dessus" : "en-dessous"} du prix médian.`,
    warning: null,
    label: gap == null ? "Marché comparable" : gap > 10 ? "Plutôt cher" : gap < -10 ? "Plutôt intéressant" : "Dans le marché"
  };
}

function proxy(req, res, bodyBuffer) {
  const headers = { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}` };
  delete headers["content-length"];
  const payload = bodyBuffer ?? null;
  if (payload) headers["content-length"] = Buffer.byteLength(payload);

  const request = http.request(`${TARGET}${req.originalUrl}`, {
    method: req.method,
    headers
  }, (upstream) => {
    const chunks = [];
    upstream.on("data", (c) => chunks.push(c));
    upstream.on("end", () => {
      const raw = Buffer.concat(chunks);
      const type = String(upstream.headers["content-type"] || "");
      if (req.path === "/api/market" && type.includes("application/json")) {
        try {
          const original = JSON.parse(raw.toString("utf8"));
          const fixed = rebuild(original, targetFromBody(req.body));
          const out = Buffer.from(JSON.stringify(fixed));
          res.status(upstream.statusCode || 200);
          res.set("content-type", "application/json; charset=utf-8");
          res.send(out);
          return;
        } catch {}
      }
      res.status(upstream.statusCode || 200);
      Object.entries(upstream.headers).forEach(([k, v]) => {
        if (k.toLowerCase() !== "transfer-encoding" && v != null) res.set(k, v);
      });
      res.send(raw);
    });
  });
  request.on("error", () => res.status(502).json({ error: "Service interne indisponible." }));
  if (payload) request.write(payload);
  request.end();
}

app.use((req, res) => {
  const body = req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : null;
  proxy(req, res, body);
});

const child = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(INTERNAL_PORT) },
  stdio: "inherit"
});

child.on("exit", (code) => {
  if (code && code !== 0) process.exit(code);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Market wrapper listening on ${PORT}; original server on ${INTERNAL_PORT}`);
});

process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
