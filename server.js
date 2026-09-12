import express from 'express';
import multer from 'multer';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const CARHUNT_KEY = process.env.CARHUNT_API_KEY || '';
const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const VERSION = '2026-09-12.3';
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 3, fileSize: 12 * 1024 * 1024 } });

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(x) ? x : null;
};
const norm = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const same = (a, b) => { const x = norm(a); const y = norm(b); return Boolean(x && y && (x === y || x.includes(y) || y.includes(x))); };
const euro = (v) => num(v) == null ? 'Non déterminé' : Math.round(num(v)).toLocaleString('fr-FR') + ' €';
const kmText = (v) => num(v) == null ? 'Non déterminé' : Math.round(num(v)).toLocaleString('fr-FR') + ' km';
const esc = (v) => String(v ?? '').replace(/[&<>\"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'":'&#039;' }[c]));
const median = (a) => { const x = a.filter(Number.isFinite).sort((p,q)=>p-q); if (!x.length) return null; const i=Math.floor(x.length/2); return x.length%2?x[i]:(x[i-1]+x[i])/2; };
const percentile = (a,p) => { const x=a.filter(Number.isFinite).sort((m,n)=>m-n); if(!x.length)return null; return x[Math.max(0,Math.min(x.length-1,Math.round((x.length-1)*p)))]; };

async function fetchTimeout(url, options, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...options, signal: c.signal }); }
  finally { clearTimeout(t); }
}

const PROMPT = [
  'Analyse les photos/captures de UNE MEME annonce automobile pour Vaut le Coup ?. Recoupe toutes les images.',
  'Lis uniquement ce qui est réellement visible. Ne devine rien. Information absente ou illisible = null.',
  'Si deux images se contredisent, signale précisément la contradiction dans warnings.',
  'Extrais marque, modèle, version/finition, année, kilométrage, prix, énergie, boîte, puissance, vendeur et lieu.',
  'Relève aussi entretien, distribution/courroie, contrôle technique, historique, accident, garantie, travaux, nombre de places et incohérences.',
  'Retourne UNIQUEMENT un objet JSON valide avec exactement ces clés : make, model, version, year, mileage_km, price_eur, energy, gearbox, power_hp, seller_type, location, title, confidence, uncertain_fields, visible_claims, warnings.',
  'confidence est un nombre 0-100. seller_type vaut professional, private ou null. Les trois derniers champs sont des tableaux de chaînes.'
].join(' ');

async function geminiCall(model, files) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: PROMPT }, ...files.map((f) => ({ inline_data: { mime_type: f.mimetype, data: f.buffer.toString('base64') } }))] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 1800 }
  };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(GEMINI_KEY);
  let r;
  try { r = await fetchTimeout(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }, 25000); }
  catch (e) { const x=new Error(e?.name==='AbortError'?'TIMEOUT':'NETWORK'); x.status=0; throw x; }
  const raw = await r.text();
  if (!r.ok) { const e=new Error('HTTP_'+r.status); e.status=r.status; e.raw=raw.slice(0,400); throw e; }
  let data; try { data=JSON.parse(raw); } catch { throw new Error('BAD_RESPONSE'); }
  const text=(data?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
  if(!text) throw new Error('EMPTY_RESPONSE');
  try { return JSON.parse(text); }
  catch { const a=text.indexOf('{'),b=text.lastIndexOf('}'); if(a<0||b<=a)throw new Error('BAD_JSON'); return JSON.parse(text.slice(a,b+1)); }
}

async function analyze(files) {
  if (!GEMINI_KEY) throw new Error('NO_GEMINI_KEY');
  let last;
  for (const model of GEMINI_MODELS) {
    for (let attempt=0; attempt<2; attempt++) {
      try {
        const v=await geminiCall(model,files);
        v.confidence=Math.max(0,Math.min(100,num(v.confidence)??0));
        for(const k of ['uncertain_fields','visible_claims','warnings']) if(!Array.isArray(v[k])) v[k]=[];
        v.model_used=model;
        return v;
      } catch(e) {
        last=e;
        if (![429,500,502,503,504].includes(e.status) || attempt===1) break;
        await new Promise(r=>setTimeout(r,800));
      }
    }
  }
  throw last || new Error('GEMINI_FAILED');
}

