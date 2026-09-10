import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: "2mb" }));


const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function cleanJson(text) {
  const s = String(text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  throw new Error("Réponse JSON invalide.");
}


app.get("/", (_req, res) => res.type("html").send(HTML));

app.post("/api/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Aucune image reçue." });
    if (!openai) return res.status(503).json({ error: "OPENAI_API_KEY manquante. Le moteur IA n'est pas configuré." });

    const mime = req.file.mimetype || "image/jpeg";
    const dataUrl = `data:${mime};base64,${req.file.buffer.toString("base64")}`;

    const prompt = `Tu es le moteur de lecture de l'application française "Vaut le Coup ?".
Analyse UNIQUEMENT les informations réellement visibles dans cette capture d'annonce automobile.
N'invente jamais une donnée. Si une donnée est incertaine ou illisible, mets null et explique brièvement pourquoi.
Retourne UNIQUEMENT un objet JSON valide avec exactement ces clés:
{
  "make": string|null,
  "model": string|null,
  "version": string|null,
  "year": number|null,
  "mileage_km": number|null,
  "price_eur": number|null,
  "energy": string|null,
  "gearbox": string|null,
  "power_hp": number|null,
  "seller_type": "professional"|"private"|null,
  "location": string|null,
  "title": string|null,
  "confidence": number,
  "uncertain_fields": string[],
  "visible_claims": string[],
  "warnings": string[]
}
confidence doit être un entier de 0 à 100 représentant la confiance globale de lecture.
Important: ne déduis pas une finition, une puissance, une énergie ou un type de vendeur si ce n'est pas lisible.`;

    const response = await openai.responses.create({
      model: "gpt-5.6-luna",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: dataUrl, detail: "high" }
        ]
      }]
    });

    const vehicle = JSON.parse(cleanJson(response.output_text));
    res.json({ ok: true, vehicle });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Erreur pendant l'analyse." });
  }
});

