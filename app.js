import express from 'express';
import multer from 'multer';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const CARHUNT_KEY = process.env.CARHUNT_API_KEY || '';
const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const VERSION = '2026-09-12.7';
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 3, fileSize: 12 * 1024 * 1024 } });

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

const number = v => { if (v == null || v === '') return null; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const norm = v => String(v ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const same = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
const escapeHtml = v => String(v ?? '').replace(/[&<>\"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'":'&#039;' }[c]));
const median = values => { const a = values.filter(Number.isFinite).sort((x,y)=>x-y); if (!a.length) return null; const i = Math.floor(a.length/2); return a.length % 2 ? a[i] : (a[i-1]+a[i])/2; };
const percentile = (values,p) => { const a=values.filter(Number.isFinite).sort((x,y)=>x-y); return a.length ? a[Math.round((a.length-1)*p)] : null; };
async function fetchWithTimeout(url, options, ms) { const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),ms); try { return await fetch(url,{...options,signal:controller.signal}); } finally { clearTimeout(timer); } }

const PROMPT = `Analyse ces photos/captures d'une MEME annonce automobile. Recoupe toutes les images. Lis uniquement ce qui est réellement visible, n'invente rien. Information absente ou illisible = null. Signale toute contradiction. Extrais marque, modèle, version/finition, année, kilométrage, prix, énergie, boîte, puissance, vendeur, lieu, nombre de places. Relève aussi entretien, distribution/courroie, contrôle technique, historique, accident, garantie et travaux. Retourne UNIQUEMENT un objet JSON valide avec exactement : make, model, version, year, mileage_km, price_eur, energy, gearbox, power_hp, seller_type, location, title, confidence, uncertain_fields, visible_claims, warnings. confidence = 0 à 100. seller_type = professional, private ou null. uncertain_fields, visible_claims et warnings sont des tableaux de chaînes.`;

