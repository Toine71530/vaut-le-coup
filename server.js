import express from "express";
import multer from "multer";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const CARHUNT_KEY = process.env.CARHUNT_API_KEY || "";
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 3, fileSize: 12 * 1024 * 1024 } });

const n = v => { const x = Number(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return Number.isFinite(x) ? x : null; };
const norm = v => String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const same = (a,b) => !a || !b || norm(a).includes(norm(b)) || norm(b).includes(norm(a));
const euro = v => v == null ? "Non déterminé" : Math.round(v).toLocaleString("fr-FR") + " €";
const median = a => { const x=[...a].sort((a,b)=>a-b); if(!x.length)return null; const i=Math.floor(x.length/2); return x.length%2?x[i]:(x[i-1]+x[i])/2; };
const quantile = (a,p) => { const x=[...a].sort((a,b)=>a-b); if(!x.length)return null; const i=(x.length-1)*p,l=Math.floor(i),h=Math.ceil(i); return x[l]+(x[h]-x[l])*(i-l); };
const sleep = ms => new Promise(r=>setTimeout(r,ms));

function parseJson(text) { const s=String(text||"").replace(/^```json\s*/i,"").replace(/```\s*$/i,"").trim(),a=s.indexOf("{"),b=s.lastIndexOf("}"); if(a<0||b<=a)throw new Error("Réponse IA invalide"); return JSON.parse(s.slice(a,b+1)); }

async function gemini(files) {
  if(!GEMINI_KEY) throw new Error("Le moteur Gemini n'est pas configuré.");
  const prompt=`Analyse ces captures/photos d'une même annonce automobile. Recoupe toutes les informations visibles. N'invente rien : donnée illisible = null. En cas de contradiction, garde la donnée la plus explicitement affichée et ajoute une alerte. Ne déduis pas le vendeur, la finition ou une caractéristique non visible. Retourne uniquement ce JSON : {"make":string|null,"model":string|null,"version":string|null,"year":number|null,"mileage_km":number|null,"price_eur":number|null,"energy":string|null,"gearbox":string|null,"power_hp":number|null,"seller_type":"professional"|"private"|null,"location":string|null,"confidence":number,"uncertain_fields":string[],"visible_claims":string[],"warnings":string[]}`;
  const parts=[{text:prompt},...files.map(f=>({inline_data:{mime_type:f.mimetype,data:f.buffer.toString("base64")}}))];
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts}],generationConfig:{responseMimeType:"application/json",temperature:0.1}})});
      const raw=await r.text();
      if(!r.ok){const e=new Error(`Gemini HTTP ${r.status}`);e.status=r.status;e.detail=raw.slice(0,500);throw e;}
      const d=JSON.parse(raw),text=(d?.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join("");
      if(!text)throw new Error("Gemini n'a retourné aucun résultat.");
      return parseJson(text);
    } catch(e) { if(attempt===0&&[429,500,502,503,504].includes(e.status)){await sleep(700);continue;} throw e; }
  }
}

function compatible(x,v) {
  if(norm(x.make)!==norm(v.make)||norm(x.model)!==norm(v.model))return false;
  const y=n(v.year),iy=n(x.year),km=n(v.mileage_km),ik=n(x.mileage);
  if(y!=null&&iy!=null&&Math.abs(y-iy)>3)return false;
  if(km!=null&&ik!=null&&Math.abs(km-ik)>30000)return false;
  if(v.energy&&x.energy&&!same(v.energy,x.energy))return false;
  if(v.gearbox&&x.gearbox&&!same(v.gearbox,x.gearbox))return false;
  return n(x.price)>0;
}