function comparable(x,v) {
  if(!same(x.make,v.make)||!same(x.model,v.model)) return false;
  const y=num(v.year), iy=num(x.year), k=num(v.mileage_km), ik=num(x.mileage);
  if(y!=null&&iy!=null&&Math.abs(y-iy)>4) return false;
  if(k!=null&&ik!=null&&Math.abs(k-ik)>60000) return false;
  if(v.energy&&x.energy&&!same(v.energy,x.energy)) return false;
  if(v.gearbox&&x.gearbox&&!same(v.gearbox,x.gearbox)) return false;
  return num(x.price)>0;
}

async function market(v) {
  if(!CARHUNT_KEY) return {ok:false,error:'Comparaison marché indisponible : clé CarHunt absente.'};
  if(!v?.make||!v?.model) return {ok:false,error:'Impossible de comparer : marque ou modèle non identifié.'};
  const params=new URLSearchParams({make:String(v.make).trim().toUpperCase(),model:String(v.model).trim().toUpperCase(),page_size:'100'});
  let r;
  try { r=await fetchTimeout('https://api-pro.carhunt.fr/v1/listings/search?'+params.toString(),{headers:{Authorization:'Bearer '+CARHUNT_KEY,Accept:'application/json'}},9000); }
  catch(e) { return {ok:false,error:e?.name==='AbortError'?'Comparaison marché trop longue.':'CarHunt momentanément inaccessible.'}; }
  const raw=await r.text(); let data={}; try{data=raw?JSON.parse(raw):{}}catch{}
  if(!r.ok){console.error('CarHunt HTTP',r.status,raw.slice(0,500));return {ok:false,error:'CarHunt a refusé la recherche (HTTP '+r.status+').'};}
  const listings=Array.isArray(data.listings)?data.listings:[];
  const comps=listings.filter(x=>comparable(x,v)).map(x=>({...x,p:num(x.price)})).filter(x=>x.p>0);
  const prices=comps.map(x=>x.p), med=median(prices), ask=num(v.price_eur);
  if(med==null)return {ok:true,comparables:0,asking:euro(ask),median:null,score:null,label:'Marché insuffisant',sample:[]};
  const gap=ask==null?null:((med-ask)/med)*100;
  const score=gap==null?null:Math.max(0,Math.min(100,Math.round(50+gap*2.5)));
  const label=score==null?'Marché comparable':score>=80?'🔥 Très bonne affaire':score>=65?'👍 Prix très intéressant':score>=55?'🟢 Plutôt intéressant':score>=45?'🟡 Dans le marché':score>=35?'🟠 Plutôt cher':'🔴 Cher';
  return {ok:true,comparables:prices.length,asking:euro(ask),median:Math.round(med),low:Math.round(percentile(prices,.15)),high:Math.round(percentile(prices,.85)),score,label,gap_pct:gap==null?null:Math.round(gap*10)/10,gap_eur:ask==null?null:Math.round(med-ask),warning:prices.length<8?'Échantillon limité : prudence dans le verdict.':null,sample:comps.slice(0,8).map(x=>({price:x.p,year:x.year,mileage:x.mileage,energy:x.energy,gearbox:x.gearbox,horsepower:x.horsepower,version:x.version,seller_type:x.seller_type,city:x.city,source:x.source,url:x.source_url}))};
}

app.get('/api/health',(_req,res)=>res.json({ok:true,version:VERSION,provider:'gemini',models:GEMINI_MODELS,gemini:Boolean(GEMINI_KEY),carhunt:Boolean(CARHUNT_KEY)}));

app.post('/api/analyze',(req,res)=>{
  console.log('POST /api/analyze');
  upload.array('photos',3)(req,res,async(err)=>{
    if(err){console.error('Upload',err);return res.status(400).json({ok:false,error:err.code==='LIMIT_FILE_SIZE'?'Une photo dépasse 12 Mo.':'Impossible de recevoir les photos.'});}
    try{
      const files=req.files||[];
      if(!files.length)return res.status(400).json({ok:false,error:'Ajoute au moins une photo.'});
      console.log('Analyze received',files.length,'photos');
      const vehicle=await analyze(files);
      console.log('Analyze OK',vehicle.make,vehicle.model,vehicle.year,vehicle.price_eur);
      return res.json({ok:true,vehicle,photos:files.length});
    }catch(e){
      console.error('Analyze error',e?.message,e?.status||'',e?.raw||'');
      let message='Analyse IA indisponible. Réessaie.';
      if(e?.message==='NO_GEMINI_KEY')message='Gemini n’est pas configuré sur le serveur.';
      else if(e?.message==='TIMEOUT')message='Analyse trop longue. Réessaie avec 1 à 3 captures.';
      else if(e?.status===429)message='Gemini est momentanément très sollicité. Réessaie dans quelques secondes.';
      return res.status(503).json({ok:false,error:message});
    }
  });
});

