import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 3, fileSize: 12 * 1024 * 1024 } });
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanJson = text => {
  const s = String(text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("Réponse IA JSON invalide.");
  return JSON.parse(s.slice(a, b + 1));
};

async function callGemini(model, files, attempt) {
  const prompt = `Tu es le moteur de lecture de l'application française "Vaut le Coup ?". Analyse les photos/captures d'une même annonce automobile et recoupe les informations entre elles. N'invente jamais une donnée. Si une donnée est absente, illisible ou contradictoire, mets null et ajoute le champ dans uncertain_fields. Le prix doit être celui de l'annonce. Retourne UNIQUEMENT un objet JSON valide avec exactement ces clés : {"make":string|null,"model":string|null,"version":string|null,"year":number|null,"mileage_km":number|null,"price_eur":number|null,"energy":string|null,"gearbox":string|null,"power_hp":number|null,"seller_type":"professional"|"private"|null,"location":string|null,"title":string|null,"confidence":number,"uncertain_fields":string[],"visible_claims":string[],"warnings":string[]}. confidence est un entier de 0 à 100. Ne déduis pas une finition, puissance, énergie ou type de vendeur si ce n'est pas lisible.`;
  const parts = [{ text: prompt }];
  for (const file of files) parts.push({ inline_data: { mime_type: file.mimetype || "image/jpeg", data: file.buffer.toString("base64") } });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.1 } }) });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 800);
    const e = new Error(`Gemini HTTP ${r.status}: ${body}`); e.status = r.status; throw e;
  }
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  if (!text) throw new Error("Gemini n'a retourné aucun résultat.");
  return cleanJson(text);
}

async function analyzeWithGemini(files) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY manquante. Le moteur Gemini n'est pas configuré.");
  const models = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL].filter((m, i, a) => m && a.indexOf(m) === i);
  let last = null;
  for (const model of models) {
    const tries = model === GEMINI_MODEL ? 3 : 2;
    for (let i = 0; i < tries; i++) {
      try {
        console.log(`Gemini analyse: modèle=${model}, tentative=${i + 1}/${tries}`);
        return await callGemini(model, files, i + 1);
      } catch (e) {
        last = e;
        if (![429, 500, 502, 503, 504].includes(e.status)) break;
        if (i < tries - 1) await sleep(1500 * Math.pow(2, i));
      }
    }
    if (model !== models[models.length - 1]) console.log(`Gemini indisponible sur ${model}, bascule vers ${models[models.indexOf(model) + 1]}`);
  }
  throw last || new Error("Gemini indisponible.");
}

const euro = n => n == null ? "Non déterminé" : Math.round(n).toLocaleString("fr-FR") + " €";
const km = n => n == null ? "Non déterminé" : Math.round(n).toLocaleString("fr-FR") + " km";

app.get("/api/health", (_req, res) => res.json({ ok: true, vision: Boolean(GEMINI_API_KEY), vision_provider: "gemini", model: GEMINI_MODEL, fallback_model: GEMINI_FALLBACK_MODEL, market: Boolean(process.env.CARHUNT_API_KEY) }));

app.post("/api/analyze", upload.array("photos", 3), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "Aucune image reçue." });
    const vehicle = await analyzeWithGemini(files);
    res.json({ ok: true, vehicle });
  } catch (e) {
    console.error(e);
    const msg = e.status === 503 ? "Gemini est momentanément très sollicité. Les tentatives automatiques ont échoué, réessaie dans quelques instants." : e.message || "Erreur pendant l'analyse.";
    res.status(500).json({ error: msg });
  }
});