async function carhunt(v) {
  if(!CARHUNT_KEY)return {ok:false,user_message:"Comparaison marché indisponible : CarHunt n'est pas configuré."};
  if(!v?.make||!v?.model)return {ok:false,user_message:"Impossible de comparer : marque ou modèle non identifié."};
  // CarHunt : requête volontairement minimale. Les critères véhicule sont filtrés localement pour éviter les 422 des filtres optionnels.
  const qs=new URLSearchParams({make:String(v.make).trim().toUpperCase(),model:String(v.model).trim().toUpperCase(),page_size:"100"});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try {
    const r=await fetch(`https://api-pro.carhunt.fr/v1/listings/search?${qs.toString()}`,{headers:{Authorization:`Bearer ${CARHUNT_KEY}`,Accept:"application/json"},signal:controller.signal});
    const raw=await r.text();let d={};try{d=raw?JSON.parse(raw):{}}catch{}
    if(!r.ok){const detail=d?.detail??d?.message??d?.error;console.error("CarHunt",r.status,detail||raw.slice(0,500));return {ok:false,user_message:`Comparaison marché indisponible (CarHunt ${r.status}). L'analyse du véhicule reste complète.`};}
    const comps=(Array.isArray(d.listings)?d.listings:[]).filter(x=>compatible(x,v));
    const priced=comps.filter(x=>n(x.price)>0),prices=priced.map(x=>n(x.price)),med=median(prices),ask=n(v.price_eur);
    if(med==null)return {ok:true,comparables:0,asking:euro(ask),median:"Non déterminé",low:"Non déterminé",high:"Non déterminé",confidence:15,label:"Marché insuffisant",gap:"Aucun comparatif tarifaire exploitable n'a été trouvé.",sample:[]};
    const gap=ask==null?null:Math.round((ask/med-1)*100);
    const label=gap==null?"Marché comparable":gap<=-15?"Très bonne affaire potentielle":gap<=-8?"Prix très intéressant":gap<=-3?"Plutôt intéressant":gap<=3?"Dans le marché":gap<=10?"Plutôt cher":"Cher";
    const confidence=Math.min(95,40+Math.min(30,prices.length*3)+(v.year!=null?8:0)+(v.mileage_km!=null?8:0)+(v.energy?4:0)+(v.gearbox?4:0));
    return {ok:true,comparables:prices.length,asking:euro(ask),median:euro(med),low:euro(quantile(prices,.25)),high:euro(quantile(prices,.75)),confidence,label,gap:gap==null?"Prix demandé non déterminé.":`Prix demandé ${Math.abs(gap)} % ${gap>=0?"au-dessus":"en dessous"} du prix médian.`,warning:prices.length<5?"Échantillon limité : prudence dans l'interprétation.":null,sample:priced.slice(0,10).map(x=>({price:x.price,year:x.year,mileage:x.mileage,energy:x.energy,gearbox:x.gearbox,version:x.version,seller_type:x.seller_type,city:x.city,source:x.source,url:x.source_url}))};
  } catch(e) { console.error("CarHunt error",e); return {ok:false,user_message:e.name==="AbortError"?"La comparaison marché a dépassé le délai prévu.":"La comparaison marché est temporairement indisponible. L'analyse du véhicule reste complète."}; }
  finally {clearTimeout(timer);}
}

