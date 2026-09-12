import express from 'express';
import multer from 'multer';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const CARHUNT_KEY = process.env.CARHUNT_API_KEY || '';
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 3, fileSize: 12 * 1024 * 1024 } });
app.use(express.json({ limit: '1mb' }));

const n = v => { const x = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(x) ? x : null; };
const norm = v => String(v ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const same = (a,b) => { a=norm(a); b=norm(b); return !!a && !!b && (a===b || a.includes(b) || b.includes(a)); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const money = v => v == null ? 'Non déterminé' : Math.round(v).toLocaleString('fr-FR') + ' €';
const median = a => { a=[...a].filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length)return null; const i=Math.floor(a.length/2); return a.length%2?a[i]:(a[i-1]+a[i])/2; };
const pct = (a,p) => { a=[...a].filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length)return null; return a[Math.min(a.length-1,Math.max(0,Math.round((a.length-1)*p)))]; };

async function timeoutFetch(url, options, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, {...options, signal:c.signal}); } finally { clearTimeout(t); }
}

async function analyze(files) {
  if (!GEMINI_KEY) throw new Error('Gemini non configuré');
  const prompt = `Analyse ces captures/photos d'une MEME annonce automobile pour Vaut le Coup ?. Recoupe toutes les images. Lis uniquement ce qui est réellement visible et n'invente rien. Donnée absente ou illisible = null. Si deux images se contredisent, signale la contradiction dans warnings. Extrais marque, modèle, version/finition, année, kilométrage, prix, énergie, boîte, puissance, vendeur, lieu. Recopie aussi entretien, distribution, contrôle technique, historique, accident, garantie, travaux, nombre de places et incohérences. Retourne UNIQUEMENT un JSON valide avec exactement ces clés: make, model, version, year, mileage_km, price_eur, energy, gearbox, power_hp, seller_type, location, title, confidence, uncertain_fields, visible_claims, warnings. confidence est 0-100. seller_type vaut professional, private ou null. Les trois derniers champs sont des tableaux de chaînes.`;
  const body = { contents:[{role:'user',parts:[{text:prompt},...files.map(f=>({inline_data:{mime_type:f.mimetype,data:f.buffer.toString('base64')}}))]}], generationConfig:{temperature:0,responseMimeType:'application/json',maxOutputTokens:1400} };
  const r = await timeoutFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}, 15000);
  const raw = await r.text(); if(!r.ok) throw new Error(`Gemini HTTP ${r.status}`);
  let d; try { d=JSON.parse(raw); } catch { throw new Error('Réponse Gemini invalide'); }
  const text=(d?.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('').trim(); if(!text) throw new Error('Gemini n’a retourné aucun résultat');
  let v; try { v=JSON.parse(text); } catch { const a=text.indexOf('{'),b=text.lastIndexOf('}'); if(a<0||b<=a)throw new Error('JSON Gemini invalide'); v=JSON.parse(text.slice(a,b+1)); }
  v.confidence=Math.max(0,Math.min(100,n(v.confidence)??0));
  for(const k of ['uncertain_fields','visible_claims','warnings']) if(!Array.isArray(v[k])) v[k]=[];
  return v;
}

function comparable(x,v) {
  if(!same(x.make,v.make)||!same(x.model,v.model))return false;
  const y=n(v.year), xy=n(x.year), km=n(v.mileage_km), xkm=n(x.mileage);
  if(y!=null&&xy!=null&&Math.abs(y-xy)>4)return false;
  if(km!=null&&xkm!=null&&Math.abs(km-xkm)>60000)return false;
  if(v.energy&&x.energy&&!same(v.energy,x.energy))return false;
  if(v.gearbox&&x.gearbox&&!same(v.gearbox,x.gearbox))return false;
  return n(x.price)>0;
}