app.post("/api/market", async (req, res) => {
  try {
    const key = process.env.CARHUNT_API_KEY;
    if (!key) return res.status(503).json({ error: "CARHUNT_API_KEY manquante." });
    const v = req.body || {};
    if (!v.make || !v.model) return res.status(400).json({ error: "Marque/modèle nécessaires." });
    const params = new URLSearchParams({ make: String(v.make).toUpperCase(), model: String(v.model).toUpperCase(), page_size: "100" });
    if (v.year) { params.set("year_min", String(Number(v.year) - 1)); params.set("year_max", String(Number(v.year) + 1)); }
    if (v.mileage_km) { params.set("mileage_min", String(Math.max(0, Number(v.mileage_km) - 30000))); params.set("mileage_max", String(Number(v.mileage_km) + 30000)); }
    if (v.energy) params.set("energy", String(v.energy));
    if (v.gearbox) params.set("gearbox", String(v.gearbox));
    const r = await fetch(`https://api-pro.carhunt.fr/v1/listings/search?${params}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`CarHunt HTTP ${r.status}`);
    const data = await r.json();
    const listings = (data.listings || []).filter(x => Number.isFinite(Number(x.price)) && Number(x.price) > 0);
    const prices = listings.map(x => Number(x.price)).sort((a,b)=>a-b);
    if (!prices.length) return res.json({ ok:true, comparables:0, market_median_eur:null, low_eur:null, high_eur:null, deal_score:null });
    const median = prices[Math.floor(prices.length / 2)];
    const q = p => prices[Math.max(0, Math.min(prices.length - 1, Math.floor((prices.length - 1) * p)))];
    const asking = Number(v.price_eur);
    const gapPct = asking > 0 ? ((median - asking) / median) * 100 : null;
    const dealScore = gapPct == null ? null : Math.max(0, Math.min(100, Math.round(50 + gapPct * 2.5)));
    res.json({ ok:true, comparables:prices.length, market_median_eur:Math.round(median), low_eur:Math.round(q(.15)), high_eur:Math.round(q(.85)), asking_price_eur:Number.isFinite(asking)?asking:null, gap_eur:Number.isFinite(asking)?Math.round(median-asking):null, gap_pct:gapPct==null?null:Math.round(gapPct*10)/10, deal_score:dealScore, sample:listings.slice(0,8).map(x=>({price:x.price,year:x.year,mileage:x.mileage,energy:x.energy,gearbox:x.gearbox,horsepower:x.horsepower,seller_type:x.seller_type,source:x.source,source_url:x.source_url})) });
  } catch(e) { console.error(e); res.status(500).json({ error:e.message || "Erreur marché." }); }
});

const HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vaut le Coup ?</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#18212b;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:720px;margin:auto;padding:28px 16px 60px}h1{font-size:42px;line-height:1;margin:0 0 8px}h2{font-size:30px;margin:0 0 22px}.sub{color:#66717d;font-size:21px;margin-bottom:34px}.card{background:#fff;border:1px solid #dfe3e7;border-radius:28px;padding:28px;margin:18px 0;box-shadow:0 2px 10px #00000008}.drop{display:block;border:3px dashed #c7cdd3;border-radius:24px;padding:35px 18px;text-align:center;cursor:pointer;font-size:20px}.drop strong{font-size:24px}.small{display:block;color:#7a838d;margin-top:14px}#file{display:none}.previews{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}.thumb{position:relative;width:112px;height:112px}.thumb img{width:100%;height:100%;object-fit:cover;border-radius:18px;border:1px solid #ddd}.remove{position:absolute;right:-5px;top:-5px;width:34px;height:34px;border:0;border-radius:50%;background:#17212b;color:#fff;font-size:20px}.btn{width:100%;border:0;border-radius:18px;padding:18px;background:#17212b;color:#fff;font-size:20px;font-weight:800;cursor:pointer;margin-top:18px}.btn:disabled{opacity:.5}.status,.result{background:#f7f8fa;border-radius:22px;padding:22px;margin-top:18px}.warn{background:#fff1d6;border-radius:18px;padding:18px;margin:12px 0}.error{background:#ffe1e1;color:#a32626;border-radius:18px;padding:18px;margin-top:18px}.price{font-size:46px;font-weight:900}.muted{color:#68727d}.score{font-size:25px;font-weight:800}.comp{padding:16px 0;border-bottom:1px solid #ddd}.tag{display:inline-block;background:#e9edf1;border-radius:99px;padding:5px 10px;margin:3px 4px 3px 0}</style></head><body><main><h1>Vaut le Coup ? ✓</h1><div class="sub">Avant d’acheter. Demande à l’IA.</div><section class="card"><h2>Analyse une annonce</h2><p>Ajoute jusqu’à 3 photos de l’annonce ou du véhicule.</p><label class="drop" for="file">📸<br><strong>Ajoute une capture ou une photo</strong><span class="small">JPG, PNG, WEBP — 12 Mo max par photo — 3 photos maximum</span></label><input id="file" type="file" accept="image/jpeg,image/png,image/webp" multiple><div id="previews" class="previews"></div><div id="error"></div><button id="go" class="btn" disabled>Analyser l’annonce</button></section><section id="analysis" class="card" hidden></section><section id="market" class="card" hidden></section></main><script>
const fileInput=document.getElementById('file'),previews=document.getElementById('previews'),go=document.getElementById('go'),errorBox=document.getElementById('error'),analysis=document.getElementById('analysis'),market=document.getElementById('market');let files=[];const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));function renderFiles(){previews.innerHTML='';files.forEach((f,i)=>{const w=document.createElement('div');w.className='thumb';const im=document.createElement('img');im.src=URL.createObjectURL(f);const b=document.createElement('button');b.type='button';b.className='remove';b.textContent='×';b.onclick=()=>{files.splice(i,1);renderFiles()};w.append(im,b);previews.appendChild(w)});go.disabled=!files.length}fileInput.onchange=()=>{files=[...files,...Array.from(fileInput.files||[])].slice(0,3);fileInput.value='';renderFiles()};function showError(m){errorBox.innerHTML='<div class="error">❌ '+esc(m)+'</div>'}function showAnalysis(v){analysis.hidden=false;const rows=[['Marque',v.make],['Modèle',v.model],['Version',v.version],['Année',v.year],['Kilométrage',v.mileage_km!=null?Number(v.mileage_km).toLocaleString('fr-FR')+' km':null],['Prix',v.price_eur!=null?Number(v.price_eur).toLocaleString('fr-FR')+' €':null],['Énergie',v.energy],['Boîte',v.gearbox],['Puissance',v.power_hp!=null?v.power_hp+' ch':null],['Vendeur',v.seller_type==='professional'?'Professionnel':v.seller_type==='private'?'Particulier':null],['Lieu',v.location]];analysis.innerHTML='<h2>Ce que l’IA a lu</h2>'+rows.filter(x=>x[1]!=null&&x[1]!=='').map(x=>'<div><b>'+esc(x[0])+'</b> : '+esc(x[1])+'</div>').join('')+'<p class="score">Confiance de lecture : '+esc(v.confidence??0)+'/100</p>'+(v.uncertain_fields?.length?'<div class="warn">⚠️ À vérifier : '+v.uncertain_fields.map(esc).join(', ')+'</div>':'')+(v.visible_claims?.length?'<p><b>Éléments visibles :</b><br>'+v.visible_claims.map(x=>'<span class="tag">'+esc(x)+'</span>').join('')+'</p>':'')+(v.warnings||[]).map(x=>'<div class="warn">⚠️ '+esc(x)+'</div>').join('')}function showMarket(m){market.hidden=false;if(m.error){market.innerHTML='<h2>Est-ce que ça vaut le coup ?</h2><div class="warn">⚠️ '+esc(m.error)+'</div>';return}market.innerHTML='<h2>Est-ce que ça vaut le coup ?</h2><div class="status"><b>'+esc(m.label||'Marché comparable')+'</b><p>Confiance marché : <b>'+esc(m.confidence??'—')+'/100</b></p><div class="muted">Prix demandé</div><div class="price">'+esc(m.asking_display||((m.asking_price_eur??'—')+' €'))+'</div><p>Marché estimé : <b>'+esc(m.median_display||((m.market_median_eur??'—')+' €'))+'</b><br>Fourchette indicative : '+esc(m.low_display||((m.low_eur??'—')+' €'))+' – '+esc(m.high_display||((m.high_eur??'—')+' €'))+'</p><p>'+esc(m.gap_text||'')+'</p>'+(m.warning?'<div class="warn">⚠️ '+esc(m.warning)+'</div>':'')+'</div><h3>Comparables utilisés</h3>'+((m.comparables||m.sample||[]).map(x=>'<div class="comp"><b>'+esc(x.price_display||x.price||'—')+' €</b> · '+esc(x.year??'?')+' · '+esc(x.mileage_display||x.mileage||'km ?')+'</div>').join('')||'<div class="muted">Aucun détail disponible.</div>')}go.onclick=async()=>{go.disabled=true;errorBox.innerHTML='';analysis.hidden=true;market.hidden=true;try{const fd=new FormData();files.forEach(f=>fd.append('photos',f));const r=await fetch('/api/analyze',{method:'POST',body:fd});const j=await r.json();if(!r.ok)throw new Error(j.error||'Erreur');showAnalysis(j.vehicle);const mr=await fetch('/api/market',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(j.vehicle)});showMarket(await mr.json())}catch(e){showError(e.message)}go.disabled=false};
</script></main></body></html>`;

app.get("/", (_req,res) => res.type("html").send(HTML));
const PORT=process.env.PORT||10000;
app.listen(PORT,'0.0.0.0',()=>console.log(`Vaut le Coup ? sur le port ${PORT} — Gemini ${GEMINI_MODEL} / secours ${GEMINI_FALLBACK_MODEL}`));
