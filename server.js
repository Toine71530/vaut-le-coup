import express from "express";
import multer from "multer";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 3, fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|jpg|png|webp)$/i.test(file.mimetype))
});

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const text = (v) => String(v ?? "").trim();
const upper = (v) => text(v).toUpperCase();
const number = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = text(v).replace(/\u00a0/g, " ").replace(/[^0-9,.-]/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const euro = (v) => v == null ? "Non déterminé" : Math.round(v).toLocaleString("fr-FR") + " €";
const km = (v) => v == null ? "Non déterminé" : Math.round(v).toLocaleString("fr-FR") + " km";
const price = (v) => number(v?.price_eur ?? v?.price);
const mileage = (v) => number(v?.mileage_km ?? v?.mileage);
const year = (v) => number(v?.year);

function cleanModel(v) {
  return upper(v?.model).replace(/\s+(?:I|II|III|IV|V|VI|VII|VIII|[0-9]+)$/i, "").trim();
}
function textBlob(v) {
  return [v?.make, v?.model, v?.version, v?.trim, v?.finition, v?.title, v?.description, v?.energy, v?.gearbox].map(upper).join(" ");
}
function energy(v) {
  const s = textBlob(v);
  if (/PHEV|PLUG.?IN|RECHARGEABLE/.test(s)) return "phev";
  if (/HYBRIDE|\bHEV\b/.test(s)) return "hybrid";
  if (/ELECTRIQUE|\bEV\b/.test(s)) return "electric";
  if (/DIESEL|BLUEHDI|TDI|DCI|HDI/.test(s)) return "diesel";
  if (/ESSENCE|PETROL|PURETECH|THP|VTI|TSI/.test(s)) return "petrol";
  return null;
}
function gearbox(v) {
  const s = textBlob(v);
  if (/AUTOMAT|E-CVT|CVT|DSG|EDC|DCT/.test(s)) return "automatic";
  if (/MANUEL|BVM|\bMT\b/.test(s)) return "manual";
  return null;
}
function power(v) {
  const n = number(v?.power_hp ?? v?.power ?? v?.horsepower);
  return n != null && n >= 40 && n <= 1000 ? n : null;
}
function normalizeVehicle(raw = {}) {
  const v = raw?.vehicle && typeof raw.vehicle === "object" ? raw.vehicle : raw;
  const c = number(v.confidence);
  const confidence = c == null ? 0 : Math.round(Math.max(0, Math.min(1, c <= 1 ? c : c / 100)) * 100);
  return {
    make: text(v.make) || null,
    model: text(v.model) || null,
    version: text(v.version) || null,
    year: year(v),
    mileage_km: mileage(v),
    price_eur: price(v),
    energy: text(v.energy) || energy(v),
    gearbox: text(v.gearbox) || gearbox(v),
    power_hp: power(v),
    seller_type: text(v.seller_type) || null,
    location: text(v.location) || null,
    confidence,
    uncertain_fields: Array.isArray(v.uncertain_fields) ? v.uncertain_fields.slice(0, 20) : [],
    visible_claims: Array.isArray(v.visible_claims) ? v.visible_claims.slice(0, 20) : [],
    warnings: Array.isArray(v.warnings) ? v.warnings.slice(0, 20) : []
  };
}

function compatible(target, candidate, relaxed = false) {
  const tm = cleanModel(target), cm = cleanModel(candidate);
  if (tm && cm && !tm.includes(cm) && !cm.includes(tm)) return false;
  const te = energy(target), ce = energy(candidate);
  if (!relaxed && te && ce && te !== ce) return false;
  const tg = gearbox(target), cg = gearbox(candidate);
  if (!relaxed && tg && cg && tg !== cg) return false;
  const tp = power(target), cp = power(candidate);
  if (!relaxed && tp != null && cp != null && Math.abs(tp - cp) > 30) return false;
  const ty = year(target), cy = year(candidate);
  if (ty != null && cy != null && Math.abs(ty - cy) > (relaxed ? 5 : 3)) return false;
  const tmile = mileage(target), cmile = mileage(candidate);
  if (!relaxed && tmile != null && cmile != null) {
    const allowance = Math.max(25000, tmile * 0.35);
    if (Math.abs(tmile - cmile) > allowance) return false;
  }
  return price(candidate) != null && price(candidate) > 500 && price(candidate) < 250000;
}
function similarityScore(target, candidate) {
  let s = 0;
  const tm = cleanModel(target), cm = cleanModel(candidate);
  if (tm && cm && (tm.includes(cm) || cm.includes(tm))) s += 100;
  const te = energy(target), ce = energy(candidate);
  if (te && ce && te === ce) s += 70;
  const tg = gearbox(target), cg = gearbox(candidate);
  if (tg && cg && tg === cg) s += 30;
  const tp = power(target), cp = power(candidate);
  if (tp != null && cp != null) s += Math.max(0, 35 - Math.abs(tp - cp));
  const ty = year(target), cy = year(candidate);
  if (ty != null && cy != null) s += Math.max(0, 30 - Math.abs(ty - cy) * 8);
  const tmile = mileage(target), cmile = mileage(candidate);
  if (tmile != null && cmile != null) s += Math.max(0, 45 - Math.min(45, Math.abs(tmile - cmile) / 2500));
  return s;
}
function median(values) {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return null;
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}
function quantile(values, q) {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
function robust(values) {
  if (values.length < 6) return values;
  const q1 = quantile(values, .25), q3 = quantile(values, .75), iqr = q3 - q1;
  const filtered = values.filter(v => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
  return filtered.length >= 4 ? filtered : values;
}

async function carhuntSearch(target) {
  const key = process.env.CARHUNT_API_KEY;
  if (!key) return { listings: [], error: "La recherche de marché n'est pas configurée." };
  const qs = new URLSearchParams({ make: upper(target.make), model: cleanModel(target), page_size: "50" });
  try {
    const response = await fetch("https://api-pro.carhunt.fr/v1/listings/search?" + qs.toString(), {
      headers: { Authorization: "Bearer " + key, Accept: "application/json" }
    });
    const raw = await response.text();
    if (!response.ok) return { listings: [], error: "Source de marché indisponible (" + response.status + ")." };
    let data;
    try { data = JSON.parse(raw); } catch { return { listings: [], error: "Réponse de marché invalide." }; }
    const listings = Array.isArray(data) ? data : (data.listings || data.items || data.results || []);
    return { listings: Array.isArray(listings) ? listings : [] };
  } catch {
    return { listings: [], error: "Source de marché temporairement indisponible." };
  }
}
async function buildMarket(input) {
  const target = normalizeVehicle(input);
  const asking = price(target);
  if (!target.make || !cleanModel(target)) return { ok: false, error: "Impossible de déterminer la marque et le modèle à partir des photos." };
  const result = await carhuntSearch(target);
  if (result.error) return { ok: false, error: result.error };
  const seen = new Set(), strict = [], relaxed = [];
  for (const item of result.listings) {
    const id = item.id || [item.make, item.model, item.year, item.mileage, item.price, item.source_url].join("|");
    if (seen.has(id)) continue;
    seen.add(id);
    if (asking != null && price(item) === asking && year(item) === year(target) && mileage(item) === mileage(target)) continue;
    if (compatible(target, item, false)) strict.push(item);
    else if (compatible(target, item, true)) relaxed.push(item);
  }
  let expanded = false;
  let candidates = strict;
  if (candidates.length < 3) { expanded = true; candidates = relaxed; }
  candidates.sort((a, b) => similarityScore(target, b) - similarityScore(target, a));
  const top = candidates.slice(0, 20);
  const rawPrices = top.map(price).filter(Number.isFinite);
  const values = robust(rawPrices);
  const comparables = top.slice(0, 10).map(x => ({
    price_eur: price(x), price_display: euro(price(x)), year: year(x), mileage_km: mileage(x), mileage_display: km(mileage(x)),
    energy: x.energy || energy(x), version: x.version || x.finition || x.trim || null,
    source: x.source || null, source_url: x.source_url || x.url || x.link || null
  }));
  if (values.length < 3) return {
    ok: true, status: "insufficient", label: "Données de marché insuffisantes", expanded,
    asking_display: euro(asking), price_eur: asking, median: null, median_display: "Non déterminé",
    low_display: "Non déterminé", high_display: "Non déterminé", confidence: Math.min(35, 15 + values.length * 7),
    gap_text: values.length + " comparable(s) exploitable(s). Pas d'estimation artificielle.",
    warning: "L'échantillon est trop faible pour produire une estimation fiable.", comparables_count: values.length, comparables
  };
  const med = median(values), low = quantile(values, .15), high = quantile(values, .85);
  const gap = asking != null && med ? Math.round((asking / med - 1) * 100) : null;
  const label = gap == null ? "Marché comparable" : gap <= -10 ? "Très intéressant" : gap <= -3 ? "Plutôt intéressant" : gap <= 3 ? "Dans le marché" : gap <= 10 ? "Plutôt cher" : "Cher";
  return {
    ok: true, status: "ok", label, expanded, asking_display: euro(asking), price_eur: asking,
    median: med, median_display: euro(med), low, low_display: euro(low), high, high_display: euro(high),
    confidence: Math.min(95, 45 + Math.min(10, values.length) * 5 - (expanded ? 15 : 0)),
    gap_text: gap == null ? "Écart au marché non déterminé." : "Le prix demandé est " + Math.abs(gap) + " % " + (gap >= 0 ? "au-dessus" : "en dessous") + " du prix médian.",
    warning: expanded ? "Moins de 3 comparables très proches : l'échantillon a été élargi. Interpréter la fourchette avec prudence." : values.length < 5 ? "Échantillon limité : interpréter la fourchette avec prudence." : values.length !== rawPrices.length ? "Quelques valeurs extrêmes ont été écartées du calcul." : null,
    comparables_count: values.length, comparables
  };
}

const GEMINI_MODELS = [process.env.GEMINI_MODEL || "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function analyzePhotos(files) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Le moteur d'analyse IA n'est pas configuré sur le serveur.");
  const prompt = `Tu es le moteur de lecture de Vaut le Coup ?. Analyse une à trois captures d'écran d'une annonce automobile. Utilise UNIQUEMENT les informations réellement visibles. N'invente rien et ne complète jamais une donnée absente par connaissance générale. Si une donnée est absente, illisible ou ambiguë, mets null. Ne déduis jamais la finition, la puissance, l'énergie ou la boîte uniquement à partir du modèle. Les affirmations du vendeur ne sont pas vérifiées. Signale les contradictions visibles. confidence mesure uniquement la qualité de lecture des informations visibles, pas la qualité du véhicule et pas sa valeur de marché. Retourne UNIQUEMENT un objet JSON avec exactement ces champs: make, model, version, year, mileage_km, price_eur, energy, gearbox, power_hp, seller_type, location, confidence, uncertain_fields, visible_claims, warnings.`;
  const parts = [{ text: prompt }, ...files.map(file => ({ inline_data: { mime_type: file.mimetype, data: file.buffer.toString("base64") } }))];
  let lastStatus = 0;
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json" } })
      });
      lastStatus = response.status;
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim() || "";
        const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
        if (start >= 0 && end > start) {
          try { return normalizeVehicle(JSON.parse(raw.slice(start, end + 1))); } catch {}
        }
      }
    } catch {}
    if (i < GEMINI_MODELS.length - 1) await sleep(500);
  }
  throw new Error(lastStatus === 429 ? "Le moteur IA est momentanément très sollicité. Réessaie dans quelques instants." : "L'analyse IA est temporairement indisponible. Réessaie dans quelques instants.");
}

const HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#17212b"><title>Vaut le Coup ?</title><style>
*{box-sizing:border-box}body{margin:0;background:#eef2f5;color:#17212b;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.app{max-width:720px;margin:auto;padding:18px 14px 70px}.hero{padding:5px 6px 18px}.logo{font-size:31px;font-weight:900}.logo span{color:#16a34a}.tag{color:#64717c;margin-top:3px}.card{background:#fff;border:1px solid #dce3e9;border-radius:24px;padding:22px;margin:14px 0;box-shadow:0 5px 22px #0000000b}h1{font-size:30px;line-height:1.08;margin:0 0 10px}h2{font-size:24px;margin:0 0 17px}.drop{display:block;border:3px dashed #c7d0d8;border-radius:21px;padding:31px 15px;text-align:center;cursor:pointer;user-select:none}.drop:active{transform:scale(.995)}.camera{font-size:34px}.drop strong{display:block;font-size:23px;margin-top:5px}.small{display:block;color:#7b8792;margin-top:11px;font-size:17px}.previews{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:13px}.thumb{position:relative;min-width:0;aspect-ratio:1}.thumb img{width:100%;height:100%;object-fit:cover;border-radius:16px;border:1px solid #d9dee3}.remove{position:absolute;right:-4px;top:-4px;width:36px;height:36px;border:0;border-radius:50%;background:#17212b;color:#fff;font-size:23px;line-height:1;cursor:pointer}.btn{width:100%;border:0;border-radius:17px;padding:18px;background:#17212b;color:#fff;font-size:19px;font-weight:850;margin-top:18px;cursor:pointer}.btn:disabled{opacity:.45}.hidden{display:none!important}.error{margin-top:17px;padding:16px 18px;border-radius:17px;background:#fee2e2;color:#a33b3b;font-weight:650}.progress{position:fixed;z-index:9999;top:10px;left:50%;transform:translateX(-50%);width:min(680px,calc(100% - 20px));background:#fff;border:1px solid #dbe3ea;border-radius:21px;padding:14px 16px;box-shadow:0 10px 32px #0002}.progressTop{display:flex;justify-content:space-between;gap:12px;font-weight:850}.track{height:12px;background:#e5eaf0;border-radius:20px;overflow:hidden;margin-top:9px}.fill{height:100%;width:5%;background:#2563eb;border-radius:20px;transition:width .35s ease}.progressText{margin-top:7px;color:#596671}.infoRow{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #e8ecef;font-size:17px}.infoRow:last-child{border-bottom:0}.label{font-weight:800}.confidence{margin-top:18px;padding:17px;border-radius:18px;background:#eef7ff}.market{position:relative}.verdict{display:inline-block;padding:10px 18px;border-radius:999px;font-weight:900;margin-bottom:12px}.v-green{background:#dcfce7;color:#166534}.v-blue{background:#dbeafe;color:#1d4ed8}.v-orange{background:#ffedd5;color:#9a3412}.v-red{background:#fee2e2;color:#991b1b}.priceBig{font-size:40px;font-weight:950;margin:4px 0 8px}.marketBar{height:14px;background:#e5e7eb;border-radius:20px;overflow:hidden;margin:15px 0}.marketBarFill{height:100%;border-radius:20px}.metric{font-size:18px;margin:10px 0}.warning{margin-top:15px;padding:13px 15px;background:#fff7ed;border-radius:15px}.negotiation{border-left:5px solid #16a34a;background:#f0fdf4}.negotiation h3{margin:0 0 10px;font-size:21px}.negotiation ul{margin:9px 0 0;padding-left:22px}.negotiation li{margin:8px 0}.comp{padding:13px 0;border-bottom:1px solid #e5e7eb}.comp:last-child{border-bottom:0}.comp b{font-size:18px}.muted{color:#66737d}.note{font-size:14px;color:#68757f;margin-top:12px}.retry{margin-top:10px;background:#fff;border:1px solid #ccd5dc;color:#17212b;padding:10px 14px;border-radius:12px;font-weight:750}
@media(max-width:420px){.app{padding-left:10px;padding-right:10px}.card{padding:18px}.drop{padding:27px 10px}.priceBig{font-size:36px}}
</style></head><body><main class="app"><header class="hero"><div class="logo">Vaut le <span>Coup ?</span></div><div class="tag">Analyse une annonce automobile avant d'acheter.</div></header>
<section class="card"><h1>Analyse une annonce</h1><p>Ajoute jusqu'à 3 photos de l'annonce ou du véhicule.</p><input id="photos" class="hidden" type="file" accept="image/jpeg,image/png,image/webp" multiple><label for="photos" class="drop"><div class="camera">📸</div><strong>Ajoute une capture ou une photo</strong><span class="small">JPG, PNG, WEBP — 12 Mo max par photo — 3 photos maximum.<br>Tu peux les ajouter une par une.</span></label><div id="previews" class="previews"></div><div id="error" class="error hidden"></div><button id="analyze" class="btn" type="button" disabled>Analyser l'annonce</button></section>
<section id="analysis" class="card hidden"><h2>Ce que l'IA a lu</h2><div id="facts"></div></section>
<section id="market" class="card market hidden"><h2>Est-ce que ça vaut le coup ?</h2><div id="marketResult"></div></section>
</main><div id="progress" class="progress hidden"><div class="progressTop"><span id="progressTitle">🔎 Préparation...</span><span id="progressPct">5 %</span></div><div class="track"><div id="progressFill" class="fill"></div></div><div id="progressText" class="progressText">Lecture des photos...</div></div>
<script>
(() => {
  const input = document.getElementById('photos'), previews = document.getElementById('previews'), analyze = document.getElementById('analyze'), error = document.getElementById('error');
  const progress = document.getElementById('progress'), pTitle = document.getElementById('progressTitle'), pPct = document.getElementById('progressPct'), pFill = document.getElementById('progressFill'), pText = document.getElementById('progressText');
  const analysis = document.getElementById('analysis'), facts = document.getElementById('facts'), market = document.getElementById('market'), marketResult = document.getElementById('marketResult');
  let files = [], busy = false, timer = null;
  const showError = msg => { error.textContent = '❌ ' + msg; error.classList.remove('hidden'); };
  const clearError = () => { error.textContent = ''; error.classList.add('hidden'); };
  const setProgress = (pct, title, detail) => { progress.classList.remove('hidden'); pPct.textContent = pct + ' %'; pFill.style.width = pct + '%'; pTitle.textContent = title; pText.textContent = detail; };
  const finishProgress = () => { setProgress(100, '✅ Analyse terminée', 'Résultat prêt.'); setTimeout(() => progress.classList.add('hidden'), 900); };
  const startProgress = () => { clearInterval(timer); let p=5; setProgress(p,'🔎 Analyse des photos...','Lecture des informations visibles...'); timer=setInterval(()=>{ if(p<52){p+=2;setProgress(p,'🔎 Analyse des photos...','Lecture des informations visibles...');} },700); };
  const stopTimer = () => { clearInterval(timer); timer=null; };
  function renderPreviews(){ previews.innerHTML=''; files.forEach((file,i)=>{ const wrap=document.createElement('div'); wrap.className='thumb'; const img=document.createElement('img'); img.alt='Photo '+(i+1); img.src=URL.createObjectURL(file); const btn=document.createElement('button'); btn.type='button'; btn.className='remove'; btn.textContent='×'; btn.setAttribute('aria-label','Supprimer la photo'); btn.onclick=()=>{files.splice(i,1);renderPreviews();}; wrap.append(img,btn); previews.appendChild(wrap); }); analyze.disabled=files.length===0||busy; }
  input.addEventListener('change',()=>{ clearError(); const selected=[...input.files]; const invalid=selected.find(f=>!/^image\/(jpeg|jpg|png|webp)$/i.test(f.type)); const tooBig=selected.find(f=>f.size>12*1024*1024); if(invalid){showError('Format non pris en charge. Utilise JPG, PNG ou WEBP.');input.value='';return;} if(tooBig){showError('Une photo dépasse la limite de 12 Mo.');input.value='';return;} const remaining=3-files.length; if(remaining<=0){showError('3 photos maximum.');input.value='';return;} files=files.concat(selected.slice(0,remaining)); if(selected.length>remaining)showError('3 photos maximum.'); renderPreviews(); input.value=''; });
  document.querySelector('.drop').addEventListener('click',e=>{ if(e.target.closest('button'))return; if(files.length>=3){showError('3 photos maximum. Supprime une photo pour en ajouter une autre.');return;} input.click(); });
  async function post(url, form){ const r=await fetch(url,{method:'POST',body:form,cache:'no-store'}); const raw=await r.text(); let data={}; try{data=raw?JSON.parse(raw):{};}catch{throw new Error('Réponse serveur invalide ('+r.status+').');} if(!r.ok||data.ok===false)throw new Error(data.error||('Erreur serveur ('+r.status+').')); return data; }
  function value(v){return v==null||v===''?'Non indiqué':v;}
  function renderAnalysis(v){ const rows=[['Marque',value(v.make)],['Modèle',value(v.model)],['Version',value(v.version)],['Année',value(v.year)],['Kilométrage',v.mileage_km!=null?v.mileage_km.toLocaleString('fr-FR')+' km':'Non indiqué'],['Prix',v.price_eur!=null?v.price_eur.toLocaleString('fr-FR')+' €':'Non indiqué'],['Énergie',value(v.energy)],['Boîte',value(v.gearbox)],['Puissance',v.power_hp!=null?v.power_hp+' ch':'Non indiqué'],['Lieu',value(v.location)]]; facts.innerHTML=rows.map(r=>'<div class="infoRow"><span class="label">'+r[0]+'</span><span>'+r[1]+'</span></div>').join('')+'<div class="confidence">🔎 <b>Fiabilité des informations extraites : '+(Number(v.confidence)||0)+'/100</b><br><span class="muted">Qualité de lecture des informations visibles. Ce score ne juge pas le véhicule.</span></div>'+(v.warnings?.length?'<div class="warning">⚠️ <b>Points à vérifier</b><ul>'+v.warnings.map(x=>'<li>'+x+'</li>').join('')+'</ul></div>':''); analysis.classList.remove('hidden'); }
  function renderNegotiation(data, vehicle){ const med=data.median; const asking=data.price_eur; let target=null; if(med&&asking){ if(asking>med*1.08)target=Math.round(med*1.04/100)*100; else if(asking>med*1.03)target=Math.round(med/100)*100; else target=Math.round(asking/100)*100; } const points=[]; if(data.warning)points.push('Demande au vendeur pourquoi le prix s’écarte du marché et quels éléments justifient cet écart.'); points.push('Demande les factures d’entretien et les justificatifs des opérations importantes annoncées.'); points.push('Vérifie le contrôle technique, les pneus, les freins, la carrosserie et l’absence de voyants au tableau de bord.'); if(vehicle?.uncertain_fields?.length)points.push('Fais confirmer les informations que l’annonce ne permet pas de lire avec certitude.'); if(vehicle?.warnings?.length)points.push('Utilise les points à vérifier relevés par l’analyse comme leviers de négociation, sans considérer les affirmations du vendeur comme vérifiées.'); if(data.comparables_count>=3)points.push('Appuie-toi sur les annonces comparables réellement proches plutôt que sur une cote générale.'); const priceLine=target?'Une zone de discussion cohérente se situe autour de '+target.toLocaleString('fr-FR')+' € si l’état et les justificatifs ne compensent pas l’écart.':'Le marché est trop incertain pour fixer un prix cible sérieux : négocie surtout sur les éléments à vérifier.'; return '<section class="card negotiation"><h3>💬 Axes d’amélioration / négociation</h3><p><b>'+priceLine+'</b></p><ul>'+points.map(x=>'<li>'+x+'</li>').join('')+'</ul><div class="note">Le prix cible est une aide à la négociation, pas une promesse de valeur ni une expertise.</div></section>'; }
  function renderMarket(data, vehicle){ marketResult.innerHTML=''; if(!data.ok)throw new Error(data.error||'Analyse marché impossible.'); let cls='v-blue'; if(data.label.includes('intéressant'))cls='v-green'; else if(data.label.includes('cher'))cls='v-red'; else if(data.label.includes('insuffisantes'))cls='v-orange'; let html='<div class="verdict '+cls+'">'+data.label+'</div><div class="priceBig">'+data.asking_display+'</div><div class="metric">'+data.gap_text+'</div><div class="metric"><b>Médiane comparable :</b> '+data.median_display+'</div><div class="metric"><b>Fourchette indicative :</b> '+data.low_display+' — '+data.high_display+'</div>'; if(data.median){ const ratio=Math.max(5,Math.min(100,(data.price_eur/data.median)*50)); html+='<div class="marketBar"><div class="marketBarFill" style="width:'+ratio+'%;background:'+((data.label==='Cher'||data.label==='Plutôt cher')?'#f59e0b':'#2563eb')+'"></div></div>'; } if(data.warning)html+='<div class="warning">⚠️ '+data.warning+'</div>'; html+='<p><b>Confiance marché :</b> '+data.confidence+'/100 · '+data.comparables_count+' comparable(s)</p><h3>🔎 Comparables</h3>'; html+=data.comparables?.length?data.comparables.map(c=>'<div class="comp"><b>'+c.price_display+'</b> · '+value(c.year)+' · '+(c.mileage_display||'km non indiqué')+' · '+value(c.version||c.energy)+' · '+value(c.source)+'</div>').join(''):'<div class="muted">Aucun comparable exploitable.</div>'; marketResult.innerHTML=html+renderNegotiation(data,vehicle); market.classList.remove('hidden'); }
  analyze.addEventListener('click',async()=>{ if(busy||!files.length)return; busy=true; clearError(); analyze.disabled=true; analysis.classList.add('hidden'); market.classList.add('hidden'); startProgress(); try{ const form=new FormData(); files.forEach(f=>form.append('photos',f,f.name)); setProgress(18,'🔎 Analyse des photos...','Lecture de vos captures par l’IA...'); const vehicle=await post('/api/analyze',form); renderAnalysis(vehicle); setProgress(55,'🔍 Recherche du marché...','Recherche de véhicules réellement comparables...'); const marketData=await fetch('/api/market',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vehicle}),cache:'no-store'}).then(async r=>{const raw=await r.text();let d={};try{d=raw?JSON.parse(raw):{};}catch{throw new Error('Réponse marché invalide.');}if(!r.ok||d.ok===false)throw new Error(d.error||'Recherche marché impossible.');return d;}); setProgress(90,'🧠 Finalisation...','Calcul du verdict et des leviers de négociation...'); renderMarket(marketData,vehicle); finishProgress(); market.scrollIntoView({behavior:'smooth',block:'start'}); }catch(e){ stopTimer(); progress.classList.add('hidden'); showError(e.message||'Une erreur est survenue.'); }finally{ stopTimer(); busy=false; analyze.disabled=files.length===0; }});
})();
</script></body></html>`;

app.get("/", (_req, res) => { res.set("Cache-Control", "no-store, max-age=0"); res.type("html").send(HTML); });
app.get("/health", (_req, res) => res.json({ ok: true, service: "vaut-le-coup" }));
app.post("/api/analyze", upload.array("photos", 3), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ ok: false, error: "Ajoute au moins une photo." });
    const vehicle = await analyzePhotos(req.files);
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, ...vehicle });
  } catch (error) { res.status(503).json({ ok: false, error: error?.message || "Analyse IA indisponible." }); }
});
app.post("/api/market", async (req, res) => {
  try { const data = await buildMarket(req.body?.vehicle || req.body || {}); res.set("Cache-Control", "no-store"); res.status(data.ok === false ? 400 : 200).json(data); }
  catch { res.status(503).json({ ok: false, error: "Recherche du marché temporairement indisponible." }); }
});
app.use((err, _req, res, _next) => { if (err instanceof multer.MulterError) return res.status(400).json({ ok: false, error: err.code === "LIMIT_FILE_SIZE" ? "Une photo dépasse 12 Mo." : "Maximum 3 photos." }); res.status(500).json({ ok: false, error: "Erreur serveur." }); });
app.listen(PORT, "0.0.0.0", () => console.log(`Vaut le Coup serveur unique listening on ${PORT}`));