async function market(v) {
  if(!CARHUNT_KEY)return {ok:false,error:'Comparaison marché indisponible : clé CarHunt absente.'};
  if(!v?.make||!v?.model)return {ok:false,error:'Impossible de comparer : marque ou modèle non identifié.'};
  const params=new URLSearchParams({make:String(v.make).trim().toUpperCase(),model:String(v.model).trim().toUpperCase(),page_size:'100'});
  let r;
  try { r=await timeoutFetch(`https://api-pro.carhunt.fr/v1/listings/search?${params}`,{headers:{Authorization:`Bearer ${CARHUNT_KEY}`,Accept:'application/json'}},7000); }
  catch(e) { return {ok:false,error:e?.name==='AbortError'?'Comparaison marché trop longue.':'CarHunt momentanément inaccessible.'}; }
  const raw=await r.text(); let data={}; try{data=raw?JSON.parse(raw):{}}catch{}
  if(!r.ok){console.error('CarHunt',r.status,raw.slice(0,500));return {ok:false,error:`CarHunt a refusé la recherche (HTTP ${r.status}).`};}
  const listings=Array.isArray(data.listings)?data.listings:[];
  const comps=listings.filter(x=>comparable(x,v)).map(x=>({...x,p:n(x.price)})).filter(x=>x.p>0);
  const prices=comps.map(x=>x.p), med=median(prices), ask=n(v.price_eur);
  if(med==null)return {ok:true,comparables:0,asking:money(ask),median:null,score:null,label:'Marché insuffisant',sample:[]};
  const gap=ask==null?null:(med-ask)/med*100;
  const score=gap==null?null:Math.max(0,Math.min(100,Math.round(50+gap*2.5)));
  const label=score==null?'Marché comparable':score>=80?'🔥 Très bonne affaire':score>=65?'👍 Prix très intéressant':score>=55?'🟢 Plutôt intéressant':score>=45?'🟡 Dans le marché':score>=35?'🟠 Plutôt cher':'🔴 Cher';
  return {ok:true,comparables:prices.length,asking:money(ask),median:Math.round(med),low:Math.round(pct(prices,.15)),high:Math.round(pct(prices,.85)),score,label,gap_pct:gap==null?null:Math.round(gap*10)/10,gap_eur:ask==null?null:Math.round(med-ask),warning:prices.length<8?'Échantillon limité : prudence dans le verdict.':null,sample:comps.slice(0,8).map(x=>({price:x.p,year:x.year,mileage:x.mileage,energy:x.energy,gearbox:x.gearbox,horsepower:x.horsepower,version:x.version,seller_type:x.seller_type,city:x.city,source:x.source,url:x.source_url}))};
}

app.get('/api/health',(_req,res)=>res.json({ok:true,provider:'gemini',model:GEMINI_MODEL,gemini:Boolean(GEMINI_KEY),carhunt:Boolean(CARHUNT_KEY)}));
app.post('/api/analyze',(req,res)=>{upload.array('photos',3)(req,res,async err=>{if(err){console.error('Upload',err);return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'Une photo dépasse 12 Mo.':'Impossible de recevoir les photos.'});}try{const files=req.files||[];if(!files.length)return res.status(400).json({error:'Ajoute au moins une photo.'});const vehicle=await analyze(files);return res.json({ok:true,vehicle,photos:files.length});}catch(e){console.error('Analyze',e);return res.status(503).json({error:e?.name==='AbortError'?'Analyse trop longue. Réessaie avec 1 à 3 captures.':'Analyse IA indisponible. Réessaie.'});}});});
app.post('/api/market',async(req,res)=>{try{const out=await market(req.body||{});return res.status(out.ok?200:503).json(out);}catch(e){console.error('Market',e);return res.status(503).json({ok:false,error:'Comparaison marché indisponible.'});}});

