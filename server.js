import express from 'express';
import multer from 'multer';

const app=express();
const PORT=Number(process.env.PORT||10000);
const GEMINI_KEY=process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY||'';
const GEMINI_MODEL=process.env.GEMINI_MODEL||'gemini-2.5-flash-lite';
const CARHUNT_KEY=process.env.CARHUNT_API_KEY||'';
const upload=multer({storage:multer.memoryStorage(),limits:{files:3,fileSize:12*1024*1024}});
app.use(express.json({limit:'1mb'}));

const n=v=>{const x=Number(String(v??'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const norm=v=>String(v??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const same=(a,b)=>{a=norm(a);b=norm(b);return !!a&&!!b&&(a===b||a.includes(b)||b.includes(a));};
const median=a=>{a=[...a].sort((x,y)=>x-y);if(!a.length)return null;const i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2};
const q=a=>{a=[...a].sort((x,y)=>x-y);if(!a.length)return null;return a[Math.max(0,Math.floor((a.length-1)*.15))]};
const hi=a=>{a=[...a].sort((x,y)=>x-y);if(!a.length)return null;return a[Math.min(a.length-1,Math.ceil((a.length-1)*.85))]};
const money=v=>v==null?'Non déterminé':Math.round(v).toLocaleString('fr-FR')+' €';

async function withTimeout(url,opts,ms){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{return await fetch(url,{...opts,signal:c.signal})}finally{clearTimeout(t)}}

async function analyze(files){
 if(!GEMINI_KEY)throw new Error('Gemini non configuré');
 const prompt=`Tu es le moteur d'analyse de l'application Vaut le Coup ?. Ces images sont des captures/photos de LA MEME annonce automobile. Recoupe-les avant de répondre. Lis uniquement les informations réellement visibles. N'invente jamais une donnée absente. Si une donnée est contradictoire entre deux images, conserve la valeur la plus explicitement affichée et ajoute une alerte dans warnings. Extrais en priorité marque, modèle, version/finition, année, kilométrage, prix, énergie, boîte, puissance, vendeur, lieu. Recopie aussi les éléments importants visibles: entretien, distribution, contrôle technique, historique, accident, garantie, travaux, nombre de places et incohérences. Retourne UNIQUEMENT un JSON valide avec exactement ces clés: make, model, version, year, mileage_km, price_eur, energy, gearbox, power_hp, seller_type, location, title, confidence, uncertain_fields, visible_claims, warnings. Les champs inconnus valent null. confidence est 0-100. seller_type vaut professional, private ou null. Les trois derniers champs sont des tableaux de chaînes.`;
 const body={contents:[{role:'user',parts:[{text:prompt},...files.map(f=>({inline_data:{mime_type:f.mimetype,data:f.buffer.toString('base64')}}))]}],generationConfig:{temperature:0,responseMimeType:'application/json',maxOutputTokens:1400}};
 const r=await withTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},18000);
 const raw=await r.text();if(!r.ok)throw new Error(`Gemini HTTP ${r.status}`);
 let d;try{d=JSON.parse(raw)}catch{throw new Error('Réponse Gemini invalide')}
 const text=(d?.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('');
 if(!text)throw new Error('Gemini n’a retourné aucun résultat');
 let v;try{v=JSON.parse(text)}catch{const a=text.indexOf('{'),b=text.lastIndexOf('}');if(a<0||b<=a)throw new Error('JSON Gemini invalide');v=JSON.parse(text.slice(a,b+1))}
 v.confidence=Math.max(0,Math.min(100,n(v.confidence)??0));
 for(const k of ['uncertain_fields','visible_claims','warnings'])if(!Array.isArray(v[k]))v[k]=[];
 return v;
}

function comparable(x,v){
 if(!same(x.make,v.make)||!same(x.model,v.model))return false;
 const y=n(v.year),xy=n(x.year),km=n(v.mileage_km),xkm=n(x.mileage);
 if(y!=null&&xy!=null&&Math.abs(y-xy)>4)return false;
 if(km!=null&&xkm!=null&&Math.abs(km-xkm)>50000)return false;
 if(v.energy&&x.energy&&!same(v.energy,x.energy))return false;
 if(v.gearbox&&x.gearbox&&!same(v.gearbox,x.gearbox))return false;
 return n(x.price)>0;
}

async function market(v){
 if(!CARHUNT_KEY)return {ok:false,error:'Comparaison marché indisponible : clé CarHunt absente.'};
 if(!v?.make||!v?.model)return {ok:false,error:'Comparaison marché impossible : marque ou modèle non identifié.'};
 const params=new URLSearchParams({make:String(v.make).trim().toUpperCase(),model:String(v.model).trim().toUpperCase(),page_size:'100'});
 let r,raw='';
 try{r=await withTimeout(`https://api-pro.carhunt.fr/v1/listings/search?${params}`,{headers:{Authorization:`Bearer ${CARHUNT_KEY}`,Accept:'application/json'}},9000);raw=await r.text();}
 catch(e){return {ok:false,error:e.name==='AbortError'?'Comparaison marché trop longue (9 s).':'CarHunt momentanément inaccessible.'}}
 let data={};try{data=raw?JSON.parse(raw):{}}catch{}
 if(!r.ok){console.error('CarHunt',r.status,raw.slice(0,400));return {ok:false,error:`CarHunt a refusé la recherche (HTTP ${r.status}).`};}
 const all=Array.isArray(data.listings)?data.listings:[];
 const comps=all.filter(x=>comparable(x,v)).map(x=>({...x,p:n(x.price)})).filter(x=>x.p>0);
 const prices=comps.map(x=>x.p),med=median(prices),ask=n(v.price_eur);
 if(!med)return {ok:true,comparables:0,asking:money(ask),median:null,score:null,label:'Marché insuffisant',sample:[]};
 const gap=ask!=null?(med-ask)/med*100:null;
 const score=gap==null?null:Math.max(0,Math.min(100,Math.round(50+gap*2.5)));
 const label=score==null?'Marché comparable':score>=80?'🔥 Très bonne affaire':score>=65?'👍 Prix très intéressant':score>=55?'🟢 Plutôt intéressant':score>=45?'🟡 Dans le marché':score>=35?'🟠 Plutôt cher':'🔴 Cher';
 return {ok:true,comparables:prices.length,asking:money(ask),median:Math.round(med),low:Math.round(q(prices)),high:Math.round(hi(prices)),score,label,gap_pct:gap==null?null:Math.round(gap*10)/10,gap_eur:ask==null?null:Math.round(med-ask),warning:prices.length<8?'Échantillon limité : prudence dans le verdict.':null,sample:comps.slice(0,8).map(x=>({price:x.p,year:x.year,mileage:x.mileage,energy:x.energy,gearbox:x.gearbox,version:x.version,seller_type:x.seller_type,city:x.city,source:x.source,url:x.source_url}))};
}

app.get('/api/health',(_req,res)=>res.json({ok:true,provider:'gemini',model:GEMINI_MODEL,gemini:Boolean(GEMINI_KEY),carhunt:Boolean(CARHUNT_KEY)}));
app.post('/api/analyze',upload.array('photos',3),async(req,res)=>{try{const files=req.files||[];if(!files.length)return res.status(400).json({error:'Ajoute au moins une photo.'});const vehicle=await analyze(files);res.json({ok:true,vehicle,photos:files.length});}catch(e){console.error('Analyze',e);res.status(503).json({error:'Analyse IA indisponible. Réessaie.'});}});
app.post('/api/market',async(req,res)=>{try{const out=await market(req.body||{});res.status(out.ok?200:503).json(out);}catch(e){console.error('Market',e);res.status(503).json({ok:false,error:'Comparaison marché indisponible.'});}});

const HTML=`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vaut le Coup ?</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17212b;font-family:system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:760px;margin:auto;padding:20px 12px 60px}.card{background:#fff;border:1px solid #e0e4e8;border-radius:24px;padding:20px;margin:14px 0}h1{font-size:38px;margin:0}h2{font-size:29px;margin:0 0 12px}.muted{color:#68737d}.drop{display:block;border:3px dashed #c8ced4;border-radius:20px;padding:28px 12px;text-align:center;cursor:pointer}.drop strong{font-size:22px}.small{display:block;color:#7b858e;margin-top:8px}#file{display:none}.previews{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:12px}.thumb{position:relative;aspect-ratio:1}.thumb img{width:100%;height:100%;object-fit:cover;border-radius:14px}.x{position:absolute;right:-5px;top:-5px;width:34px;height:34px;border:0;border-radius:50%;background:#17212b;color:#fff;font-size:22px}.btn{width:100%;border:0;border-radius:16px;padding:17px;background:#17212b;color:#fff;font-size:19px;font-weight:850;margin-top:15px}.btn:disabled{opacity:.45}.status{display:none;margin-top:14px;padding:15px;border-radius:17px;background:#eef2f5}.status.on{display:block}.track{height:10px;background:#dce2e7;border-radius:99px;overflow:hidden;margin-top:9px}.bar{height:100%;width:0;background:#2563eb;transition:width .25s}.grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.field{background:#f6f7f8;border-radius:13px;padding:11px}.field b{font-size:12px;color:#707b84}.pill{display:inline-block;background:#e9edf1;border-radius:99px;padding:6px 9px;margin:3px}.warn{background:#fff0d2;border-radius:15px;padding:13px;margin:9px 0}.good{background:#e5f6eb;border-radius:17px;padding:16px}.bad{background:#ffe7e4;border-radius:17px;padding:16px}.score{font-size:52px;font-weight:950}.comp{padding:11px 0;border-bottom:1px solid #e1e5e8}.price{font-weight:900}@media(max-width:520px){h1{font-size:34px}.grid{grid-template-columns:1fr}.card{padding:18px}}
</style></head><body><main class="wrap"><h1>Vaut le Coup ? ✓</h1><p class="muted">Avant d’acheter. Demande à l’IA.</p><section class="card"><h2>Analyse une annonce</h2><p>Ajoute jusqu’à 3 captures/photos de la même annonce.</p><label class="drop" for="file">📸<br><strong>Ajouter une capture ou une photo</strong><span class="small">JPG, PNG, WEBP — 12 Mo max — 3 photos</span></label><input id="file" type="file" accept="image/jpeg,image/png,image/webp" multiple><div id="previews" class="previews"></div><div id="status" class="status"><b id="st"></b><div class="track"><div id="bar" class="bar"></div></div><div id="note" class="muted"></div></div><button id="go" class="btn" disabled>Analyser l’annonce</button></section><section id="analysis" class="card" hidden></section><section id="market" class="card" hidden></section></main><script>
const $=id=>document.getElementById(id),input=$("file"),pre=$("previews"),go=$("go"),status=$("status"),st=$("st"),bar=$("bar"),note=$("note"),analysis=$("analysis"),marketBox=$("market");let files=[],vehicle=null,busy=false;
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
function render(){pre.innerHTML="";files.forEach((f,i)=>{const d=document.createElement("div"),img=document.createElement("img"),b=document.createElement("button");d.className="thumb";img.src=URL.createObjectURL(f);b.className="x";b.type="button";b.dataset.i=i;b.textContent="×";d.append(img,b);pre.append(d)});go.disabled=!files.length||busy}
input.onchange=()=>{files=files.concat(Array.from(input.files||[])).slice(0,3);input.value="";render()};
pre.onclick=e=>{const b=e.target.closest("button.x");if(b){files.splice(Number(b.dataset.i),1);render()}};
function progress(p,t,m){status.classList.add("on");bar.style.width=p+"%";st.textContent=t;note.textContent=m||""}
function field(k,v){return "<div class=\"field\"><b>"+esc(k)+"</b><br>"+esc(v==null?"Non déterminé":v)+"</div>"}
function showAnalysis(v){analysis.hidden=false;let h="<h2>Ce que l’IA a lu</h2><div class=\"grid\">";h+=field("Marque",v.make)+field("Modèle",v.model)+field("Version",v.version)+field("Année",v.year)+field("Kilométrage",v.mileage_km!=null?Number(v.mileage_km).toLocaleString('fr-FR')+" km":null)+field("Prix",v.price_eur!=null?Number(v.price_eur).toLocaleString('fr-FR')+" €":null)+field("Énergie",v.energy)+field("Boîte",v.gearbox)+field("Puissance",v.power_hp!=null?v.power_hp+" ch":null)+field("Vendeur",v.seller_type==='professional'?"Professionnel":v.seller_type==='private'?"Particulier":null)+field("Lieu",v.location)+"</div><p><b>Confiance de lecture :</b> "+esc(v.confidence)+"/100</p>";[...(v.uncertain_fields||[]).map(x=>"À vérifier : "+x),...(v.warnings||[]).map(x=>x)].forEach(x=>h+="<div class=\"warn\">⚠️ "+esc(x)+"</div>");if((v.visible_claims||[]).length){h+="<h3>Éléments visibles</h3>";v.visible_claims.forEach(x=>h+="<span class=\"pill\">"+esc(x)+"</span>")}analysis.innerHTML=h}
function showMarket(m){marketBox.hidden=false;if(!m.ok){marketBox.innerHTML="<h2>Est-ce que ça vaut le coup ?</h2><div class=\"warn\">⚠️ "+esc(m.error||"Comparaison indisponible.")+"</div><button id=\"retry\" class=\"btn\">Réessayer la comparaison</button>";$("retry").onclick=runMarket;return}if(!m.median){marketBox.innerHTML="<h2>Est-ce que ça vaut le coup ?</h2><div class=\"warn\">Marché insuffisant : pas assez de comparables fiables.</div>";return}const tone=m.score>=55?"good":"bad";let h="<h2>Est-ce que ça vaut le coup ?</h2><div class=\""+tone+"\"><div class=\"score\">"+esc(m.score)+"/100</div><h3>"+esc(m.label)+"</h3><b>Prix demandé : "+esc(m.asking)+"</b><br>Médiane du marché : <b>"+Number(m.median).toLocaleString('fr-FR')+" €</b><br>Fourchette : "+Number(m.low).toLocaleString('fr-FR')+" – "+Number(m.high).toLocaleString('fr-FR')+" €<br><span class=\"muted\">"+(m.gap_pct>=0?"Sous":"Au-dessus")+" du marché de "+Math.abs(m.gap_pct).toFixed(1)+" % ("+Math.abs(m.gap_eur).toLocaleString('fr-FR')+" €).</span></div>";if(m.warning)h+="<div class=\"warn\">⚠️ "+esc(m.warning)+"</div>";h+="<h3>Comparables utilisés ("+esc(m.comparables)+")</h3>";(m.sample||[]).forEach(x=>h+="<div class=\"comp\"><span class=\"price\">"+Number(x.price).toLocaleString('fr-FR')+" €</span> · "+esc(x.year||"?")+" · "+(x.mileage?Number(x.mileage).toLocaleString('fr-FR')+" km":"km ?")+"<br><span class=\"muted\">"+esc(x.source||"Source inconnue")+(x.city?" · "+esc(x.city):"")+"</span></div>");marketBox.innerHTML=h}
async function runMarket(){if(!vehicle?.make||!vehicle?.model){showMarket({ok:false,error:"La marque ou le modèle n’a pas été reconnu par l’IA."});return}marketBox.hidden=false;marketBox.innerHTML="<h2>Est-ce que ça vaut le coup ?</h2><div class=\"status on\">🔎 Comparaison du marché…</div>";try{const r=await fetch("/api/market",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(vehicle)});let m={};try{m=await r.json()}catch{m={ok:false,error:"Réponse CarHunt invalide."}}showMarket(m)}catch(e){showMarket({ok:false,error:"Impossible de joindre le comparateur marché."})}}
go.onclick=async()=>{if(busy)return;busy=true;go.disabled=true;analysis.hidden=true;marketBox.hidden=true;progress(8,"Préparation…",files.length+" photo(s)");try{const fd=new FormData();files.forEach(f=>fd.append("photos",f));progress(20,"Lecture des captures…","Gemini analyse les 3 images ensemble");const r=await fetch("/api/analyze",{method:"POST",body:fd});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j.error||"Analyse indisponible.");vehicle=j.vehicle;showAnalysis(vehicle);progress(65,"Comparaison marché…","Recherche de véhicules réellement comparables");await runMarket();progress(100,"Analyse terminée","Résultat prêt");setTimeout(()=>status.classList.remove("on"),500)}catch(e){progress(100,"Échec",e.message)}finally{busy=false;go.disabled=!files.length}};
</script></body></html>`;
app.get('/',(_req,res)=>res.type('html').send(HTML));
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Erreur serveur.'})});
app.listen(PORT,'0.0.0.0',()=>console.log(`Vaut le Coup ? — ${PORT} — Gemini ${GEMINI_MODEL}`));