app.post("/api/market", async (req, res) => {
  try {
    const key = process.env.CARHUNT_API_KEY;
    if (!key) return res.status(503).json({ error: "CARHUNT_API_KEY manquante. Comparaison marché non activée." });

    const v = req.body || {};
    if (!v.make || !v.model) return res.status(400).json({ error: "Marque/modèle nécessaires." });

    const params = new URLSearchParams({
      make: String(v.make).toUpperCase(),
      model: String(v.model).toUpperCase(),
      page_size: "100"
    });
    if (v.year) {
      params.set("year_min", String(Number(v.year) - 1));
      params.set("year_max", String(Number(v.year) + 1));
    }
    if (v.mileage_km) {
      params.set("mileage_min", String(Math.max(0, Number(v.mileage_km) - 30000)));
      params.set("mileage_max", String(Number(v.mileage_km) + 30000));
    }

    const r = await fetch(`https://api-pro.carhunt.fr/v1/listings/search?${params}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!r.ok) throw new Error(`CarHunt HTTP ${r.status}`);
    const data = await r.json();
    const listings = (data.listings || []).filter(x => Number.isFinite(Number(x.price)));
    const prices = listings.map(x => Number(x.price)).sort((a,b) => a-b);

    if (!prices.length) return res.json({ ok: true, comparables: 0, market_median_eur: null, low_eur: null, high_eur: null });

    const median = prices[Math.floor(prices.length / 2)];
    const q = p => prices[Math.max(0, Math.min(prices.length - 1, Math.floor((prices.length - 1) * p)))];

    res.json({
      ok: true,
      comparables: prices.length,
      market_median_eur: Math.round(median),
      low_eur: Math.round(q(0.15)),
      high_eur: Math.round(q(0.85)),
      sample: listings.slice(0, 8).map(x => ({
        price: x.price, year: x.year, mileage: x.mileage, energy: x.energy, seller_type: x.seller_type, source: x.source
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Erreur marché." });
  }
});

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  vision: Boolean(process.env.OPENAI_API_KEY),
  market: Boolean(process.env.CARHUNT_API_KEY)
}));

const HTML = '<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>Vaut le Coup ? — V0.4</title>\n<style>\n:root{font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f7f9;color:#17202a}\n*{box-sizing:border-box}body{margin:0}.wrap{max-width:720px;margin:auto;padding:20px}\nheader{padding:16px 0 22px}.brand{font-size:28px;font-weight:850}.tag{color:#68737d;margin-top:5px}\n.card{background:white;border:1px solid #e2e7eb;border-radius:18px;padding:18px;margin:14px 0;box-shadow:0 5px 18px #00000008}\n.drop{display:block;width:100%;border:2px dashed #bdc7cf;border-radius:16px;padding:28px;text-align:center;cursor:pointer;line-height:1.45;overflow-wrap:anywhere}\ninput[type=file]{display:none}button{border:0;border-radius:12px;padding:13px 16px;font-weight:800;cursor:pointer;background:#17202a;color:white}\nbutton:disabled{opacity:.45;cursor:not-allowed}.preview{width:100%;max-height:360px;object-fit:contain;border-radius:12px;margin-top:14px}\n.status{padding:12px;border-radius:12px;background:#f0f3f5;margin-top:14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}\n.k{font-size:12px;color:#75808a}.v{font-size:16px;font-weight:750}.pill{display:inline-block;padding:6px 10px;border-radius:99px;background:#eef2f4;margin:3px 3px 0 0}\n.score{font-size:44px;font-weight:900}.muted{color:#69747d}.warning{background:#fff5df;padding:10px;border-radius:10px;margin-top:8px}\n.hidden{display:none}.small{font-size:12px;color:#7a858e}\n</style>\n</head>\n<body>\n<div class="wrap">\n<header><div class="brand">Vaut le Coup ? ✓</div><div class="tag">Avant d’acheter. Demande à l’IA.</div></header>\n\n<section class="card">\n<h2>Analyse une annonce</h2>\n<p class="muted">V0.4 — lecture intelligente de la capture. Aucune information n’est inventée.</p>\n<label class="drop" for="file">📸<br><strong>Ajoute une capture ou une photo de l’annonce</strong><br><span class="small">JPG, PNG, WEBP — 12 Mo max</span></label>\n<input id="file" type="file" accept="image/*">\n<img id="preview" class="preview hidden">\n<div id="status" class="status hidden"></div>\n<button id="analyze" style="margin-top:14px;width:100%" disabled>Analyser l’annonce</button>\n</section>\n\n<section id="result" class="card hidden">\n<h2>Lecture de l’annonce</h2>\n<div id="confidence"></div>\n<div id="fields" class="grid" style="margin-top:14px"></div>\n<div id="claims" style="margin-top:14px"></div>\n<div id="warnings"></div>\n</section>\n\n<section id="market" class="card hidden">\n<h2>Marché</h2>\n<div id="marketText" class="muted">La comparaison marché sera activée quand la source de données sera configurée.</div>\n</section>\n</div>\n<script>\nconst fileEl=document.querySelector(\'#file\'), preview=document.querySelector(\'#preview\'), analyze=document.querySelector(\'#analyze\');\nconst status=document.querySelector(\'#status\'), result=document.querySelector(\'#result\'), fields=document.querySelector(\'#fields\'), confidence=document.querySelector(\'#confidence\'), claims=document.querySelector(\'#claims\'), warnings=document.querySelector(\'#warnings\'), market=document.querySelector(\'#market\'), marketText=document.querySelector(\'#marketText\');\nlet file=null, vehicle=null;\nfileEl.onchange=()=>{file=fileEl.files?.[0]; if(!file)return; preview.src=URL.createObjectURL(file); preview.classList.remove(\'hidden\'); analyze.disabled=false; result.classList.add(\'hidden\'); market.classList.add(\'hidden\'); status.classList.remove(\'hidden\'); status.textContent=\'Capture prête.\'};\nanalyze.onclick=async()=>{\n  analyze.disabled=true; status.textContent=\'🧠 Lecture de l’image par l’IA…\';\n  const fd=new FormData(); fd.append(\'image\',file);\n  try{\n    const r=await fetch(\'/api/analyze\',{method:\'POST\',body:fd}); const j=await r.json(); if(!r.ok)throw new Error(j.error||\'Erreur\');\n    vehicle=j.vehicle; renderVehicle(vehicle); status.textContent=\'✅ Lecture terminée.\';\n    market.classList.remove(\'hidden\'); marketText.textContent=\'Recherche de véhicules comparables…\';\n    const mr=await fetch(\'/api/market\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify(vehicle)});\n    const mj=await mr.json();\n    if(mj.ok&&mj.market_median_eur){marketText.innerHTML=`<strong>Médiane observée : ${mj.market_median_eur.toLocaleString(\'fr-FR\')} €</strong><br>Fourchette indicative : ${mj.low_eur.toLocaleString(\'fr-FR\')}–${mj.high_eur.toLocaleString(\'fr-FR\')} €<br><span class="small">${mj.comparables} comparables.</span>`}\n    else marketText.textContent=mj.error||\'Pas assez de données comparables.\';\n  }catch(e){status.textContent=\'❌ \'+e.message}\n  analyze.disabled=false;\n};\nfunction renderVehicle(v){\n result.classList.remove(\'hidden\');\n confidence.innerHTML=`<span class="pill">Confiance de lecture : ${v.confidence ?? 0}/100</span>`;\n const map=[[\'Marque\',v.make],[\'Modèle\',v.model],[\'Version\',v.version],[\'Année\',v.year],[\'Kilométrage\',v.mileage_km? v.mileage_km.toLocaleString(\'fr-FR\')+\' km\':null],[\'Prix\',v.price_eur? v.price_eur.toLocaleString(\'fr-FR\')+\' €\':null],[\'Énergie\',v.energy],[\'Boîte\',v.gearbox],[\'Vendeur\',v.seller_type===\'professional\'?\'Professionnel\':v.seller_type===\'private\'?\'Particulier\':null],[\'Lieu\',v.location]];\n fields.innerHTML=map.map(([k,x])=>`<div><div class="k">${k}</div><div class="v">${x??\'Non déterminé\'}</div></div>`).join(\'\');\n claims.innerHTML=(v.visible_claims||[]).length?\'<h3>Éléments visibles</h3>\'+(v.visible_claims||[]).map(x=>`<span class="pill">${escapeHtml(x)}</span>`).join(\'\'):\'\';\n warnings.innerHTML=(v.uncertain_fields||[]).map(x=>`<div class="warning">⚠️ À vérifier : ${escapeHtml(x)}</div>`).join(\'\')+(v.warnings||[]).map(x=>`<div class="warning">⚠️ ${escapeHtml(x)}</div>`).join(\'\');\n}\nfunction escapeHtml(s){return String(s).replace(/[&<>"\']/g,c=>({\'&\':\'&amp;\',\'<\':\'&lt;\',\'>\':\'&gt;\',\'"\':\'&quot;\',"\'":\'&#039;\'}[c]))}\n</script>\n</body>\n</html>\n';

app.listen(process.env.PORT || 3000, () => {
  console.log(`Vaut le Coup ? V0.4 sur http://localhost:${process.env.PORT || 3000}`);
});
