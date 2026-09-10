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
    if (!key) return res.status(503).json({ error: "CARHUNT_API_KEY manquante. La comparaison marché n'est pas encore activée." });
    const v = req.body || {};
    if (!v.make || !v.model) return res.status(400).json({ error: "Marque/modèle nécessaires." });
    const params = new URLSearchParams({ make: String(v.make).toUpperCase(), model: String(v.model).toUpperCase().replace(/\s+(?:[IVX]+|\d+)$/i, ""), page_size: "50" });
    const r = await fetch(`https://api-pro.carhunt.fr/v1/listings/search?${params}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) { const detail = await r.text(); throw new Error(`CarHunt HTTP ${r.status}: ${detail}`); }
    const data = await r.json();
    const listings = (data.listings || []).filter(x => {
  if (!Number.isFinite(Number(x.price)) || Number(x.price) <= 0) return false;
  if (v.year && x.year && Math.abs(Number(x.year) - Number(v.year)) > 1) return false;
  if (v.mileage_km && x.mileage && Math.abs(Number(x.mileage) - Number(v.mileage_km)) > 30000) return false;
  if (v.price_eur && v.year && v.mileage_km && Number(x.price) === Number(v.price_eur) && Number(x.year) === Number(v.year) && Number(x.mileage) === Number(v.mileage_km)) return false;
      return true;
});
    const prices = listings.map(x => Number(x.price)).sort((a,b) => a-b);
    if (!prices.length < 5) return res.json({ ok: true, comparables: 0, market_median_eur: null, low_eur: null, high_eur: null, deal_score: null });
    const median = prices[Math.floor(prices.length / 2)];
    const q = p => prices[Math.max(0, Math.min(prices.length - 1, Math.floor((prices.length - 1) * p)))];
    const asking = Number(v.price_eur);
    const gapPct = asking > 0 ? ((median - asking) / median) * 100 : null;
    const dealScore = gapPct == null ? null : Math.max(0, Math.min(100, Math.round(50 + gapPct * 2.5)));
    res.json({ ok: true, comparables: prices.length, market_median_eur: Math.round(median), low_eur: Math.round(q(0.15)), high_eur: Math.round(q(0.85)), asking_price_eur: Number.isFinite(asking) ? asking : null, gap_eur: Number.isFinite(asking) ? Math.round(median - asking) : null, gap_pct: gapPct == null ? null : Math.round(gapPct * 10) / 10, deal_score: dealScore, sample: listings.slice(0, 8).map(x => ({ price:x.price, year:x.year, mileage:x.mileage, energy:x.energy, gearbox:x.gearbox, horsepower:x.horsepower, seller_type:x.seller_type, source:x.source, source_url:x.source_url })) });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message || "Erreur marché." }); }
});

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  vision: Boolean(process.env.OPENAI_API_KEY),
  market: Boolean(process.env.CARHUNT_API_KEY)
}));

const HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vaut le Coup ? — V0.5</title>
<style>
:root{font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f7f9;color:#17202a}
*{box-sizing:border-box}body{margin:0}.wrap{max-width:720px;margin:auto;padding:20px}
header{padding:16px 0 22px}.brand{font-size:30px;font-weight:900}.tag{color:#68737d;margin-top:5px}
.card{background:white;border:1px solid #e2e7eb;border-radius:18px;padding:18px;margin:14px 0;box-shadow:0 5px 18px #00000008}
.drop{display:block;width:100%;border:2px dashed #bdc7cf;border-radius:16px;padding:28px;text-align:center;cursor:pointer;line-height:1.45;overflow-wrap:anywhere}
input[type=file]{display:none}button{border:0;border-radius:12px;padding:13px 16px;font-weight:800;cursor:pointer;background:#17202a;color:white}
button:disabled{opacity:.45;cursor:not-allowed}.preview{width:100%;max-height:360px;object-fit:contain;border-radius:12px;margin-top:14px}
.status{padding:12px;border-radius:12px;background:#f0f3f5;margin-top:14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.k{font-size:12px;color:#75808a}.v{font-size:16px;font-weight:750}.pill{display:inline-block;padding:6px 10px;border-radius:99px;background:#eef2f4;margin:3px 3px 0 0}
.score{font-size:52px;font-weight:950;line-height:1}.scoreline{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.verdict{font-size:22px;font-weight:900}.muted{color:#69747d}.warning{background:#fff5df;padding:10px;border-radius:10px;margin-top:8px}.good{background:#e9f7ef;padding:12px;border-radius:12px;margin-top:10px}.bad{background:#fff0ef;padding:12px;border-radius:12px;margin-top:10px}
.hidden{display:none}.small{font-size:12px;color:#7a858e}.comp{border-top:1px solid #edf0f2;padding:10px 0}.price{font-weight:900}.bar{height:10px;background:#e8edf0;border-radius:99px;overflow:hidden;margin-top:10px}.bar>div{height:100%;width:0;background:#17202a}
</style>
</head>
<body>
<div class="wrap">
<header><div class="brand">Vaut le Coup ? ✓</div><div class="tag">Avant d’acheter. Demande à l’IA.</div></header>
<section class="card">
<h2>Analyse une annonce</h2>
<p class="muted">V0.5 — lecture IA + comparaison marché.</p>
<label class="drop" for="file">📸<br><strong>Ajoute une capture ou une photo de l’annonce</strong><br><span class="small">JPG, PNG, WEBP — 12 Mo max</span></label>
<input id="file" type="file" accept="image/*">
<img id="preview" class="preview hidden">
<div id="status" class="status hidden"></div>
<button id="analyze" style="margin-top:14px;width:100%" disabled>Analyser l’annonce</button>
</section>
<section id="result" class="card hidden">
<h2>Lecture de l’annonce</h2><div id="confidence"></div><div id="fields" class="grid" style="margin-top:14px"></div><div id="claims" style="margin-top:14px"></div><div id="warnings"></div>
</section>
<section id="market" class="card hidden">
<h2>Est-ce que ça vaut le coup ?</h2><div id="marketText" class="muted">Recherche de véhicules comparables…</div><div id="scoreBox" class="hidden" style="margin-top:18px"><div class="scoreline"><div id="score" class="score">—</div><div id="verdict" class="verdict"></div></div><div id="gap" class="muted" style="margin-top:10px"></div><div class="bar"><div id="barFill"></div></div><h3>Quelques comparables</h3><div id="comparables"></div></div>
</section>
</div>
<script>
const fileEl=document.querySelector('#file'),preview=document.querySelector('#preview'),analyze=document.querySelector('#analyze');
const status=document.querySelector('#status'),result=document.querySelector('#result'),fields=document.querySelector('#fields'),confidence=document.querySelector('#confidence'),claims=document.querySelector('#claims'),warnings=document.querySelector('#warnings'),market=document.querySelector('#market'),marketText=document.querySelector('#marketText'),scoreBox=document.querySelector('#scoreBox'),score=document.querySelector('#score'),verdict=document.querySelector('#verdict'),gap=document.querySelector('#gap'),barFill=document.querySelector('#barFill'),comparables=document.querySelector('#comparables');
let file=null;
fileEl.onchange=()=>{file=fileEl.files?.[0];if(!file)return;preview.src=URL.createObjectURL(file);preview.classList.remove('hidden');analyze.disabled=false;result.classList.add('hidden');market.classList.add('hidden');scoreBox.classList.add('hidden');status.classList.remove('hidden');status.textContent='Capture prête.'};
analyze.onclick=async()=>{analyze.disabled=true;status.textContent='🧠 Lecture de l’image par l’IA…';try{const fd=new FormData();fd.append('image',file);const r=await fetch('/api/analyze',{method:'POST',body:fd});const j=await r.json();if(!r.ok)throw new Error(j.error||'Erreur');const v=j.vehicle;renderVehicle(v);status.textContent='✅ Lecture terminée.';market.classList.remove('hidden');marketText.textContent='🔎 Recherche de véhicules comparables…';const mr=await fetch('/api/market',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(v)});const mj=await mr.json();renderMarket(mj)}catch(e){status.textContent='❌ '+e.message}analyze.disabled=false};
function renderVehicle(v){result.classList.remove('hidden');confidence.innerHTML=\`<span class="pill">Confiance de lecture : \${v.confidence??0}/100</span>\`;const map=[['Marque',v.make],['Modèle',v.model],['Version',v.version],['Année',v.year],['Kilométrage',v.mileage_km?v.mileage_km.toLocaleString('fr-FR')+' km':null],['Prix',v.price_eur?v.price_eur.toLocaleString('fr-FR')+' €':null],['Énergie',v.energy],['Boîte',v.gearbox],['Puissance',v.power_hp?v.power_hp+' ch':null],['Vendeur',v.seller_type==='professional'?'Professionnel':v.seller_type==='private'?'Particulier':null],['Lieu',v.location]];fields.innerHTML=map.map(([k,x])=>\`<div><div class="k">\${k}</div><div class="v">\${x??'Non déterminé'}</div></div>\`).join('');claims.innerHTML=(v.visible_claims||[]).length?'<h3>Éléments visibles</h3>'+(v.visible_claims||[]).map(x=>\`<span class="pill">\${escapeHtml(x)}</span>\`).join(''):'';warnings.innerHTML=(v.uncertain_fields||[]).map(x=>\`<div class="warning">⚠️ À vérifier : \${escapeHtml(x)}</div>\`).join('')+(v.warnings||[]).map(x=>\`<div class="warning">⚠️ \${escapeHtml(x)}</div>\`).join('')}
function renderMarket(m){if(!m.ok){scoreBox.classList.add('hidden');marketText.innerHTML=\`<div class="warning">\${escapeHtml(m.error||'Comparaison marché indisponible.')}</div>\`;return}if(!m.market_median_eur){scoreBox.classList.add('hidden');marketText.textContent='Pas assez de données comparables pour conclure.';return}marketText.innerHTML=\`<strong>Marché observé : \${m.market_median_eur.toLocaleString('fr-FR')} €</strong><br>Fourchette indicative : \${m.low_eur.toLocaleString('fr-FR')}–\${m.high_eur.toLocaleString('fr-FR')} €<br><span class="small">\${m.comparables} comparables utilisés.</span>\`;scoreBox.classList.remove('hidden');score.textContent=m.deal_score??'—';const s=Number(m.deal_score);verdict.textContent=s>=75?'🔥 Très bonne affaire':s>=60?'👍 Intéressant':s>=45?'🟡 Prix correct':'🔴 Trop cher';gap.textContent=m.gap_pct==null?'':\`\${m.gap_pct>=0?'Sous':'Au-dessus de'} du marché de \${Math.abs(m.gap_pct).toFixed(1)} % (\${Math.abs(m.gap_eur).toLocaleString('fr-FR')} €)\`;barFill.style.width=Math.max(0,Math.min(100,s))+'%';comparables.innerHTML=(m.sample||[]).map(x=>\`<div class="comp"><span class="price">\${Number(x.price).toLocaleString('fr-FR')} €</span> · \${x.year??'?'} · \${x.mileage?Number(x.mileage).toLocaleString('fr-FR')+' km':'km ?'}<br><span class="small">\${escapeHtml(x.source||'Source inconnue')}</span></div>\`).join('')||'<div class="small">Aucun détail disponible.</div>'}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
</script>
</body>
</html>
`;

app.listen(process.env.PORT || 3000, () => {
  console.log(`Vaut le Coup ? V0.5 sur http://localhost:${process.env.PORT || 3000}`);
});
