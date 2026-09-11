import express from "express";
import http from "http";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 10001);
const TARGET = `http://127.0.0.1:${INTERNAL_PORT}`;

app.use(express.json({ limit: "2mb" }));

const text = (v) => String(v ?? "").toUpperCase();

function number(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[^0-9,.-]/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function year(v) { return number(v?.year); }
function km(v) { return number(v?.mileage_km ?? v?.mileage ?? v?.mileage_display); }
function price(v) { return number(v?.price_eur ?? v?.price ?? v?.price_display); }

function generation(v) {
  const s = [v?.make, v?.model, v?.version, v?.trim, v?.title, v?.name, v?.description].map(text).join(" ");
  if (/\bPRIUS\s*(?:5|V)\b|\bGEN(?:ERATION)?\s*5\b|\bMK\s*5\b/.test(s)) return 5;
  if (/\bPRIUS\s*(?:4|IV)\b|\bGEN(?:ERATION)?\s*4\b|\bMK\s*4\b/.test(s)) return 4;
  if (/\bPRIUS\s*(?:3|III)\b|\bGEN(?:ERATION)?\s*3\b|\bMK\s*3\b/.test(s)) return 3;

  // For a 2023+ Prius identified as plug-in, the European target is Prius 5.
  const y = year(v);
  const s2 = [v?.energy, v?.version, v?.title, v?.name, v?.description].map(text).join(" ");
  if (/\bPRIUS\b/.test(s) && y !== null && y >= 2023 && /PHEV|PLUG.?IN|RECHARGEABLE/.test(s2)) return 5;
  return null;
}

function energy(v) {
  const s = [v?.energy, v?.version, v?.trim, v?.title, v?.name, v?.description].map(text).join(" ");
  if (/PHEV|PLUG.?IN|RECHARGEABLE/.test(s)) return "phev";
  if (/HYBRIDE|HEV/.test(s)) return "hybrid";
  if (/ELECTRIQUE|\bEV\b/.test(s)) return "ev";
  return null;
}

function power(v) {
  const direct = number(v?.power_hp ?? v?.power);
  if (direct !== null && direct >= 100 && direct <= 1000) return direct;
  const s = [v?.version, v?.trim, v?.title, v?.name, v?.description].map(text).join(" ");
  const m = s.match(/(?:^|\D)(\d{3})\s*(?:CH|HP)(?:\D|$)/);
  return m ? Number(m[1]) : null;
}

function trim(v) {
  return String(v?.trim ?? v?.finition ?? "").trim().toUpperCase() || null;
}

function isTargetFamily(v) {
  const s = [v?.make, v?.model, v?.version, v?.title, v?.name, v?.description].map(text).join(" ");
  return /TOYOTA/.test(s) && /PRIUS/.test(s);
}

function compatible(target, c) {
  if (!isTargetFamily(c)) return false;

  const tg = generation(target);
  const cg = generation(c);
  if (tg !== null) {
    if (cg === null || cg !== tg) return false;
  }

  const te = energy(target);
  const ce = energy(c);
  if (te !== null && ce !== te) return false;
  if (te === "phev" && ce !== "phev") return false;

  const tp = power(target);
  const cp = power(c);
  if (tp !== null && cp !== null && Math.abs(tp - cp) > 20) return false;

  const ty = year(target);
  const cy = year(c);
  if (ty !== null && cy !== null && Math.abs(ty - cy) > 2) return false;

  const p = price(c);
  return p !== null && p > 0;
}

function score(target, c) {
  let s = 0;
  const tg = generation(target), cg = generation(c);
  const te = energy(target), ce = energy(c);
  const tp = power(target), cp = power(c);
  const ty = year(target), cy = year(c);
  const tk = km(target), ck = km(c);
  const tt = trim(target), ct = trim(c);

  if (tg !== null && tg === cg) s += 100;
  if (te !== null && te === ce) s += 80;
  if (tp !== null && cp !== null) s += Math.max(0, 40 - Math.abs(tp - cp));
  if (tt && ct && tt === ct) s += 25;
  if (ty !== null && cy !== null) s += Math.max(0, 20 - Math.abs(ty - cy) * 5);
  if (tk !== null && ck !== null) s += Math.max(0, 20 - Math.min(20, Math.abs(tk - ck) / 5000));
  return s;
}

function dedupe(listings) {
  const seen = new Set();
  return listings.filter((x) => {
    const id = x.id || x.source_url || [x.make, x.model, x.year, x.mileage, x.price, x.title].join("|");
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function median(values) {
  const a = [...values].sort((a, b) => a - b);
  if (!a.length) return null;
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}

function percentile(values, p) {
  const a = [...values].sort((a, b) => a - b);
  if (!a.length) return null;
  if (a.length === 1) return a[0];
  const i = (a.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

function comparable(c) {
  return {
    price_display: price(c) !== null ? Math.round(price(c)).toLocaleString("fr-FR") + " €" : null,
    year: year(c),
    mileage_display: km(c) !== null ? Math.round(km(c)).toLocaleString("fr-FR") + " km" : null,
    energy: c.energy ?? null,
    version: c.version || c.finition || c.trim || c.title || null,
    source: c.source || c.site || null,
    source_url: c.source_url || c.url || c.link || null,
    title: c.title || c.name || null
  };
}

async function market(req, res) {
  try {
    const key = process.env.CARHUNT_API_KEY;
    if (!key) return res.status(503).json({ error: "CARHUNT_API_KEY manquante." });

    const target = req.body || {};
    const make = String(target.make || "").trim().toUpperCase();
    const model = String(target.model || "").trim().toUpperCase();
    const targetYear = year(target);
    const asking = price(target);

    if (!make || !model) return res.status(400).json({ error: "Marque et modèle nécessaires." });

    async function search(withYear) {
      const params = new URLSearchParams({ make, model, page_size: "100" });
      if (withYear && targetYear !== null) params.set("year", String(targetYear));
      const response = await fetch("https://api-pro.carhunt.fr/v1/listings/search?" + params.toString(), {
        headers: { Authorization: "Bearer " + key }
      });
      if (!response.ok) throw new Error("CarHunt HTTP " + response.status + ": " + await response.text());
      const data = await response.json();
      return Array.isArray(data.listings) ? data.listings : [];
    }

    let raw = await search(true);
    let filtered = dedupe(raw).filter((x) => compatible(target, x));

    // If the same-year pool is too small, broaden only the year, never the generation/energy.
    if (filtered.length < 5) {
      const wider = await search(false);
      filtered = dedupe([...filtered, ...wider.filter((x) => compatible(target, x))]);
    }

    // Keep only the strongest comparables; never fill the list with incompatible cars.
    filtered.sort((a, b) => score(target, b) - score(target, a));
    filtered = filtered.slice(0, 10);

    const prices = filtered.map(price).filter((x) => x !== null && x > 0);

    if (prices.length < 3) {
      return res.json({
        asking_display: asking !== null ? Math.round(asking).toLocaleString("fr-FR") + " €" : "Non déterminé",
        median_display: "Non déterminé",
        low_display: "Non déterminé",
        high_display: "Non déterminé",
        confidence: prices.length === 2 ? 30 : 15,
        label: "Données de marché insuffisantes",
        gap_text: "Pas assez de véhicules réellement comparables pour calculer une estimation fiable.",
        warning: `Seulement ${prices.length} comparable(s) réellement compatible(s). L'application ne calcule pas de faux prix médian.`,
        comparables: filtered.map(comparable)
      });
    }

    const med = median(prices);
    const low = percentile(prices, 0.15);
    const high = percentile(prices, 0.85);
    const gap = asking !== null && med ? Math.round((asking / med - 1) * 100) : null;

    let label = "Dans le marché";
    if (gap !== null) {
      if (gap <= -10) label = "Très intéressant";
      else if (gap <= -3) label = "Plutôt intéressant";
      else if (gap <= 3) label = "Dans le marché";
      else if (gap <= 10) label = "Plutôt cher";
      else label = "Cher";
    }

    return res.json({
      asking_display: asking !== null ? Math.round(asking).toLocaleString("fr-FR") + " €" : "Non déterminé",
      median_display: Math.round(med).toLocaleString("fr-FR") + " €",
      low_display: Math.round(low).toLocaleString("fr-FR") + " €",
      high_display: Math.round(high).toLocaleString("fr-FR") + " €",
      confidence: Math.min(95, 40 + prices.length * 7),
      label,
      gap_text: gap === null ? "Écart au marché non déterminé." : `Le prix demandé est ${Math.abs(gap)}% ${gap >= 0 ? "au-dessus" : "en dessous"} du prix médian.`,
      warning: prices.length < 5 ? "Estimation basée sur un petit échantillon de comparables." : null,
      comparables: filtered.map(comparable)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Erreur pendant la recherche marché." });
  }
}

function proxy(req, res, bodyBuffer) {
  const headers = { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}` };
  delete headers["content-length"];
  if (bodyBuffer) headers["content-length"] = Buffer.byteLength(bodyBuffer);

  const request = http.request(`${TARGET}${req.originalUrl}`, { method: req.method, headers }, (upstream) => {
    const chunks = [];
    upstream.on("data", (c) => chunks.push(c));
    upstream.on("end", () => {
      res.status(upstream.statusCode || 200);
      Object.entries(upstream.headers).forEach(([k, v]) => {
        if (!['transfer-encoding', 'content-length'].includes(k.toLowerCase()) && v != null) res.set(k, v);
      });
      res.send(Buffer.concat(chunks));
    });
  });
  request.on("error", (e) => {
    console.error("Proxy error:", e);
    res.status(502).json({ error: "Service interne indisponible." });
  });
  if (bodyBuffer) request.write(bodyBuffer);
  request.end();
}

app.use(async (req, res) => {
  if (req.path === "/api/market" && req.method === "POST") return market(req, res);
  const body = req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : null;
  return proxy(req, res, body);
});

const child = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(INTERNAL_PORT) },
  stdio: "inherit"
});

child.on("exit", (code) => { if (code && code !== 0) process.exit(code); });
app.listen(PORT, "0.0.0.0", () => console.log(`Market wrapper listening on ${PORT}; original server on ${INTERNAL_PORT}`));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