app.post('/api/market',async(req,res)=>{console.log('POST /api/market');try{const out=await market(req.body||{});return res.status(out.ok?200:503).json(out);}catch(e){console.error('Market error',e);return res.status(503).json({ok:false,error:'Comparaison marché indisponible.'});}});

const HTML='<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#17212b"><meta http-equiv="Cache-Control" content="no-store"><title>Vaut le Coup ?</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17212b;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}.wrap{max-width:760px;margin:auto;padding:18px 12px 60px}.card{background:#fff;border:1px solid #e0e4e8;border-radius:22px;padding:20px;margin:14px 0;box-shadow:0 2px 10px #00000008}h1{font-size:36px;line-height:1.05;margin:0}h2{font-size:27px;margin:0 0 12px}.muted{color:#68737d}.picker{border:3px dashed #c8ced4;border-radius:20px;padding:22px 12px;text-align:center;min-height:150px;display:flex;flex-direction:column;justify-content:center;align-items:center}.pickbtn{border:0;background:#17212b;color:#fff;border-radius:14px;padding:14px 20px;font-size:18px;font-weight:850;cursor:pointer}.picker input{position:absolute;width:1px;height:1px;opacity:0}.small{display:block;color:#7b858e;margin-top:9px}.previews{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:12px}.thumb{position:relative;aspect-ratio:1}.thumb img{width:100%;height:100%;object-fit:cover;border-radius:14px;border:1px solid #ddd}.remove{position:absolute;right:-5px;top:-5px;width:34px;height:34px;border:0;border-radius:50%;background:#17212b;color:#fff;font-size:22px;cursor:pointer}.btn{width:100%;border:0;border-radius:15px;padding:17px;background:#17212b;color:#fff;font-size:19px;font-weight:850;margin-top:15px;min-height:56px;cursor:pointer}.btn:disabled{opacity:.45;cursor:not-allowed}.status{display:none;margin-top:14px;padding:15px;border-radius:17px;background:#eef2f5}.status.on{display:block}.track{height:10px;background:#dce2e7;border-radius:99px;overflow:hidden;margin-top:9px}.bar{height:100%;width:0;background:#2563eb;transition:width .2s}.grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.field{background:#f6f7f8;border-radius:13px;padding:11px}.field b{font-size:12px;color:#707b84}.warn{background:#fff0d2;border-radius:15px;padding:13px;margin:9px 0}.result{padding:16px;border-radius:18px;background:#eef2f5}.score{font-size:50px;font-weight:950}.comp{padding:11px 0;border-bottom:1px solid #e1e5e8}.price{font-weight:900}.link{color:#174c7a;font-weight:700;text-decoration:none}@media(max-width:520px){h1{font-size:34px}.grid{grid-template-columns:1fr}.card{padding:18px}.previews{gap:7px}}</style></head><body><main class="wrap"><h1>Vaut le Coup ? ✓</h1><p class="muted">Avant d’acheter. Demande à l’IA.</p><section class="card"><h2>Analyse une annonce</h2><p>Ajoute jusqu’à 3 captures/photos de la même annonce.</p><div class="picker"><button id="pick" class="pickbtn" type="button">📸 Ajouter une photo</button><input id="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple><span class="small">JPG, PNG ou WEBP — 12 Mo max par photo — 3 photos maximum</span></div><div id="previews" class="previews"></div><div id="status" class="status"><b id="statusTitle"></b><div class="track"><div id="bar" class="bar"></div></div><div id="statusText" class="muted" style="margin-top:8px"></div></div><button id="analyze" class="btn" type="button" disabled>Analyser l’annonce</button></section><section id="analysis" class="card" hidden></section><section id="market" class="card" hidden></section></main><script>
(function(){
'use strict';
var input=document.getElementById('photos'),pick=document.getElementById('pick'),previews=document.getElementById('previews'),analyzeBtn=document.getElementById('analyze'),status=document.getElementById('status'),statusTitle=document.getElementById('statusTitle'),statusText=document.getElementById('statusText'),bar=document.getElementById('bar'),analysis=document.getElementById('analysis'),marketBox=document.getElementById('market');
var files=[],busy=false;
function escHtml(v){return String(v==null?'':v).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[c];});}
function display(v){if(v==null||v==='')return 'Non déterminé';return String(v);}
function setStatus(p,t,m){status.classList.add('on');bar.style.width=Math.max(0,Math.min(100,p))+'%';statusTitle.textContent=t;statusText.textContent=m||'';}
function renderPhotos(){previews.innerHTML='';files.forEach(function(file,i){var box=document.createElement('div'),img=document.createElement('img'),btn=document.createElement('button');box.className='thumb';img.alt='Photo '+(i+1);img.src=URL.createObjectURL(file);btn.className='remove';btn.type='button';btn.textContent='×';btn.onclick=function(){files.splice(i,1);renderPhotos();};box.appendChild(img);box.appendChild(btn);previews.appendChild(box);});analyzeBtn.disabled=!files.length||busy;}
pick.onclick=function(){if(!busy)input.click();};
input.onchange=function(){Array.from(input.files||[]).forEach(function(f){if(files.length>=3)return;if(!/^image\/(jpeg|png|webp)$/.test(f.type))return;if(f.size>12*1024*1024)return;files.push(f);});input.value='';renderPhotos();};
function field(k,v){return '<div class="field"><b>'+escHtml(k)+'</b><br>'+escHtml(display(v))+'</div>';}
function showAnalysis(v){analysis.hidden=false;var h='<h2>Ce que l’IA a lu</h2><div class="grid">';h+=field('Marque',v.make)+field('Modèle',v.model)+field('Version / finition',v.version)+field('Année',v.year)+field('Kilométrage',v.mileage_km==null?null:Number(v.mileage_km).toLocaleString('fr-FR')+' km')+field('Prix',v.price_eur==null?null:Number(v.price_eur).toLocaleString('fr-FR')+' €')+field('Énergie',v.energy)+field('Boîte',v.gearbox)+field('Puissance',v.power_hp==null?null:String(v.power_hp)+' ch')+field('Vendeur',v.seller_type)+field('Lieu',v.location)+field('Confiance',String(v.confidence||0)+' / 100')+'</div>';if(Array.isArray(v.visible_claims)&&v.visible_claims.length)h+='<h3>Éléments visibles</h3>'+v.visible_claims.map(function(x){return '<span class="pill">'+escHtml(x)+'</span>';}).join('');if(Array.isArray(v.uncertain_fields)&&v.uncertain_fields.length)h+='<div class="warn"><b>À vérifier :</b><br>'+v.uncertain_fields.map(escHtml).join('<br>')+'</div>';if(Array.isArray(v.warnings)&&v.warnings.length)h+='<div class="warn"><b>Points d’attention :</b><br>'+v.warnings.map(escHtml).join('<br>')+'</div>';analysis.innerHTML=h;}
function showMarket(m){marketBox.hidden=false;if(!m||!m.ok){marketBox.innerHTML='<h2>Comparaison marché</h2><div class="warn">'+escHtml(m&&m.error?m.error:'Comparaison indisponible.')+'</div>';return;}var h='<h2>Comparaison marché</h2><div class="result"><div class="score">'+escHtml(m.score==null?'—':m.score+'/100')+'</div><h3>'+escHtml(m.label||'')+'</h3><p>Moyenne centrale du marché : <b>'+escHtml(m.median==null?'—':Number(m.median).toLocaleString('fr-FR')+' €')+'</b></p><p>Fourchette indicative : <b>'+escHtml(m.low==null?'—':Number(m.low).toLocaleString('fr-FR')+' €')+'</b> à <b>'+escHtml(m.high==null?'—':Number(m.high).toLocaleString('fr-FR')+' €')+'</b></p><p>Écart avec le prix demandé : <b>'+escHtml(m.gap_eur==null?'—':Number(m.gap_eur).toLocaleString('fr-FR')+' €')+'</b> ('+escHtml(m.gap_pct==null?'—':m.gap_pct+' %')+')</p></div>';if(m.warning)h+='<div class="warn">'+escHtml(m.warning)+'</div>';h+='<h3>Véhicules comparables ('+escHtml(m.comparables)+')</h3>';(m.sample||[]).forEach(function(x){h+='<div class="comp"><span class="price">'+escHtml(Number(x.price).toLocaleString('fr-FR')+' €')+'</span> — '+escHtml(x.year||'')+' — '+escHtml(x.mileage?Number(x.mileage).toLocaleString('fr-FR')+' km':'')+' — '+escHtml(x.energy||'')+(x.city?' — '+escHtml(x.city):'')+(x.url?' — <a class="link" target="_blank" rel="noopener" href="'+escHtml(x.url)+'">Voir l’annonce</a>':'')+'</div>';});marketBox.innerHTML=h;}
function compress(file){return new Promise(function(resolve,reject){var img=new Image();var url=URL.createObjectURL(file);img.onload=function(){var max=1800,w=img.naturalWidth,h=img.naturalHeight;if(w>max||h>max){if(w>=h){h=Math.round(h*max/w);w=max;}else{w=Math.round(w*max/h);h=max;}}var c=document.createElement('canvas');c.width=w;c.height=h;var ctx=c.getContext('2d');ctx.drawImage(img,0,0,w,h);URL.revokeObjectURL(url);c.toBlob(function(blob){if(blob)resolve(new File([blob],'photo-'+Date.now()+'.jpg',{type:'image/jpeg'}));else reject(new Error('compression'));},'image/jpeg',0.82);};img.onerror=function(){URL.revokeObjectURL(url);reject(new Error('image'));};img.src=url;});}
async function run(){if(busy||!files.length)return;busy=true;analyzeBtn.disabled=true;analysis.hidden=true;marketBox.hidden=true;setStatus(5,'Préparation','Optimisation des photos…');try{var optimized=[];for(var i=0;i<files.length;i++){setStatus(8+i*8,'Préparation','Photo '+(i+1)+'/'+files.length+'…');optimized.push(await compress(files[i]));}var fd=new FormData();optimized.forEach(function(f){fd.append('photos',f,f.name);});setStatus(25,'Analyse IA','Lecture de l’annonce…');var controller=new AbortController();var timer=setTimeout(function(){controller.abort();},65000);var response;try{response=await fetch(new URL('/api/analyze',window.location.href).href,{method:'POST',body:fd,cache:'no-store',credentials:'same-origin',signal:controller.signal,headers:{'X-VLC-Version':'2026-09-12.3'}});}finally{clearTimeout(timer);}var text=await response.text();var data;try{data=JSON.parse(text);}catch{throw new Error('Réponse serveur invalide ('+response.status+').');}if(!response.ok||!data.ok)throw new Error(data.error||'Analyse impossible.');setStatus(65,'Analyse terminée','Véhicule identifié.');showAnalysis(data.vehicle);setStatus(72,'Marché','Recherche des comparables…');var mr=await fetch(new URL('/api/market',window.location.href).href,{method:'POST',headers:{'Content-Type':'application/json','X-VLC-Version':'2026-09-12.3'},body:JSON.stringify(data.vehicle),cache:'no-store',credentials:'same-origin'});var mt=await mr.text(),md;try{md=JSON.parse(mt);}catch{md={ok:false,error:'Réponse marché invalide.'};}showMarket(md);setStatus(100,'Terminé','Analyse et comparaison disponibles.');}catch(e){var msg=e&&e.name==='AbortError'?'La connexion a pris trop de temps. Réessaie.':(e&&e.message?e.message:'Échec de la connexion au serveur.');setStatus(100,'Impossible de terminer',msg);marketBox.hidden=true;}finally{busy=false;analyzeBtn.disabled=!files.length;}}
analyzeBtn.onclick=run;
})();
</script></body></html>';

app.get('/',(_req,res)=>res.type('html').send(HTML));
app.listen(PORT,()=>console.log('Vaut le Coup ? — '+PORT+' — '+VERSION+' — Gemini '+GEMINI_MODELS.join(', ')));