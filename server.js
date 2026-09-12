import express from 'express';
import multer from 'multer';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const CONFIGURED_MODEL = process.env.GEMINI_MODEL || '';
const GEMINI_MODELS = [...new Set([CONFIGURED_MODEL, 'gemini-2.5-flash-lite', 'gemini-2.5-flash'].filter(Boolean))];
const CARHUNT_KEY = process.env.CARHUNT_API_KEY || '';
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 3, fileSize: 12 * 1024 * 1024 } });
app.use(express.json({ limit: '1mb' }));

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(x) ? x : null;
};
const norm = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const same = (a, b) => {
  const x = norm(a); const y = norm(b);
  return Boolean(x && y && (x === y || x.includes(y) || y.includes(x)));
};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[c]));
const euro = (v) => num(v) == null ? 'Non déterminé' : Math.round(num(v)).toLocaleString('fr-FR') + ' €';
const kmText = (v) => num(v) == null ? 'Non déterminé' : Math.round(num(v)).toLocaleString('fr-FR') + ' km';
const median = (values) => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
};
const percentile = (values, p) => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.max(0, Math.min(a.length - 1, Math.round((a.length - 1) * p)))];
};

async function fetchTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

const GEMINI_PROMPT = [
  'Tu analyses les photos/captures de UNE MEME annonce automobile pour l’application Vaut le Coup ?. Recoupe toutes les images.',
  'Lis uniquement ce qui est réellement visible. Ne devine pas. Si une information est absente ou illisible, mets null.',
  'Si les images se contredisent, indique précisément la contradiction dans warnings.',
  'Extrais : marque, modèle, version/finition, année, kilométrage, prix, énergie, boîte, puissance, vendeur, lieu.',
  'Relève aussi toute information visible concernant entretien, distribution/courroie, contrôle technique, historique, accident, garantie, travaux, nombre de places et incohérences.',
  'Retourne UNIQUEMENT un objet JSON valide avec exactement ces clés : make, model, version, year, mileage_km, price_eur, energy, gearbox, power_hp, seller_type, location, title, confidence, uncertain_fields, visible_claims, warnings.',
  'confidence est un nombre de 0 à 100. seller_type vaut professional, private ou null. uncertain_fields, visible_claims et warnings sont des tableaux de chaînes.'
].join(' ');

async function geminiCall(model, files) {
  const body = {
    contents: [{ role: 'user', parts: [
      { text: GEMINI_PROMPT },
      ...files.map((f) => ({ inline_data: { mime_type: f.mimetype, data: f.buffer.toString('base64') } }))
    ]}],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 1600 }
  };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(GEMINI_KEY);
  let response;
  try {
    response = await fetchTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 20000);
  } catch (e) {
    throw new Error(e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
  }
  const raw = await response.text();
  if (!response.ok) {
    const err = new Error('HTTP_' + response.status);
    err.status = response.status;
    err.raw = raw.slice(0, 500);
    throw err;
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('BAD_RESPONSE'); }
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('EMPTY_RESPONSE');
  try { return JSON.parse(text); }
  catch {
    const a = text.indexOf('{'); const b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('BAD_JSON');
    return JSON.parse(text.slice(a, b + 1));
  }
}

async function analyze(files) {
  if (!GEMINI_KEY) throw new Error('NO_GEMINI_KEY');
  let last = null;
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const v = await geminiCall(model, files);
        v.confidence = Math.max(0, Math.min(100, num(v.confidence) ?? 0));
        for (const key of ['uncertain_fields', 'visible_claims', 'warnings']) if (!Array.isArray(v[key])) v[key] = [];
        v.model_used = model;
        return v;
      } catch (e) {
        last = e;
        if (![429, 500, 502, 503, 504].includes(e.status) || attempt === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
  }
  throw last || new Error('GEMINI_FAILED');
}

function isComparable(item, vehicle) {
  if (!same(item.make, vehicle.make) || !same(item.model, vehicle.model)) return false;
  const y = num(vehicle.year); const iy = num(item.year);
  const k = num(vehicle.mileage_km); const ik = num(item.mileage);
  if (y != null && iy != null && Math.abs(y - iy) > 4) return false;
  if (k != null && ik != null && Math.abs(k - ik) > 60000) return false;
  if (vehicle.energy && item.energy && !same(vehicle.energy, item.energy)) return false;
  if (vehicle.gearbox && item.gearbox && !same(vehicle.gearbox, item.gearbox)) return false;
  return num(item.price) > 0;
}

