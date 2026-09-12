import express from "express";
import multer from "multer";

const app = express();
const PORT = Number(process.env.PORT || 10000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 3, fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|jpg)$/i.test(file.mimetype))
});

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

const esc = (v) => String(v ?? "").replace(/[&<>\"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
}[c]));
const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v ?? "").replace(/\u00a0/g, " ").replace(/[^0-9,.-]/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const price = (v) => num(v?.price_eur ?? v?.price);
const mileage = (v) => num(v?.mileage_km ?? v?.mileage);
const year = (v) => num(v?.year);
const power = (v) => {
  const n = num(v?.power_hp ?? v?.power ?? v?.horsepower);
  if (n != null && n >= 40 && n <= 1000) return n;
  const m = allText(v).match(/(?:^|\D)(\d{2,3})\s*(?:CH|HP)(?:\D|$)/i);
  return m ? Number(m[1]) : null;
};
const up = (v) => String(v ?? "").toUpperCase().trim();
const model = (v) => up(v?.model).replace(/\s+(?:I|II|III|IV|V|[0-9]+)$/i, "").trim();
const euro = (v) => v == null ? "Non déterminé" : Math.round(v).toLocaleString("fr-FR") + " €";
const km = (v) => v == null ? "Non déterminé" : Math.round(v).toLocaleString("fr-FR") + " km";
const allText = (v) => [v?.make, v?.model, v?.version, v?.trim, v?.finition, v?.title, v?.name, v?.description, v?.energy, v?.gearbox].map(up).join(" ");

function energy(v) {
  const s = allText(v);
  if (/PHEV|PLUG.?IN|RECHARGEABLE|HYBRIDE\s+RECHARGEABLE/.test(s)) return "phev";
  if (/HYBRIDE|\bHEV\b/.test(s)) return "hybrid";
  if (/ELECTRIQUE|\bEV\b/.test(s)) return "ev";
  if (/ESSENCE|PETROL|GASOLINE|PURETECH|TSI|THP|VTI/.test(s)) return "petrol";
  if (/DIESEL|BLUEHDI|TDI|DCI|HDI/.test(s)) return "diesel";
  return null;
}
function gearbox(v) {
  const s = allText(v);
  if (/AUTOMAT|E-CVT|CVT|DSG|EDC|DCT/.test(s)) return "automatic";
  if (/MANUEL|BVM|\bMT\b/.test(s)) return "manual";
  return null;
}
function generation(v) {
  const s = allText(v);
  if (/\bPRIUS\s*(?:5|V)\b|\bGEN(?:ERATION)?\s*5\b|\bMK\s*5\b/.test(s)) return 5;
  if (/\bPRIUS\s*(?:4|IV)\b|\bGEN(?:ERATION)?\s*4\b|\bMK\s*4\b/.test(s)) return 4;
  if (/\bPRIUS\s*(?:3|III)\b|\bGEN(?:ERATION)?\s*3\b|\bMK\s*3\b/.test(s)) return 3;
  const y = year(v);
  return /\bPRIUS\b/.test(s) && y != null && y >= 2023 ? 5 : null;
}
function compatible(t, c) {
  const tm = model(t), cm = model(c);
  if (tm && cm && !cm.includes(tm) && !tm.includes(cm)) return false;
  const tg = generation(t), cg = generation(c);
  if (tg && cg && tg !== cg) return false;
  const te = energy(t), ce = energy(c);
  if (te && ce && te !== ce) return false;
  const tp = power(t), cp = power(c);
  if (tp != null && cp != null && Math.abs(tp - cp) > 30) return false;
  const ty = year(t), cy = year(c);
  if (ty != null && cy != null && Math.abs(ty - cy) > 3) return false;
  const tb = gearbox(t), cb = gearbox(c);
  if (tb && cb && tb !== cb) return false;
  const p = price(c);
  return p != null && p > 500 && p < 250000;
}
function similarity(t, c) {
  let s = 0;
  const tm = model(t), cm = model(c), tg = generation(t), cg = generation(c);
  const te = energy(t), ce = energy(c), tp = power(t), cp = power(c);
  const ty = year(t), cy = year(c), tk = mileage(t), ck = mileage(c);
  const tb = gearbox(t), cb = gearbox(c);
  if (tm && cm && (cm.includes(tm) || tm.includes(cm))) s += 100;
  if (tg && tg === cg) s += 100;
  if (te && te === ce) s += 80;
  if (tb && tb === cb) s += 30;
  if (tp != null && cp != null) s += Math.max(0, 35 - Math.abs(tp - cp));
  if (ty != null && cy != null) s += Math.max(0, 30 - Math.abs(ty - cy) * 7);
  if (tk != null && ck != null) s += Math.max(0, 20 - Math.min(20, Math.abs(tk - ck) / 10000));
  return s;
}
function median(a) {
  const x = [...a].sort((a, b) => a - b);
  if (!x.length) return null;
  return x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2;
}
function quantile(a, p) {
  const x = [...a].sort((a, b) => a - b);
  if (!x.length) return null;
  if (x.length === 1) return x[0];
  const i = (x.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return x[lo] + (x[hi] - x[lo]) * (i - lo);
}
function robust(a) {
  if (a.length < 6) return a;
  const q1 = quantile(a, .25), q3 = quantile(a, .75), iqr = q3 - q1;
  const f = a.filter(v => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
  return f.length >= 4 ? f : a;
}

function normalizeVehicle(raw) {
  const v = raw?.vehicle && typeof raw.vehicle === "object" ? raw.vehicle : raw || {};
  const c = num(v.confidence);
  return {
    make: v.make ?? null,
    model: v.model ?? null,
    version: v.version ?? null,
    year: year(v),
    mileage_km: mileage(v),
    price_eur: price(v),
    energy: v.energy ?? energy(v),
    gearbox: v.gearbox ?? gearbox(v),
    power_hp: power(v),
    seller_type: v.seller_type ?? null,
    location: v.location ?? null,
    confidence: c == null ? 0 : Math.max(0, Math.min(100, Math.round(c <= 1 ? c * 100 : c))),
    uncertain_fields: Array.isArray(v.uncertain_fields) ? v.uncertain_fields : [],
    visible_claims: Array.isArray(v.visible_claims) ? v.visible_claims : [],
    warnings: Array.isArray(v.warnings) ? v.warnings : []
  };
}

async function carhuntSearch(make, mdl) {
  const key = process.env.CARHUNT_API_KEY;
  if (!key) return { listings: [], error: "La source de marché n’est pas configurée." };
  const qs = new URLSearchParams({ make: up(make), model: up(mdl), page_size: "50" });
  try {
    const r = await fetch(`https://api-pro.carhunt.fr/v1/listings/search?${qs}`, { headers: { Authorization: `Bearer ${key}` } });
    const text = await r.text();
    if (!r.ok) return { listings: [], error: `Source de marché indisponible (${r.status}).` };
    let d; try { d = JSON.parse(text); } catch { return { listings: [], error: "Réponse de marché invalide." }; }
    const listings = Array.isArray(d) ? d : (Array.isArray(d.listings) ? d.listings : Array.isArray(d.items) ? d.items : Array.isArray(d.results) ? d.results : []);
    return { listings };
  } catch {
    return { listings: [], error: "Source de marché temporairement indisponible." };
  }
}

async function buildMarket(input) {
  const t = normalizeVehicle(input);
  const make = String(t.make || "").trim();
  const mdl = model(t);
  const asking = price(t);
  if (!make || !mdl) return { ok: false, error: "Impossible de déterminer la marque et le modèle à partir des photos." };
  const result = await carhuntSearch(make, mdl);
  if (result.error) return { ok: false, error: result.error };
  const seen = new Set(), candidates = [];
  for (const x of result.listings) {
    const id = x.id || [x.make, x.model, x.year, x.mileage, x.price, x.source_url].join("|");
    if (seen.has(id)) continue;
    seen.add(id);
    if (asking != null && price(x) === asking && year(x) === year(t) && mileage(x) === mileage(t)) continue;
    if (compatible(t, x)) candidates.push(x);
  }
  candidates.sort((a, b) => similarity(t, b) - similarity(t, a));
  const top = candidates.slice(0, 20);
  const rawValues = top.map(price).filter(Number.isFinite);
  const values = robust(rawValues);
  const comparables = top.slice(0, 10).map(x => ({
    price_eur: price(x), price_display: euro(price(x)), year: year(x), mileage_km: mileage(x), mileage_display: km(mileage(x)),
    energy: x.energy || energy(x), version: x.version || x.finition || x.trim || null,
    source: x.source || null, source_url: x.source_url || x.url || x.link || null, seller_type: x.seller_type || null
  }));
  if (values.length < 3) return {
    ok: true, status: "insufficient", asking_display: euro(asking), price_eur: asking,
    median: null, median_display: "Non déterminé", low: null, low_display: "Non déterminé", high: null, high_display: "Non déterminé",
    confidence: Math.min(35, 15 + values.length * 7), label: "Données de marché insuffisantes",
    gap_text: `${values.length} comparable(s) réellement compatible(s). Pas d’estimation artificielle.`,
    warning: "L’échantillon est trop faible pour produire une estimation de prix fiable.", comparables_count: values.length, comparables
  };
  const med = median(values), low = quantile(values, .15), high = quantile(values, .85);
  const gap = asking != null && med ? Math.round((asking / med - 1) * 100) : null;
  const label = gap == null ? "Marché comparable" : gap <= -10 ? "Très intéressant" : gap <= -3 ? "Plutôt intéressant" : gap <= 3 ? "Dans le marché" : gap <= 10 ? "Plutôt cher" : "Cher";
  return {
    ok: true, status: "ok", asking_display: euro(asking), price_eur: asking,
    median: med, median_display: euro(med), low, low_display: euro(low), high, high_display: euro(high),
    confidence: Math.min(95, 42 + Math.min(10, values.length) * 5 + (values.length >= 6 ? 5 : 0)), label,
    gap_text: gap == null ? "Écart au marché non déterminé." : `Le prix demandé est ${Math.abs(gap)} % ${gap >= 0 ? "au-dessus" : "en dessous"} du prix médian.`,
    warning: values.length < 5 ? "Échantillon limité : interpréter la fourchette avec prudence." : values.length !== rawValues.length ? "Quelques valeurs extrêmes ont été écartées du calcul." : null,
    comparables_count: values.length, comparables
  };
}

const GEMINI_MODELS = ["gemini-3.6-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function analyzeWithGemini(files) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Le moteur d’analyse n’est pas configuré sur le serveur.");
  const prompt = `Tu es le moteur de lecture de Vaut le Coup ?. Croise 1 à 3 captures/photos d’une annonce automobile. Utilise uniquement ce qui est réellement visible. N’invente rien. Si une donnée est absente, illisible ou ambiguë, retourne null. Ne déduis jamais une finition, une puissance ou une énergie uniquement à partir du modèle. Signale les contradictions visibles. Les affirmations de l’annonce ne sont pas vérifiées. confidence mesure uniquement la qualité de lecture. Retourne UNIQUEMENT un JSON avec : make, model, version, year, mileage_km, price_eur, energy, gearbox, power_hp, seller_type, location, confidence, uncertain_fields, visible_claims, warnings.`;
  const parts = [{ text: prompt }, ...files.map(f => ({ inline_data: { mime_type: f.mimetype, data: f.buffer.toString("base64") } }))];
  for (let attempt = 0; attempt < GEMINI_MODELS.length; attempt++) {
    const modelName = GEMINI_MODELS[attempt];
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", temperature: 0 } })
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        const raw = d?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim() || "";
        const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
        if (a >= 0 && b > a) {
          try { return normalizeVehicle(JSON.parse(raw.slice(a, b + 1))); } catch {}
        }
      }
    } catch {}
    if (attempt < GEMINI_MODELS.length - 1) await sleep(1000 * (attempt + 1));
  }
  throw new Error("L’analyse IA est temporairement indisponible. Réessaie dans quelques instants.");
}

const HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#17212b"><title>Vaut le Coup ?</title><style>
*{box-sizing:border-box}body{margin:0;background:#eef2f5;color:#17212b;font-family:system-ui,-apple-system,Segoe UI,sans-serif}.app{max-width:720px;margin:auto;padding:20px 14px 60px}.hero{padding:8px 6px 18px}.logo{font-size:30px;font-weight:900}.logo span{color:#16a34a}.tag{color:#66727e}.card{background:#fff;border:1px solid #dfe5ea;border-radius:24px;padding:22px;margin:14px 0;box-shadow:0 4px 18px #0000000a}h1{font-size:30px;margin:0 0 8px}h2{font-size:24px;margin:0 0 18px}.drop{display:block;border:3px dashed #c7d0d8;border-radius:20px;padding:30px 16px;text-align:center;cursor:pointer}.drop strong{display:block;font-size:22px}.small{display:block;color:#7b8792;margin-top:12px}.previews{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:9px;margin-top:12px}.thumb{position:relative;aspect-ratio:1/1;min-width:0}.thumb img{width:100%;height:100%;object-fit:cover;border-radius:16px;border:1px solid #ddd}.remove{position:absolute;right:-4px;top:-4px;width:34px;height:34px;border:0;border-radius:50%;background:#17212b;color:#fff;font-size:21px}.btn{width:100%;border:0;border-radius:17px;padding:17px;background:#17212b;color:#fff;font-size:19px;font-weight:850;margin-top:18px}.btn:disabled{opacity:.5}.hidden{display:none!important}.progress{position:fixed;z-index:9999;top:10px;left:50%;transform:translateX(-50%);width:min(680px,calc(100% - 20px));background:#fff;border:1px solid #dbe3ea;border-radius:20px;padding:13px 15px;box-shadow:0 8px 28px #0002}.progressTop{display:flex;justify-content:space-between;font-weight:800}.track{height:12px;background:#e5eaf0;border-radius:20px;overflow:hidden;margin-top:9px}.fill{height:100%;width:5%;background:#2563eb;border-radius:20px;transition:width .45s ease}.step{margin-top:5px;color:#596572}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.row{padding:11px 0;border-bottom:1px solid #edf0f2}.row b{font-weight:800}.confidence{background:#eef7ff;border-radius:18px;padding:17px;margin-top:16px}.market{border-radius:18px;padding:18px}.market.ok{background:#f4f8ff}.market.insufficient{background:#fff7e8}.badge{display:inline-block;padding:8px 12px;border-radius:999px;font-weight:850}.green{background:#dcfce7;color:#166534}.blue{background:#dbeafe;color:#1d4ed8}.orange{background:#ffedd5;color:#9a3412}.red{background:#fee2e2;color:#991b1b}.big{font-size:31px;font-weight:900;margin:8px 0}.bar{height:14px;background:#e5e7eb;border-radius:20px;overflow:hidden;margin:10px 0}.bar i{display:block;height:100%;border-radius:20px}.comp{padding:12px 0;border-bottom:1px solid #e5e7eb}.comp:last-child{border-bottom:0}.neg{background:#f8fafc;border:1px solid #dbe3ea}.neg li{margin:8px 0}.error{background:#fee2e2;color:#991b1b;border-radius:18px;padding:16px;font-weight:700;margin:14px 0}@media(max-width:520px){.grid{grid-template-columns:1fr}.card{padding:20px}}
</style></head><body><main class="app"><header class="hero"><div class="logo">Vaut le <span>Coup ?</span></div><div class="tag">Analyse une annonce automobile avant d’acheter.</div></header>
<section class="card"><h1>Analyse une annonce</h1><p>Ajoute jusqu’à 3 photos de l’annonce ou du véhicule.</p><label class="drop"><input id="files" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden><div style="font-size:34px">📸</div><strong>Ajoute une capture ou une photo</strong><span class="small">JPG, PNG, WEBP — 12 Mo max par photo — 3 photos maximum</span></label><div id="previews" class="previews"></div><div id="error" class="error hidden"></div><button id="go" class="btn" disabled>Analyser l’annonce</button></section>
<section id="analysis" class="card hidden"><h2>Ce que l’IA a lu</h2><div id="vehicle"></div></section><section id="marketCard" class="card hidden"><h2>Est-ce que ça vaut le coup ?</h2><div id="market"></div></section></main>
<div id="progress" class="progress hidden"><div class="progressTop"><span id="progressTitle">🤖 Analyse en cours…</span><span id="progressPct">5 %</span></div><div class="track"><div id="progressFill" class="fill"></div></div><div id="progressStep" class="step">Lecture des photos…</div></div>
<script>
const $=id=>document.getElementById(id);let files=[];
function setProgress(p,title,step){$("progress").classList.remove("hidden");$("progressFill").style.width=p+"%";$("progressPct").textContent=p+" %";$("progressTitle").textContent=title;$("progressStep").textContent=step;}
function hideProgress(){setTimeout(()=>$("progress").classList.add("hidden"),700)}
function showError(e){$("error").textContent="❌ "+(e?.message||String(e)||"Une erreur est survenue.");$("error").classList.remove("hidden")}
function renderPreviews(){const p=$("previews");p.innerHTML="";files.forEach((f,i)=>{const d=document.createElement("div");d.className="thumb";const img=document.createElement("img");img.src=URL.createObjectURL(f);const b=document.createElement("button");b.className="remove";b.textContent="×";b.onclick=()=>{files.splice(i,1);renderPreviews();};d.append(img,b);p.append(d)});$("go").disabled=!files.length}
$("files").onchange=e=>{files=[...e.target.files].slice(0,3);renderPreviews();};
function val(v,fallback="Non déterminé"){return v==null||v===""?fallback:v}
function renderVehicle(v){$("analysis").classList.remove("hidden");const fields=[['Marque',v.make],['Modèle',v.model],['Version',v.version],['Année',v.year],['Kilométrage',v.mileage_km!=null?Number(v.mileage_km).toLocaleString('fr-FR')+' km':null],['Prix',v.price_eur!=null?Number(v.price_eur).toLocaleString('fr-FR')+' €':null],['Énergie',v.energy],['Boîte',v.gearbox],['Puissance',v.power_hp!=null?v.power_hp+' ch':null],['Lieu',v.location]];$("vehicle").innerHTML=fields.map(x=>'<div class="row"><b>'+x[0]+' :</b> '+val(x[1])+'</div>').join('')+`<div class="confidence">🔎 <strong>Fiabilité des informations extraites : ${Number(v.confidence||0)}/100</strong><br><small>Qualité de lecture des informations visibles. Ce score ne juge pas le véhicule.</small></div>`+(v.warnings?.length?'<div class="error">⚠️ '+v.warnings.map(x=>String(x)).join('<br>')+'</div>':'');}
function renderNegotiation(v,m){const items=[];if(m?.comparables_count>=3)items.push('Utilise les annonces comparables comme référence et demande au vendeur de justifier tout écart de prix.');if(v.visible_claims?.length)items.push('Demande les preuves des affirmations de l’annonce : factures, entretien, contrôle technique et justificatifs.');if(v.warnings?.length)items.push('Les incohérences relevées sont des points à vérifier avant de conclure et peuvent servir à négocier si elles sont confirmées.');items.push('Vérifie pneus, freins, carrosserie, usure intérieure et prochaines opérations d’entretien.');if(m?.status==='insufficient')items.push('Le marché est insuffisant : ne fixe pas un prix cible artificiel ; négocie seulement sur des éléments vérifiables.');return `<section class="card neg"><h2>💬 Négociation</h2><p><strong>Axes d’amélioration ou de négociation pour l’acheteur</strong></p><ul>${items.map(x=>'<li>'+x+'</li>').join('')}</ul></section>`}
function renderMarket(v,m){$("marketCard").classList.remove("hidden");if(!m||m.ok===false){$("market").innerHTML='<div class="error">❌ '+val(m?.error,'Analyse du marché indisponible.')+'</div>'+renderNegotiation(v,m);return;}let cls=m.label?.includes('intéressant')?'green':m.label==='Dans le marché'?'blue':m.label?.includes('cher')?'red':'orange';let pct=50;if(m.median&&m.price_eur)pct=Math.max(5,Math.min(95,50+(m.price_eur/m.median-1)*100));let html=`<div class="market ${m.status}"><span class="badge ${cls}">${m.label}</span><div class="big">${m.asking_display}</div><div>${m.gap_text}</div>${m.median?`<p><b>Médiane comparable :</b> ${m.median_display}</p><p><b>Fourchette indicative :</b> ${m.low_display} — ${m.high_display}</p><div class="bar"><i style="width:${pct}%;background:${cls==='green'?'#16a34a':cls==='blue'?'#2563eb':cls==='red'?'#dc2626':'#f59e0b'}"></i></div>`:''}${m.warning?'<p>⚠️ '+m.warning+'</p>':''}<p><b>Confiance marché :</b> ${m.confidence}/100 · ${m.comparables_count} comparable(s)</p></div>`;if(m.comparables?.length)html+='<h3>🔎 Comparables</h3>'+m.comparables.map(c=>`<div class="comp"><b>${c.price_display}</b> · ${val(c.year)} · ${val(c.mileage_display)}${c.version?' · '+c.version:''}${c.source?' · '+c.source:''}</div>`).join('');$("market").innerHTML=html+renderNegotiation(v,m);}
$("go").onclick=async()=>{if(!files.length)return;$("go").disabled=true;$("error").classList.add('hidden');$("analysis").classList.add('hidden');$("marketCard").classList.add('hidden');setProgress(5,'🤖 Analyse en cours…','Lecture des photos…');try{const fd=new FormData();files.forEach(f=>fd.append('photos',f));setProgress(18,'🤖 Analyse des photos…','Transmission sécurisée…');const ar=await fetch('/api/analyze',{method:'POST',body:fd});const ad=await ar.json().catch(()=>null);if(!ar.ok||!ad?.vehicle)throw new Error(ad?.error||'Réponse d’analyse invalide.');setProgress(52,'🔎 Lecture terminée…','Recherche du marché…');renderVehicle(ad.vehicle);setProgress(60,'💶 Recherche du marché…','Sélection des comparables compatibles…');const mr=await fetch('/api/market',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vehicle:ad.vehicle})});const md=await mr.json().catch(()=>null);if(!mr.ok||!md)throw new Error(md?.error||'Réponse marché invalide.');setProgress(92,'📊 Marché analysé…','Construction du verdict et de la négociation…');renderMarket(ad.vehicle,md);setProgress(100,'✅ Analyse terminée','Résultat disponible.');hideProgress();$("marketCard").scrollIntoView({behavior:'smooth',block:'start'});}catch(e){hideProgress();showError(e)}finally{$("go").disabled=!files.length}};
</script></body></html>`;

app.get("/", (_req, res) => res.type("html").send(HTML));
app.get("/health", (_req, res) => res.json({ ok: true, service: "vaut-le-coup", version: "1.0.0" }));
app.post("/api/analyze", upload.array("photos", 3), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: "Ajoute au moins une photo." });
    const vehicle = await analyzeWithGemini(req.files);
    return res.json({ ok: true, vehicle });
  } catch (e) {
    return res.status(503).json({ error: e?.message || "Analyse indisponible." });
  }
});
app.post("/api/market", async (req, res) => {
  try {
    const vehicle = normalizeVehicle(req.body?.vehicle || req.body || {});
    const result = await buildMarket(vehicle);
    return res.status(result.ok === false && !result.error?.includes("marché") ? 400 : 200).json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Impossible de calculer le marché pour le moment." });
  }
});

app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Une photo dépasse 12 Mo." });
  if (err?.code === "LIMIT_FILE_COUNT") return res.status(400).json({ error: "3 photos maximum." });
  return res.status(500).json({ error: "Erreur serveur." });
});

app.listen(PORT, "0.0.0.0", () => console.log(`Vaut le Coup ? — serveur unique sur ${PORT}`));