async function askGemini(model, files) {
  const body = { contents:[{ role:'user', parts:[{text:PROMPT}, ...files.map(f=>({inline_data:{mime_type:f.mimetype,data:f.buffer.toString('base64')}}))] }], generationConfig:{temperature:0,responseMimeType:'application/json',maxOutputTokens:1800} };
  const url='https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent';
  let response;
  try { response=await fetchWithTimeout(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':GEMINI_KEY},body:JSON.stringify(body)},25000); }
  catch(e) { const err=new Error(e?.name==='AbortError'?'TIMEOUT':'NETWORK'); err.status=0; throw err; }
  const raw=await response.text();
  if(!response.ok){const err=new Error('HTTP_'+response.status);err.status=response.status;err.raw=raw.slice(0,500);throw err;}
  const data=JSON.parse(raw);
  const text=(data?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
  if(!text) throw new Error('EMPTY_RESPONSE');
  try{return JSON.parse(text);}catch{const a=text.indexOf('{'),b=text.lastIndexOf('}');if(a<0||b<=a)throw new Error('BAD_JSON');return JSON.parse(text.slice(a,b+1));}
}
async function analyze(files){
  if(!GEMINI_KEY) throw new Error('NO_GEMINI_KEY');
  let last;
  for(const model of MODELS){
    for(let attempt=0;attempt<2;attempt++){
      try{const v=await askGemini(model,files);v.confidence=Math.max(0,Math.min(100,number(v.confidence)??0));for(const key of ['uncertain_fields','visible_claims','warnings'])if(!Array.isArray(v[key]))v[key]=[];v.model_used=model;return v;}
      catch(e){last=e;if(![429,500,502,503,504].includes(e.status)||attempt===1)break;await new Promise(r=>setTimeout(r,900));}
    }
  }
  throw last || new Error('GEMINI_FAILED');
}
function comparable(x,v){
  if(!same(x.make,v.make)||!same(x.model,v.model))return false;
  const year=number(v.year), itemYear=number(x.year), km=number(v.mileage_km), itemKm=number(x.mileage);
  if(year!=null&&itemYear!=null&&Math.abs(year-itemYear)>4)return false;
  if(km!=null&&itemKm!=null&&Math.abs(km-itemKm)>60000)return false;
  if(v.energy&&x.energy&&!same(v.energy,x.energy))return false;
  if(v.gearbox&&x.gearbox&&!same(v.gearbox,x.gearbox))return false;
  return number(x.price)>0;
}
async function market(v){
  if(!CARHUNT_KEY)return{ok:false,error:'Comparaison marché indisponible : clé CarHunt absente.'};
  if(!v?.make||!v?.model)return{ok:false,error:'Impossible de comparer : marque ou modèle non identifié.'};
  const query=new URLSearchParams({make:String(v.make).trim().toUpperCase(),model:String(v.model).trim().toUpperCase(),page_size:'100'});
  let response;
  try{response=await fetchWithTimeout('https://api-pro.carhunt.fr/v1/listings/search?'+query,{headers:{Authorization:'Bearer '+CARHUNT_KEY,Accept:'application/json'}},9000);}catch(e){return{ok:false,error:e?.name==='AbortError'?'Comparaison marché trop longue.':'CarHunt momentanément inaccessible.'};}
  const raw=await response.text();let data={};try{data=raw?JSON.parse(raw):{};}catch{}
  if(!response.ok)return{ok:false,error:'CarHunt a refusé la recherche (HTTP '+response.status+').'};
  const comps=(Array.isArray(data.listings)?data.listings:[]).filter(x=>comparable(x,v)).map(x=>({...x,priceNum:number(x.price)})).filter(x=>x.priceNum>0);
  const prices=comps.map(x=>x.priceNum), med=median(prices), asking=number(v.price_eur);
  if(med==null)return{ok:true,comparables:0,median:null,score:null,label:'Marché insuffisant',sample:[]};
  const gap=asking==null?null:(med-asking)/med*100;
  const score=gap==null?null:Math.max(0,Math.min(100,Math.round(50+gap*2.5)));
  const label=score==null?'Marché comparable':score>=80?'🔥 Très bonne affaire':score>=65?'👍 Prix très intéressant':score>=55?'🟢 Plutôt intéressant':score>=45?'🟡 Dans le marché':score>=35?'🟠 Plutôt cher':'🔴 Cher';
  return{ok:true,comparables:prices.length,asking,median:Math.round(med),low:Math.round(percentile(prices,.15)),high:Math.round(percentile(prices,.85)),score,label,gap_pct:gap==null?null:Math.round(gap*10)/10,gap_eur:asking==null?null:Math.round(med-asking),warning:prices.length<8?'Échantillon limité : prudence dans le verdict.':null,sample:comps.slice(0,8).map(x=>({price:x.priceNum,year:x.year,mileage:x.mileage,energy:x.energy,gearbox:x.gearbox,version:x.version,city:x.city,url:x.source_url}))};
}

app.get('/api/health',(_req,res)=>res.json({ok:true,version:VERSION,provider:'gemini',models:MODELS,gemini:Boolean(GEMINI_KEY),carhunt:Boolean(CARHUNT_KEY)}));
app.post('/api/analyze',(req,res)=>upload.array('photos',3)(req,res,async err=>{
  if(err)return res.status(400).json({ok:false,error:err.code==='LIMIT_FILE_SIZE'?'Une photo dépasse 12 Mo.':'Impossible de recevoir les photos.'});
  try{const files=req.files||[];if(!files.length)return res.status(400).json({ok:false,error:'Ajoute au moins une photo.'});console.log('POST /api/analyze',files.length);const vehicle=await analyze(files);console.log('Analyze OK',vehicle.make,vehicle.model);res.json({ok:true,vehicle});}
  catch(e){console.error('Analyze error',e.message,e.status||'',e.raw||'');let error='Analyse IA indisponible. Réessaie.';if(e.message==='NO_GEMINI_KEY')error='Gemini n’est pas configuré sur le serveur.';else if(e.message==='TIMEOUT')error='Analyse trop longue. Réessaie.';else if(e.status===404)error='Le modèle Gemini configuré n’est pas accessible avec cette clé.';else if(e.status===429)error='Gemini est momentanément très sollicité. Réessaie dans quelques secondes.';res.status(503).json({ok:false,error});}
}));
app.post('/api/market',async(req,res)=>{try{const result=await market(req.body||{});res.status(result.ok?200:503).json(result);}catch{res.status(503).json({ok:false,error:'Comparaison marché indisponible.'});}});

const HTML=`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#17212b"><title>Vaut le Coup ?</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17212b;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}.wrap{max-width:760px;margin:auto;padding:18px 12px 60px}.card{background:#fff;border:1px solid #e0e4e8;border-radius:22px;padding:20px;margin:14px 0;box-shadow:0 2px 10px #00000008}h1{font-size:36px;line-height:1.05;margin:0}h2{font-size:27px;margin:0 0 12px}.muted{color:#68737d}.picker{border:3px dashed #c8ced4;border-radius:20px;padding:22px 12px;text-align:center;min-height:150px;display:flex;flex-direction:column;justify-content:center;align-items:center}.pickbtn{display:flex;align-items:center;justify-content:center;border:0;background:#17212b;color:#fff;border-radius:14px;padding:15px 22px;font-size:18px;font-weight:850;min-height:56px;cursor:pointer;touch-action:manipulation}.fileinput{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.small{display:block;color:#7b858e;margin-top:9px}.previews{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:12px}.thumb{position:relative;aspect-ratio:1}.thumb img{width:100%;height:100%;object-fit:cover;border-radius:14px;border:1px solid #ddd}.remove{position:absolute;right:-5px;top:-5px;width:34px;height:34px;border:0;border-radius:50%;background:#17212b;color:#fff;font-size:22px;touch-action:manipulation}.btn{width:100%;border:0;border-radius:15px;padding:17px;background:#17212b;color:#fff;font-size:19px;font-weight:850;margin-top:15px;min-height:56px;touch-action:manipulation}.btn:disabled{opacity:.45}.status{display:none;margin-top:14px;padding:15px;border-radius:17px;background:#eef2f5}.status.on{display:block}.track{height:10px;background:#dce2e7;border-radius:99px;overflow:hidden;margin-top:9px}.bar{height:100%;width:0;background:#2563eb;transition:width .2s}.grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.field{background:#f6f7f8;border-radius:13px;padding:11px}.field b{font-size:12px;color:#707b84}.warn{background:#fff0d2;border-radius:15px;padding:13px;margin:9px 0}.result{padding:16px;border-radius:18px;background:#eef2f5}.score{font-size:50px;font-weight:950}.comp{padding:11px 0;border-bottom:1px solid #e1e5e8}.price{font-weight:900}.link{color:#174c7a;font-weight:700;text-decoration:none}@media(max-width:520px){h1{font-size:34px}.grid{grid-template-columns:1fr}.card{padding:18px}}</style></head><body><main class="wrap"><h1>Vaut le Coup ? ✓</h1><p class="muted">Avant d’acheter. Demande à l’IA.</p><section class="card"><h2>Analyse une annonce</h2><p>Ajoute jusqu’à 3 captures ou photos de la même annonce.</p><div class="picker"><label class="pickbtn" for="photos">📸 Ajouter une photo</label><input class="fileinput" id="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple><span class="small">JPG, PNG ou WEBP — 12 Mo max par photo — 3 photos maximum</span></div><div id="previews" class="previews"></div><div id="status" class="status"><b id="statusTitle"></b><div class="track"><div id="bar" class="bar"></div></div><div id="statusText" class="muted" style="margin-top:8px"></div></div><button id="analyze" class="btn" type="button" disabled>Analyser l’annonce</button></section><section id="analysis" class="card" hidden></section><section id="market" class="card" hidden></section></main><script>
(function(){'use strict';var input=document.getElementById('photos'),previews=document.getElementById('previews'),button=document.getElementById('analyze'),status=document.getElementById('status'),statusTitle=document.getElementById('statusTitle'),statusText=document.getElementById('statusText'),bar=document.getElementById('bar'),analysis=document.getElementById('analysis'),market=document.getElementById('market'),files=[];
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c];});}
function render(){previews.innerHTML='';files.forEach(function(file,index){var box=document.createElement('div'),img=document.createElement('img'),remove=document.createElement('button');box.className='thumb';img.src=URL.createObjectURL(file);img.alt='Photo '+(index+1);remove.className='remove';remove.type='button';remove.textContent='×';remove.onclick=function(){files.splice(index,1);render();};box.appendChild(img);box.appendChild(remove);previews.appendChild(box);});button.disabled=!files.length;}
input.addEventListener('change',function(){Array.from(input.files||[]).forEach(function(file){if(files.length<3&&/^image\\/(jpeg|png|webp)$/.test(file.type)&&file.size<=12*1024*1024)files.push(file);});input.value='';render();});
function showStatus(percent,title,text){status.classList.add('on');bar.style.width=percent+'%';statusTitle.textContent=title;statusText.textContent=text||'';}
function showAnalysis(v){var rows=[['Marque',v.make],['Modèle',v.model],['Version / finition',v.version],['Année',v.year],['Kilométrage',v.mileage_km!=null?Number(v.mileage_km).toLocaleString('fr-FR')+' km':null],['Prix',v.price_eur!=null?Number(v.price_eur).toLocaleString('fr-FR')+' €':null],['Énergie',v.energy],['Boîte',v.gearbox],['Puissance',v.power_hp!=null?v.power_hp+' ch':null],['Vendeur',v.seller_type==='professional'?'Professionnel':v.seller_type==='private'?'Particulier':null],['Lieu',v.location],['Places',v.seats||v.number_of_seats]];var html='<h2>Analyse de l’annonce</h2><div class="grid">';rows.forEach(function(row){html+='<div class="field"><b>'+esc(row[0])+'</b><br>'+esc(row[1]==null?'Non déterminé':row[1])+'</div>';});html+='</div>';if(Array.isArray(v.visible_claims)&&v.visible_claims.length)html+='<h3>Éléments visibles</h3><ul>'+v.visible_claims.map(function(x){return '<li>'+esc(x)+'</li>';}).join('')+'</ul>';if(Array.isArray(v.warnings)&&v.warnings.length)html+='<h3>⚠️ Points de vigilance</h3>'+v.warnings.map(function(x){return '<div class="warn">'+esc(x)+'</div>';}).join('');html+='<p class="muted">Confiance IA : '+esc(v.confidence)+' %</p>';analysis.innerHTML=html;analysis.hidden=false;}
function showMarket(m){var html='<h2>Comparaison marché</h2>';if(!m||!m.ok){html+='<div class="warn">'+esc(m&&m.error||'Comparaison marché indisponible.')+'</div>';market.innerHTML=html;market.hidden=false;return;}if(m.median==null){html+='<div class="result">Marché comparable insuffisant.</div>';market.innerHTML=html;market.hidden=false;return;}html+='<div class="result"><div class="score">'+esc(m.score)+'/100</div><b>'+esc(m.label)+'</b><p>Prix demandé : <b>'+esc(m.asking==null?'Non déterminé':Number(m.asking).toLocaleString('fr-FR')+' €')+'</b><br>Médiane comparable : <b>'+esc(Number(m.median).toLocaleString('fr-FR'))+' €</b><br>Fourchette : '+esc(Number(m.low).toLocaleString('fr-FR'))+' à '+esc(Number(m.high).toLocaleString('fr-FR'))+' €</p></div>';if(m.warning)html+='<div class="warn">'+esc(m.warning)+'</div>';if(Array.isArray(m.sample))m.sample.forEach(function(x){html+='<div class="comp"><span class="price">'+esc(Number(x.price).toLocaleString('fr-FR'))+' €</span> — '+esc(x.year||'')+' — '+esc(x.mileage?Number(x.mileage).toLocaleString('fr-FR')+' km':'')+' — '+esc(x.city||'');if(x.url)html+=' — <a class="link" href="'+esc(x.url)+'" target="_blank" rel="noopener">Voir</a>';html+='</div>';});market.innerHTML=html;market.hidden=false;}
button.addEventListener('click',async function(){if(!files.length)return;button.disabled=true;analysis.hidden=true;market.hidden=true;var form=new FormData();files.forEach(function(file){form.append('photos',file,file.name);});try{showStatus(25,'Analyse en cours','Envoi des photos à Gemini…');var response=await fetch('/api/analyze',{method:'POST',body:form});var data=await response.json().catch(function(){return{ok:false,error:'Réponse serveur invalide.'};});if(!response.ok||!data.ok)throw new Error(data.error||'Analyse impossible.');showAnalysis(data.vehicle);showStatus(75,'Analyse terminée','Comparaison avec le marché…');var marketResponse=await fetch('/api/market',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data.vehicle)});var marketData=await marketResponse.json().catch(function(){return{ok:false,error:'Réponse marché invalide.'};});showMarket(marketData);showStatus(100,'Terminé','Analyse et comparaison terminées.');}catch(error){showStatus(100,'Impossible de terminer',error.message||'Erreur réseau.');}finally{button.disabled=!files.length;}});render();})();
</script></body></html>`;
app.get('/',(_req,res)=>res.type('html').send(HTML));
app.listen(PORT,()=>console.log('Vaut le Coup ? — '+VERSION+' — '+PORT));