async function market(vehicle) {
  if (!CARHUNT_KEY) return { ok: false, error: 'Comparaison marché indisponible : clé CarHunt absente.' };
  if (!vehicle?.make || !vehicle?.model) return { ok: false, error: 'Impossible de comparer : marque ou modèle non identifié.' };
  const params = new URLSearchParams({ make: String(vehicle.make).trim().toUpperCase(), model: String(vehicle.model).trim().toUpperCase(), page_size: '100' });
  let response;
  try {
    response = await fetchTimeout('https://api-pro.carhunt.fr/v1/listings/search?' + params.toString(), {
      headers: { Authorization: 'Bearer ' + CARHUNT_KEY, Accept: 'application/json' }
    }, 9000);
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'Comparaison marché trop longue.' : 'CarHunt momentanément inaccessible.' };
  }
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    console.error('CarHunt HTTP', response.status, raw.slice(0, 500));
    return { ok: false, error: 'CarHunt a refusé la recherche (HTTP ' + response.status + ').' };
  }
  const listings = Array.isArray(data.listings) ? data.listings : [];
  const comps = listings.filter((x) => isComparable(x, vehicle)).map((x) => ({ ...x, price_num: num(x.price) })).filter((x) => x.price_num > 0);
  const prices = comps.map((x) => x.price_num);
  const med = median(prices);
  const ask = num(vehicle.price_eur);
  if (med == null) return { ok: true, comparables: 0, asking: euro(ask), median: null, score: null, label: 'Marché insuffisant', sample: [] };
  const gap = ask == null ? null : ((med - ask) / med) * 100;
  const score = gap == null ? null : Math.max(0, Math.min(100, Math.round(50 + gap * 2.5)));
  const label = score == null ? 'Marché comparable' : score >= 80 ? '🔥 Très bonne affaire' : score >= 65 ? '👍 Prix très intéressant' : score >= 55 ? '🟢 Plutôt intéressant' : score >= 45 ? '🟡 Dans le marché' : score >= 35 ? '🟠 Plutôt cher' : '🔴 Cher';
  return {
    ok: true, comparables: prices.length, asking: euro(ask), median: Math.round(med), low: Math.round(percentile(prices, 0.15)), high: Math.round(percentile(prices, 0.85)),
    score, label, gap_pct: gap == null ? null : Math.round(gap * 10) / 10, gap_eur: ask == null ? null : Math.round(med - ask),
    warning: prices.length < 8 ? 'Échantillon limité : prudence dans le verdict.' : null,
    sample: comps.slice(0, 8).map((x) => ({ price: x.price_num, year: x.year, mileage: x.mileage, energy: x.energy, gearbox: x.gearbox, horsepower: x.horsepower, version: x.version, seller_type: x.seller_type, city: x.city, source: x.source, url: x.source_url }))
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, provider: 'gemini', models: GEMINI_MODELS, gemini: Boolean(GEMINI_KEY), carhunt: Boolean(CARHUNT_KEY) }));

app.post('/api/analyze', (req, res) => {
  upload.array('photos', 3)(req, res, async (err) => {
    if (err) {
      console.error('Upload error', err);
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Une photo dépasse 12 Mo.' : 'Impossible de recevoir les photos.';
      return res.status(400).json({ ok: false, error: message });
    }
    try {
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ ok: false, error: 'Ajoute au moins une photo.' });
      const vehicle = await analyze(files);
      console.log('Analyze OK', files.length, 'photos', vehicle.make, vehicle.model);
      return res.json({ ok: true, vehicle, photos: files.length });
    } catch (e) {
      console.error('Analyze error', e?.message, e?.status || '', e?.raw || '');
      let message = 'Analyse IA indisponible. Réessaie.';
      if (e?.message === 'NO_GEMINI_KEY') message = 'Gemini n’est pas configuré sur le serveur.';
      else if (e?.message === 'TIMEOUT') message = 'Analyse trop longue. Réessaie avec 1 à 3 captures.';
      else if (e?.status === 429) message = 'Gemini est momentanément très sollicité. Réessaie dans quelques secondes.';
      return res.status(503).json({ ok: false, error: message });
    }
  });
});

app.post('/api/market', async (req, res) => {
  try {
    const result = await market(req.body || {});
    return res.status(result.ok ? 200 : 503).json(result);
  } catch (e) {
    console.error('Market error', e);
    return res.status(503).json({ ok: false, error: 'Comparaison marché indisponible.' });
  }
});

const HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#17212b"><title>Vaut le Coup ?</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17212b;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}.wrap{max-width:760px;margin:auto;padding:18px 12px 60px}.card{background:#fff;border:1px solid #e0e4e8;border-radius:22px;padding:20px;margin:14px 0;box-shadow:0 2px 10px #00000008}h1{font-size:36px;line-height:1.05;margin:0}h2{font-size:27px;margin:0 0 12px}.muted{color:#68737d}.picker{border:3px dashed #c8ced4;border-radius:20px;padding:25px 12px;text-align:center;min-height:150px;display:flex;flex-direction:column;justify-content:center;align-items:center}.picker button{border:0;background:#17212b;color:#fff;border-radius:14px;padding:14px 18px;font-size:18px;font-weight:800}.picker input{position:absolute;width:1px;height:1px;opacity:0}.small{display:block;color:#7b858e;margin-top:9px}.previews{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:12px}.thumb{position:relative;aspect-ratio:1}.thumb img{width:100%;height:100%;object-fit:cover;border-radius:14px;border:1px solid #ddd}.remove{position:absolute;right:-5px;top:-5px;width:34px;height:34px;border:0;border-radius:50%;background:#17212b;color:#fff;font-size:22px}.btn{width:100%;border:0;border-radius:15px;padding:17px;background:#17212b;color:#fff;font-size:19px;font-weight:850;margin-top:15px;min-height:56px}.btn:disabled{opacity:.45}.status{display:none;margin-top:14px;padding:15px;border-radius:17px;background:#eef2f5}.status.on{display:block}.track{height:10px;background:#dce2e7;border-radius:99px;overflow:hidden;margin-top:9px}.bar{height:100%;width:0;background:#2563eb;transition:width .2s}.grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.field{background:#f6f7f8;border-radius:13px;padding:11px}.field b{font-size:12px;color:#707b84}.warn{background:#fff0d2;border-radius:15px;padding:13px;margin:9px 0}.result{padding:16px;border-radius:18px;background:#eef2f5}.score{font-size:50px;font-weight:950}.comp{padding:11px 0;border-bottom:1px solid #e1e5e8}.price{font-weight:900}.link{color:#174c7a;font-weight:700;text-decoration:none}@media(max-width:520px){h1{font-size:33px}.grid{grid-template-columns:1fr}.card{padding:18px}}
</style></head><body><main class="wrap">
<h1>Vaut le Coup ? ✓</h1><p class="muted">Avant d’acheter. Demande à l’IA.</p>
<section class="card"><h2>Analyse une annonce</h2><p>Ajoute jusqu’à 3 captures ou photos de la même annonce.</p>
<div class="picker"><input id="photos" type="file" accept="image/jpeg,image/png,image/webp"><button id="add">📸 Ajouter une photo</button><span class="small">JPG, PNG ou WEBP — 12 Mo max par photo — 3 photos maximum</span></div>
<div id="previews" class="previews"></div><div id="status" class="status"><b id="statusTitle"></b><div class="track"><div id="bar" class="bar"></div></div><div id="statusText" class="muted" style="margin-top:8px"></div></div>
<button id="analyze" class="btn" disabled>Analyser l’annonce</button></section>
<section id="analysis" class="card" hidden></section><section id="market" class="card" hidden></section></main>
<script>
(function(){
'use strict';
var input=document.getElementById('photos'),add=document.getElementById('add'),previews=document.getElementById('previews'),analyzeBtn=document.getElementById('analyze'),status=document.getElementById('status'),statusTitle=document.getElementById('statusTitle'),statusText=document.getElementById('statusText'),bar=document.getElementById('bar'),analysis=document.getElementById('analysis'),marketBox=document.getElementById('market');
var files=[],busy=false;
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c];});}
function fmtNum(v){var n=Number(v);return Number.isFinite(n)?n.toLocaleString('fr-FR'):String(v==null?'Non déterminé':v);}
function renderPhotos(){previews.innerHTML='';files.forEach(function(file,index){var box=document.createElement('div');var img=document.createElement('img');var remove=document.createElement('button');box.className='thumb';img.src=URL.createObjectURL(file);img.alt='Photo '+(index+1);remove.className='remove';remove.type='button';remove.textContent='×';remove.onclick=function(){files.splice(index,1);renderPhotos();};box.appendChild(img);box.appendChild(remove);previews.appendChild(box);});analyzeBtn.disabled=files.length===0||busy;}
add.onclick=function(){if(!busy)input.click();};
input.onchange=function(){var selected=Array.prototype.slice.call(input.files||[]);selected.forEach(function(file){if(files.length>=3)return;if(!/^image\\/(jpeg|png|webp)$/.test(file.type))return;if(file.size>12*1024*1024)return;files.push(file);});input.value='';renderPhotos();};
function setStatus(p,title,text){status.classList.add('on');bar.style.width=p+'%';statusTitle.textContent=title;statusText.textContent=text||'';}
function field(label,value){return '<div class="field"><b>'+esc(label)+'</b><br>'+esc(value==null?'Non déterminé':value)+'</div>';}
function showAnalysis(v){analysis.hidden=false;var h='<h2>Ce que l’IA a lu</h2><div class="grid">';h+=field('Marque',v.make)+field('Modèle',v.model)+field('Version / finition',v.version)+field('Année',v.year)+field('Kilométrage',v.mileage_km==null?null:fmtNum(v.mileage_km)+' km')+field('Prix',v.price_eur==null?null:fmtNum(v.price_eur)+' €')+field('Énergie',v.energy)+field('Boîte',v.gearbox)+field('Puissance',v.power_hp==null?null:fmtNum(v.power_hp)+' ch')+field('Vendeur',v.seller_type)+field('Lieu',v.location)+field('Places',v.seats);h+='</div>';
if(v.title)h+='<p><b>Annonce :</b> '+esc(v.title)+'</p>';
if(Array.isArray(v.visible_claims)&&v.visible_claims.length)h+='<h3>Informations visibles</h3>'+v.visible_claims.map(function(x){return '<span class="pill">'+esc(x)+'</span>';}).join('');
if(Array.isArray(v.uncertain_fields)&&v.uncertain_fields.length)h+='<div class="warn"><b>À confirmer :</b><br>'+v.uncertain_fields.map(function(x){return '• '+esc(x);}).join('<br>')+'</div>';
if(Array.isArray(v.warnings)&&v.warnings.length)h+='<div class="warn"><b>Points d’attention :</b><br>'+v.warnings.map(function(x){return '• '+esc(x);}).join('<br>')+'</div>';
h+='<p class="muted">Confiance IA : '+esc(v.confidence)+' %</p>';analysis.innerHTML=h;}
function showMarket(m){marketBox.hidden=false;var h='<h2>Comparaison marché</h2>';if(!m.ok){h+='<div class="warn">'+esc(m.error||'Comparaison indisponible.')+'</div>';marketBox.innerHTML=h;return;}if(!m.comparables){h+='<div class="result"><b>Pas assez d’annonces comparables trouvées.</b><p class="muted">La recherche CarHunt a bien été effectuée, mais l’échantillon ne permet pas un verdict fiable.</p></div>';marketBox.innerHTML=h;return;}h+='<div class="result"><div class="score">'+esc(m.score==null?'—':m.score+'/100')+'</div><h3>'+esc(m.label)+'</h3><p><b>Prix demandé :</b> '+esc(m.asking)+'<br><b>Médiane :</b> '+esc(m.median.toLocaleString('fr-FR'))+' €<br><b>Fourchette :</b> '+esc(m.low.toLocaleString('fr-FR'))+' – '+esc(m.high.toLocaleString('fr-FR'))+' €';if(m.gap_eur!=null)h+='<br><b>Écart :</b> '+esc(m.gap_eur.toLocaleString('fr-FR'))+' € ('+esc(m.gap_pct)+' %)';h+='</p></div>';if(m.warning)h+='<div class="warn">'+esc(m.warning)+'</div>';h+='<h3>Comparables</h3>';(m.sample||[]).forEach(function(x){h+='<div class="comp"><span class="price">'+esc(fmtNum(x.price))+' €</span> — '+esc(x.year||'année ?')+' — '+esc(x.mileage==null?'km ?':fmtNum(x.mileage)+' km')+'<br><span class="muted">'+esc(x.version||x.energy||'')+' '+esc(x.city||'')+'</span>';if(x.url)h+=' <a class="link" href="'+esc(x.url)+'" target="_blank" rel="noopener">Voir</a>';h+='</div>';});marketBox.innerHTML=h;}
async function run(){if(busy||!files.length)return;busy=true;analysis.hidden=true;marketBox.hidden=true;analyzeBtn.disabled=true;setStatus(8,'Préparation','Envoi des photos…');var fd=new FormData();files.forEach(function(file){fd.append('photos',file,file.name);});try{setStatus(20,'Analyse IA','Lecture et recoupement des captures…');var response=await fetch('/api/analyze',{method:'POST',body:fd});var data=await response.json().catch(function(){return {};});if(!response.ok||!data.ok)throw new Error(data.error||'Analyse impossible.');showAnalysis(data.vehicle||{});setStatus(70,'Analyse terminée','Recherche de véhicules comparables…');var marketResponse=await fetch('/api/market',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data.vehicle||{})});var marketData=await marketResponse.json().catch(function(){return {};});showMarket(marketData);setStatus(100,'Terminé','Analyse et comparaison terminées.');}catch(e){setStatus(100,'Impossible de terminer',e.message||'Une erreur est survenue.');}finally{busy=false;analyzeBtn.disabled=files.length===0;}}
analyzeBtn.onclick=run;
})();
</script></body></html>`;

app.get('/', (_req, res) => res.type('html').send(HTML));
app.listen(PORT, () => console.log('Vaut le Coup ? — ' + PORT + ' — Gemini ' + (CONFIGURED_MODEL || GEMINI_MODELS[0])));