const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
const HTML=`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vaut le Coup ?</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17212b;font-family:system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:780px;margin:auto;padding:22px 12px 60px}.card{background:#fff;border:1px solid #e0e4e8;border-radius:25px;padding:22px;margin:14px 0}h1{font-size:40px;margin:0}h2{font-size:30px;margin:0 0 14px}.sub,.muted{color:#69747e}.drop{display:block;border:3px dashed #c8ced4;border-radius:22px;padding:28px 12px;text-align:center;cursor:pointer}.drop strong{font-size:23px}.small{display:block;color:#7a838c;margin-top:8px}#file{display:none}.previews{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:13px}.thumb{position:relative;aspect-ratio:1}.thumb img{width:100%;height:100%;object-fit:cover;border-radius:15px}.remove{position:absolute;right:-5px;top:-5px;border:0;border-radius:50%;width:34px;height:34px;background:#17212b;color:white;font-size:21px}.btn{width:100%;border:0;border-radius:17px;padding:17px;background:#17212b;color:white;font-size:20px;font-weight:800;margin-top:16px}.btn:disabled{opacity:.45}.progress{display:none;margin-top:15px;padding:17px;border-radius:19px;background:#f1f4f7}.progress.on{display:block}.track{height:12px;background:#dce2e7;border-radius:99px;overflow:hidden;margin-top:9px}.bar{height:100%;width:0;background:#2563eb;transition:width .25s}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}.box{background:#f6f7f8;border-radius:14px;padding:12px}.big{font-size:34px;font-weight:900}.tag{display:inline-block;background:#e8edf1;border-radius:99px;padding:6px 9px;margin:3px}.warn{background:#fff0d2;border-radius:16px;padding:14px;margin:9px 0}.good{background:#e6f6eb;border-radius:18px;padding:16px}.comp{padding:12px 0;border-bottom:1px solid #dde2e6}.comp:last-child{border:0}.error{background:#ffe1e1;color:#8e2424;border-radius:16px;padding:14px}@media(max-width:520px){h1{font-size:35px}.grid{grid-template-columns:1fr}.card{padding:19px}}
</style></head><body><main><h1>Vaut le Coup ? ✓</h1><p class="sub">Avant d’acheter. Demande à l’IA.</p><section class="card"><h2>Analyse une annonce</h2><p>Ajoute jusqu’à 3 captures ou photos de la même annonce.</p><label class="drop" for="file">📸<br><strong>Ajouter une capture ou une photo</strong><span class="small">JPG, PNG, WEBP — 12 Mo max par photo — 3 photos maximum</span></label><input id="file" type="file" accept="image/jpeg,image/png,image/webp" multiple><div id="previews" class="previews"></div><div id="err"></div><div id="progress" class="progress"><b id="step"></b><div class="track"><div id="bar" class="bar"></div></div><div id="note" class="muted"></div></div><button id="go" class="btn" disabled>Analyser l’annonce</button></section><section id="analysis" class="card" hidden></section><section id="market" class="card" hidden></section></main><script>
const $=id=>document.getElementById(id),input=$("file"),pre=$("previews"),go=$("go"),err=$("err"),prog=$("progress"),step=$("step"),bar=$("bar"),note=$("note"),analysis=$("analysis"),market=$("market");let files=[],vehicle=null,busy=false;
function render(){pre.innerHTML="";files.forEach((f,i)=>{const d=document.createElement("div"),img=document.createElement("img"),b=document.createElement("button");d.className="thumb";img.src=URL.createObjectURL(f);b.className="remove";b.type="button";b.dataset.i=i;b.textContent="×";d.append(img,b);pre.append(d)});go.disabled=!files.length||busy}
input.onchange=()=>{files=files.concat([...input.files]).slice(0,3);input.value="";render()};pre.onclick=e=>{const b=e.target.closest("button.remove");if(b){files.splice(Number(b.dataset.i),1);render()}};
const stage=(p,s,n)=>{prog.classList.add("on");bar.style.width=p+"%";step.textContent=s;note.textContent=n||""};
const field=(a,v)=>'<div class="box"><b>'+esc(a)+'</b><br>'+esc(v==null||v===""?"Non déterminé":v)+'</div>';
function showAnalysis(v){const u=(v.uncertain_fields||[]).length?'<div class="warn">⚠️ À vérifier : '+esc(v.uncertain_fields.join(", "))+'</div>':"",w=(v.warnings||[]).map(x=>'<div class="warn">⚠️ '+esc(x)+'</div>').join(""),c=(v.visible_claims||[]).map(x=>'<span class="tag">'+esc(x)+'</span>').join("");analysis.hidden=false;analysis.innerHTML='<h2>Ce que l’IA a lu</h2><div class="grid">'+field("Marque",v.make)+field("Modèle",v.model)+field("Version",v.version)+field("Année",v.year)+field("Kilométrage",v.mileage_km==null?null:Number(v.mileage_km).toLocaleString("fr-FR")+" km")+field("Prix",v.price_eur==null?null:Number(v.price_eur).toLocaleString("fr-FR")+" €")+field("Énergie",v.energy)+field("Boîte",v.gearbox)+field("Puissance",v.power_hp==null?null:v.power_hp+" ch")+field("Vendeur",v.seller_type==="professional"?"Professionnel":v.seller_type==="private"?"Particulier":null)+field("Lieu",v.location)+'</div><p><b>Confiance de lecture :</b> '+esc(v.confidence??"—")+'/100</p>'+u+w+(c?'<h3>Éléments visibles</h3>'+c:"")}
function showMarket(m){market.hidden=false;if(!m.ok){market.innerHTML='<h2>Est-ce que ça vaut le coup ?</h2><div class="warn">⚠️ '+esc(m.user_message||"Comparaison indisponible.")+'</div><p class="muted">L’analyse du véhicule est terminée. Tu peux relancer uniquement la comparaison.</p><button id="retry" class="btn">Réessayer la comparaison</button>';$('retry').onclick=()=>runMarket();return}let h='<h2>Est-ce que ça vaut le coup ?</h2><div class="good"><b>'+esc(m.label)+'</b><div class="big">'+esc(m.asking)+'</div><div>Marché médian : <b>'+esc(m.median)+'</b></div><div>'+esc(m.gap)+'</div></div><div class="grid" style="margin-top:10px">'+field("Comparables retenus",m.comparables)+field("Confiance marché",m.confidence+"/100")+field("25 % du marché",m.low)+field("75 % du marché",m.high)+'</div>'+(m.warning?'<div class="warn">⚠️ '+esc(m.warning)+'</div>':'')+'<h3>Comparaisons du marché</h3><div>';if(!m.sample?.length)h+='<p class="muted">Aucune annonce comparable exploitable.</p>';else m.sample.forEach(x=>{h+='<div class="comp"><b>'+esc(x.price==null?"—":Number(x.price).toLocaleString("fr-FR")+" €")+'</b> · '+esc(x.year||"année ?")+' · '+esc(x.mileage==null?"km ?":Number(x.mileage).toLocaleString("fr-FR")+" km")+'<br><span class="muted">'+esc([x.energy,x.gearbox,x.seller_type==="professional"?"Pro":x.seller_type==="private"?"Particulier":"",x.city].filter(Boolean).join(" · "))+'</span>'+(x.url?'<br><a href="'+esc(x.url)+'" target="_blank" rel="noopener">Voir l’annonce</a>':"")+'</div>'});market.innerHTML=h+'</div><p class="muted">Comparaison basée sur les annonces CarHunt disponibles au moment de l’analyse et filtrées localement selon les données connues du véhicule.</p>'}
async function analyze(){if(busy||!files.length)return;busy=true;go.disabled=true;err.innerHTML="";analysis.hidden=true;market.hidden=true;stage(8,"Envoi des photos…","Transmission à Gemini.");const fd=new FormData();files.forEach(f=>fd.append("photos",f,f.name));try{stage(25,"Lecture des photos…","Recoupement des informations visibles.");const c=new AbortController(),t=setTimeout(()=>c.abort(),45000);let r;try{r=await fetch("/api/analyze",{method:"POST",body:fd,signal:c.signal})}finally{clearTimeout(t)}const d=await r.json();if(!r.ok)throw Error(d.error||"Analyse impossible.");vehicle=d.vehicle;showAnalysis(vehicle);await runMarket();stage(100,"Terminé","Analyse et comparaison disponibles.")}catch(e){err.innerHTML='<div class="error">⚠️ '+esc(e.name==="AbortError"?"L’analyse a dépassé le délai prévu.":e.message)+'</div>';stage(0,"Échec","Tu peux relancer l’analyse.")}finally{busy=false;render()}}
async function runMarket(){if(!vehicle)return;stage(72,"Comparaison du marché…","Recherche d’annonces comparables.");try{const c=new AbortController(),t=setTimeout(()=>c.abort(),15000);let r;try{r=await fetch("/api/market",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(vehicle),signal:c.signal})}finally{clearTimeout(t)}const m=await r.json();showMarket(m)}catch(e){showMarket({ok:false,user_message:e.name==="AbortError"?"La comparaison a dépassé le délai prévu.":"Impossible de joindre le service de comparaison."})}}
go.onclick=analyze;
</script></body></html>`;

app.use(express.json({limit:"1mb"}));
app.get("/api/health",(_req,res)=>res.json({ok:true,vision:Boolean(GEMINI_KEY),vision_provider:"gemini",model:GEMINI_MODEL,market:Boolean(CARHUNT_KEY)}));
app.post("/api/analyze",upload.array("photos",3),async(req,res)=>{try{if(!req.files?.length)return res.status(400).json({error:"Aucune image reçue."});res.json({ok:true,vehicle:await gemini(req.files)})}catch(e){console.error("Analyze",e.status||"",e.detail||e.message);res.status(500).json({error:"Analyse IA indisponible. Réessaie dans quelques instants."})}});
app.post("/api/market",async(req,res)=>{const out=await carhunt(req.body||{});res.status(out.ok?200:503).json(out)});
app.get("/",(_req,res)=>res.type("html").send(HTML));
app.listen(PORT,()=>console.log(`Vaut le Coup ? listening on ${PORT}`));