const HTML=`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Vaut le Coup ?</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17212b;font-family:system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:760px;margin:auto;padding:18px 12px 60px}.card{background:#fff;border:1px solid #e0e4e8;border-radius:24px;padding:20px;margin:14px 0;box-shadow:0 2px 10px #00000008}h1{font-size:38px;line-height:1.05;margin:0}h2{font-size:29px;margin:0 0 12px}.muted{color:#68737d}.picker{position:relative;border:3px dashed #c8ced4;border-radius:20px;padding:28px 12px;text-align:center;min-height:155px;display:flex;flex-direction:column;justify-content:center;align-items:center;overflow:hidden;cursor:pointer}.picker input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font-size:30px}.picker strong{font-size:22px}.small{display:block;color:#7b858e;margin-top:8px}.previews{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:12px}.thumb{position:relative;aspect-ratio:1}.thumb img{width:100%;height:100%;object-fit:cover;border-radius:14px;border:1px solid #ddd}.remove{position:absolute;right:-5px;top:-5px;width:34px;height:34px;border:0;border-radius:50%;background:#17212b;color:#fff;font-size:22px}.btn{width:100%;border:0;border-radius:16px;padding:17px;background:#17212b;color:#fff;font-size:19px;font-weight:850;margin-top:15px;min-height:56px}.btn:disabled{opacity:.45}.status{display:none;margin-top:14px;padding:15px;border-radius:17px;background:#eef2f5}.status.on{display:block}.track{height:10px;background:#dce2e7;border-radius:99px;overflow:hidden;margin-top:9px}.bar{height:100%;width:0;background:#2563eb;transition:width .25s}.grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.field{background:#f6f7f8;border-radius:13px;padding:11px}.field b{font-size:12px;color:#707b84}.pill{display:inline-block;background:#e9edf1;border-radius:99px;padding:6px 9px;margin:3px}.warn{background:#fff0d2;border-radius:15px;padding:13px;margin:9px 0}.result{padding:16px;border-radius:18px;background:#eef2f5}.score{font-size:52px;font-weight:950}.comp{padding:11px 0;border-bottom:1px solid #e1e5e8}.price{font-weight:900}.link{color:#174c7a;font-weight:700;text-decoration:none}@media(max-width:520px){h1{font-size:34px}.grid{grid-template-columns:1fr}.card{padding:18px}.previews{gap:7px}}
</style></head><body><main class="wrap"><h1>Vaut le Coup ? ✓</h1><p class="muted">Avant d’acheter. Demande à l’IA.</p><section class="card"><h2>Analyse une annonce</h2><p>Ajoute jusqu’à 3 captures/photos de la même annonce.</p><label class="picker"><input id="photos" type="file" accept="image/*" multiple><div style="font-size:32px">📸</div><strong>Ajouter une capture ou une photo</strong><span class="small">JPG, PNG, WEBP — 12 Mo max — 3 photos</span></label><div id="previews" class="previews"></div><div id="status" class="status"><b id="statusTitle"></b><div class="track"><div id="bar" class="bar"></div></div><div id="statusText" class="muted" style="margin-top:8px"></div></div><button id="analyze" class="btn" disabled>Analyser l’annonce</button></section><section id="analysis" class="card" hidden></section><section id="market" class="card" hidden></section></main><script>
const input=document.getElementById('photos'),previews=document.getElementById('previews'),analyze=document.getElementById('analyze'),status=document.getElementById('status'),statusTitle=document.getElementById('statusTitle'),statusText=document.getElementById('statusText'),bar=document.getElementById('bar'),analysis=document.getElementById('analysis'),marketBox=document.getElementById('market');let files=[],busy=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));const euro=v=>v==null?'Non déterminé':Number(v).toLocaleString('fr-FR')+' €';const km=v=>v==null?'Non déterminé':Number(v).toLocaleString('fr-FR')+' km';
function renderPhotos(){previews.innerHTML='';files.forEach((file,index)=>{const box=document.createElement('div'),img=document.createElement('img'),remove=document.createElement('button');box.className='thumb';img.alt='Capture '+(index+1);img.src=URL.createObjectURL(file);remove.className='remove';remove.type='button';remove.textContent='×';remove.onclick=()=>{files.splice(index,1);renderPhotos()};box.append(img,remove);previews.append(box)});analyze.disabled=files.length===0||busy;}
input.addEventListener('change',()=>{for(const file of Array.from(input.files||[])){if(files.length>=3)break;if(!/^image\/(jpeg|png|webp)$/.test(file.type))continue;if(file.size>12*1024*1024)continue;files.push(file)}input.value='';renderPhotos()});
function setStatus(p,t,m){status.classList.add('on');bar.style.width=p+'%';statusTitle.textContent=t;statusText.textContent=m||'';}
function field(k,v){return '<div class="field"><b>'+esc(k)+'</b><br>'+esc(v==null?'Non déterminé':v)+'</div>';}
function showAnalysis(v){analysis.hidden=false;let h='<h2>Ce que l’IA a lu</h2><div class="grid">';h+=field('Marque',v.make)+field('Modèle',v.model)+field('Version',v.version)+field('Année',v.year)+field('Kilométrage',v.mileage_km==null?null:Number(v.mileage_km).toLocaleString('fr-FR')+' km')+field('Prix',v.price_eur==null?null:Number(v.price_eur).toLocaleString('fr-FR')+' €')+field('Énergie',v.energy)+field('Boîte',v.gearbox)+field('Puissance',v.power_hp==null?null:v.power_hp+' ch')+field('Vendeur',v.seller_type==='professional'?'Professionnel':v.seller_type==='private'?'Particulier':null)+field('Lieu',v.location)+'</div><p><b>Confiance de lecture :</b> '+esc(v.confidence)+'/100</p>';for(const item of [...(v.uncertain_fields||[]).map(x=>'À vérifier : '+x),...(v.warnings||[])])h+='<div class="warn">⚠️ '+esc(item)+'</div>';if((v.visible_claims||[]).length){h+='<h3>Éléments visibles</h3>';for(const item of v.visible_claims)h+='<span class="pill">'+esc(item)+'</span>'}analysis.innerHTML=h;}
function showMarket(m){marketBox.hidden=false;if(!m.ok){marketBox.innerHTML='<h2>Est-ce que ça vaut le coup ?</h2><div class="warn">⚠️ '+esc(m.error||'Comparaison indisponible.')+'</div>';return}if(!m.comparables){marketBox.innerHTML='<h2>Est-ce que ça vaut le coup ?</h2><div class="warn">⚠️ Pas assez de véhicules comparables pour donner un verdict fiable.</div>';return}let h='<h2>Est-ce que ça vaut le coup ?</h2><div class="result"><div class="score">'+esc(m.score??'—')+'/100</div><h3>'+esc(m.label)+'</h3><p><b>Prix demandé :</b> '+esc(m.asking)+'<br><b>Médiane du marché :</b> '+esc(euro(m.median))+'<br><b>Fourchette :</b> '+esc(euro(m.low))+' – '+esc(euro(m.high))+'<br><b>Comparables :</b> '+esc(m.comparables)+'</p>';if(m.gap_pct!=null)h+='<p><b>Écart au marché :</b> '+(m.gap_pct>0?'+':'')+esc(m.gap_pct)+' % ('+esc(euro(m.gap_eur))+')</p>';if(m.warning)h+='<div class="warn">⚠️ '+esc(m.warning)+'</div>';h+='</div><h3>Annonces comparables</h3>';for(const x of (m.sample||[]))h+='<div class="comp"><span class="price">'+esc(euro(x.price))+'</span> · '+esc(x.year??'?')+' · '+esc(km(x.mileage))+'<br>'+esc(x.version||'Version non précisée')+(x.city?' · '+esc(x.city):'')+(x.url?' · <a class="link" href="'+esc(x.url)+'" target="_blank" rel="noopener">Voir</a>':'')+'</div>';marketBox.innerHTML=h;}
async function run(){if(busy||!files.length)return;busy=true;analyze.disabled=true;analysis.hidden=true;marketBox.hidden=true;setStatus(8,'Préparation…',files.length+' photo'+(files.length>1?'s':'')+' prête'+(files.length>1?'s':'')+'.');const form=new FormData();files.forEach(f=>form.append('photos',f,f.name));try{setStatus(20,'Lecture des captures…','Identification de la voiture par Gemini.');const r=await fetch('/api/analyze',{method:'POST',body:form});const d=await r.json().catch(()=>({error:'Réponse serveur invalide.'}));if(!r.ok||!d.ok)throw new Error(d.error||'Analyse impossible.');showAnalysis(d.vehicle);setStatus(70,'Comparaison du marché…','Recherche de véhicules réellement comparables.');const mr=await fetch('/api/market',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d.vehicle)});const md=await mr.json().catch(()=>({ok:false,error:'Réponse marché invalide.'}));showMarket(md);setStatus(100,'Terminé','Analyse et comparaison terminées.');}catch(e){setStatus(100,'Impossible de terminer',e.message||'Une erreur est survenue.');}finally{busy=false;analyze.disabled=files.length===0;}}
analyze.addEventListener('click',run);renderPhotos();
</script></body></html>`;

app.get('/',(_req,res)=>res.type('html').send(HTML));
app.listen(PORT,'0.0.0.0',()=>console.log(`Vaut le Coup ? — ${PORT} — Gemini ${GEMINI_MODEL}`));
