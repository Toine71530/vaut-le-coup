import express from "express";
import multer from "multer";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 3, fileSize: 12 * 1024 * 1024 } });
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const CARHUNT_API_KEY = process.env.CARHUNT_API_KEY || "";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const n = v => { const x = Number(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return Number.isFinite(x) ? x : null; };
const norm = v => String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const money = v => v == null ? "Non déterminé" : Math.round(v).toLocaleString("fr-FR") + " €";
const median = a => { const x=[...a].sort((a,b)=>a-b); if(!x.length)return null; const i=Math.floor(x.length/2); return x.length%2?x[i]:(x[i-1]+x[i])/2; };
const q = (a,p) => { const x=[...a].sort((a,b)=>a-b); if(!x.length)return null; const i=(x.length-1)*p,l=Math.floor(i),h=Math.ceil(i); return x[l]+(x[h]-x[l])*(i-l); };
const json = t => { const s=String(t||"").replace(/^```json\s*/i,"").replace(/```$/i,"").trim(),a=s.indexOf("{"),b=s.lastIndexOf("}"); if(a<0||b<=a)throw new Error("Réponse IA invalide"); return JSON.parse(s.slice(a,b+1)); };

async function gemini(files){
  if(!GEMINI_API_KEY) throw new Error("Le moteur Gemini n’est pas configuré.");
  const prompt=`Analyse ces photos/captures d’une même annonce automobile. Recoupe toutes les informations visibles. N’invente rien. Si une donnée est absente ou contradictoire, mets null et signale le problème. Retourne uniquement ce JSON : {"make":string|null,"model":string|null,"version":string|null,"year":number|null,"mileage_km":number|null,"price_eur":number|null,"energy":string|null,"gearbox":string|null,"power_hp":number|null,"seller_type":"professional"|"private"|null,"location":string|null,"title":string|null,"confidence":number,"uncertain_fields":string[],"visible_claims":string[],"warnings":string[]}. Ne déduis pas le vendeur, la finition ou les caractéristiques non visibles.`;
  const parts=[{text:prompt},...files.map(f=>({inline_data:{mime_type:f.mimetype,data:f.buffer.toString("base64")}}))];
  let last;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts}],generationConfig:{responseMimeType:"application/json",temperature:.1}})});
      const text=await r.text(); if(!r.ok){last=new Error(`Gemini HTTP ${r.status}`);last.status=r.status;last.detail=text.slice(0,600);if([429,500,502,503,504].includes(r.status)){await sleep(1000*(attempt+1));continue;}throw last;}
      const d=JSON.parse(text),out=d?.candidates?.[0]?.content?.parts?.map(x=>x.text||"").join(""); if(!out)throw new Error("Gemini n’a retourné aucun résultat."); return json(out);
    }catch(e){last=e;if(attempt<2&&[429,500,502,503,504].includes(e.status)){await sleep(1000*(attempt+1));continue;}throw e;}
  }
  throw last;
}

function sameFuel(a,b){return !a||!b||norm(a).includes(norm(b))||norm(b).includes(norm(a));}
function sameGear(a,b){return !a||!b||norm(a).includes(norm(b))||norm(b).includes(norm(a));}
function compatible(a,v){
  if(norm(a.make)!==norm(v.make)||norm(a.model)!==norm(v.model)) return false;
  const y=n(v.year), ay=n(a.year), k=n(v.mileage_km), ak=n(a.mileage);
  if(y!=null&&ay!=null&&Math.abs(y-ay)>2)return false;
  if(k!=null&&ak!=null&&Math.abs(k-ak)>30000)return false;
  if(v.energy&&!sameFuel(a.energy,v.energy))return false;
  if(v.gearbox&&!sameGear(a.gearbox,v.gearbox))return false;
  return n(a.price)>0;
}

async function market(v){
  if(!CARHUNT_API_KEY)return {ok:false,code:"CONFIG",user_message:"Comparaison marché indisponible pour le moment."};
  if(!v?.make||!v?.model)return {ok:false,code:"INPUT",user_message:"Impossible de lancer la comparaison : marque ou modèle non identifié."};
  const params=new URLSearchParams({make:String(v.make).trim().toUpperCase(),model:String(v.model).trim().toUpperCase(),page_size:"100"});
  if(n(v.year)){params.set("year_min",String(n(v.year)-2));params.set("year_max",String(n(v.year)+2));}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{
    const r=await fetch(`https://api-pro.carhunt.fr/v1/listings/search?${params}`,{headers:{Authorization:`Bearer ${CARHUNT_API_KEY}`,Accept:"application/json"},signal:controller.signal});
    const raw=await r.text(); let d={}; try{d=JSON.parse(raw)}catch{}
    if(!r.ok){console.error("CarHunt",r.status,raw.slice(0,1000));return {ok:false,code:"UPSTREAM",status:r.status,user_message:"La comparaison marché est temporairement indisponible. L’analyse du véhicule reste complète."};}
    const all=Array.isArray(d.listings)?d.listings:[];
    const comps=all.filter(x=>compatible(x,v));
    const prices=comps.map(x=>n(x.price)).filter(x=>x>0),med=median(prices),ask=n(v.price_eur);
    if(med==null)return {ok:true,comparables:0,asking:money(ask),median:"Non déterminé",low:"Non déterminé",high:"Non déterminé",confidence:20,label:"Marché insuffisant",gap:"Pas assez de comparables pertinents pour conclure.",sample:[]};
    const gap=ask!=null?Math.round((ask/med-1)*100):null;
    const label=gap==null?"Marché comparable":gap<=-15?"Excellente affaire potentielle":gap<=-8?"Très intéressant":gap<=-3?"Plutôt intéressant":gap<=3?"Dans le marché":gap<=10?"Plutôt cher":"Cher";
    const confidence=Math.min(95,45+Math.min(10,prices.length)*4+(v.year?8:0)+(v.mileage_km?8:0)+(v.energy?5:0)+(v.gearbox?5:0));
    return {ok:true,comparables:prices.length,asking:money(ask),median:money(med),low:money(q(prices,.25)),high:money(q(prices,.75)),confidence,label,gap:gap==null?"Écart au marché non déterminé.":`Prix demandé ${Math.abs(gap)} % ${gap>=0?"au-dessus":"en dessous"} du prix médian.`,warning:prices.length<5?"Échantillon limité : prudence dans l’interprétation.":null,sample:comps.slice(0,10).map(x=>({price:x.price,year:x.year,mileage:x.mileage,energy:x.energy,gearbox:x.gearbox,version:x.version,seller_type:x.seller_type,city:x.city,source:x.source,url:x.source_url,deal_score:x.deal_score}))};
  }catch(e){return {ok:false,code:e.name==="AbortError"?"TIMEOUT":"NETWORK",user_message:"La comparaison marché est temporairement indisponible. L’analyse du véhicule reste complète."};}finally{clearTimeout(timer);}
}

app.use(express.json({limit:"1mb"}));
app.get("/api/health",(_q,res)=>res.json({ok:true,vision:Boolean(GEMINI_API_KEY),vision_provider:"gemini",model:GEMINI_MODEL,market:Boolean(CARHUNT_API_KEY)}));
app.post("/api/analyze",upload.array("photos",3),async(req,res)=>{try{if(!req.files?.length)return res.status(400).json({error:"Aucune image reçue."});res.json({ok:true,vehicle:await gemini(req.files)});}catch(e){console.error(e);res.status(500).json({error:"Analyse IA indisponible. Réessaie dans quelques instants."});}});
app.post("/api/market",async(req,res)=>{const out=await market(req.body||{});res.status(out.ok?200:503).json(out);});

const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const HTML=`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vaut le Coup ?</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17212b;font-family:system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:760px;margin:auto;padding:28px 16px 70px}h1{font-size:42px;margin:0 0 8px}.sub{color:#68737d;font-size:21px;margin-bottom:28px}.card{background:#fff;border:1px solid #e0e4e8;border-radius:28px;padding:28px;margin:18px 0;box-shadow:0 2px 10px #00000008}h2{font-size:30px;margin:0 0 16px}.drop{display:block;border:3px dashed #c8ced4;border-radius:24px;padding:34px 18px;text-align:center;cursor:pointer;font-size:20px}.drop strong{font-size:24px}.small{display:block;color:#78818a;margin-top:10px}#file{display:none}.previews{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}.thumb{position:relative;aspect-ratio:1}.thumb img{width:100%;height:100%;object-fit:cover;border-radius:18px}.remove{position:absolute;right:-5px;top:-5px;border:0;border-radius:50%;width:34px;height:34px;background:#17212b;color:#fff;font-size:20px}.btn{width:100%;border:0;border-radius:18px;padding:18px;background:#17212b;color:#fff;font-size:20px;font-weight:800;cursor:pointer;margin-top:18px}.btn:disabled{opacity:.45}.progress{display:none;margin-top:18px;padding:20px;border-radius:22px;background:#f2f5f8}.progress.on{display:block}.step{font-size:18px;font-weight:800;margin-bottom:10px}.track{height:14px;background:#dfe4e8;border-radius:99px;overflow:hidden}.bar{height:100%;width:0;background:#2563eb;transition:width .4s}.note{color:#69737d;margin-top:9px}.warn{background:#fff0d2;border-radius:18px;padding:16px;margin:12px 0}.error{background:#ffe1e1;color:#9c2525;border-radius:18px;padding:16px;margin-top:16px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.box{background:#f6f7f8;border-radius:16px;padding:14px}.price{font-size:38px;font-weight:900}.tag{display:inline-block;background:#e8edf1;border-radius:99px;padding:7px 11px;margin:3px}.comp{padding:15px 0;border-bottom:1px solid #ddd}.muted{color:#69737d}.success{background:#e7f6ec;border-radius:20px;padding:18px}.marketfail{background:#fff0d2;border-radius:20px;padding:18px}.retry{margin-top:14px}@media(max-width:520px){main{padding:22px 12px}.card{padding:22px}h1{font-size:36px}.grid{grid-template-columns:1fr}}</style></head><body><main><h1>Vaut le Coup ? ✓</h1><div class="sub">Avant d’acheter. Demande à l’IA.</div><section class="card"><h2>Analyse une annonce</h2><p>Ajoute jusqu’à 3 photos de l’annonce ou du véhicule.</p><label class="drop" for="file">📸<br><strong>Ajoute une capture ou une photo</strong><span class="small">JPG, PNG, WEBP — 12 Mo max par photo — 3 photos maximum</span></label><input id="file" type="file" accept="image/jpeg,image/png,image/webp" multiple><div id="previews" class="previews"></div><div id="err"></div><div id="progress" class="progress"><div id="step" class="step">Préparation…</div><div class="track"><div id="bar" class="bar"></div></div><div id="note" class="note"></div></div><button id="go" class="btn" disabled>Analyser l’annonce</button></section><section id="analysis" class="card" hidden></section><section id="market" class="card" hidden></section></main><script>
const $=id=>document.getElementById(id),input=$("file"),pre=$("previews"),go=$("go"),err=$("err"),prog=$("progress"),step=$("step"),bar=$("bar"),note=$("note"),analysis=$("analysis"),marketBox=$("market");let files=[],vehicle=null;
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
function render(){pre.innerHTML="";files.forEach((f,i)=>{const d=document.createElement("div");d.className="thumb";d.innerHTML=`<img src="${URL.createObjectURL(f)}"><button class="remove" type="button" data-i="${i}">×</button>`;pre.appendChild(d)});go.disabled=!files.length;}
input.onchange=()=>{files=[...files,...input.files].slice(0,3);input.value="";render();};pre.onclick=e=>{const b=e.target.closest("button");if(b){files.splice(Number(b.dataset.i),1);render();}};
function stage(p,s,noteText=""){prog.classList.add("on");bar.style.width=p+"%";step.textContent=s;note.textContent=noteText;}
function showAnalysis(v){const claims=(v.visible_claims||[]).map(x=>`<span class="tag">${esc(x)}</span>`).join("");const warns=(v.warnings||[]).map(x=>`<div class="warn">⚠️ ${esc(x)}</div>`).join("");analysis.hidden=false;analysis.innerHTML=`<h2>Ce que l’IA a lu</h2><div class="grid"><div class="box"><b>Marque</b><br>${esc(v.make||"Non déterminée")}</div><div class="box"><b>Modèle</b><br>${esc(v.model||"Non déterminé")}</div><div class="box"><b>Version</b><br>${esc(v.version||"Non déterminée")}</div><div class="box"><b>Année</b><br>${esc(v.year||"Non déterminée")}</div><div class="box"><b>Kilométrage</b><br>${v.mileage_km!=null?Number(v.mileage_km).toLocaleString("fr-FR")+" km":"Non déterminé"}</div><div class="box"><b>Prix</b><br>${v.price_eur!=null?Number(v.price_eur).toLocaleString("fr-FR")+" €":"Non déterminé"}</div><div class="box"><b>Énergie</b><br>${esc(v.energy||"Non déterminée")}</div><div class="box"><b>Boîte</b><br>${esc(v.gearbox||"Non déterminée")}</div></div><p><b>Confiance de lecture :</b> ${Number(v.confidence||0)}/100</p>${claims?`<h3>Éléments visibles</h3>${claims}`:""}${warns}`;}
function showMarket(m){marketBox.hidden=false;if(!m.ok){marketBox.innerHTML=`<h2>Est-ce que ça vaut le coup ?</h2><div class="marketfail">⚠️ ${esc(m.user_message||"Comparaison indisponible.")}<br><span class="muted">L’analyse du véhicule est complète. La comparaison peut être relancée sans renvoyer les photos.</span><button id="retry" class="btn retry">Réessayer la comparaison</button></div>`;$('retry').onclick=()=>runMarket();return;}const rows=(m.sample||[]).map(x=>`<div class="comp"><b>${esc(x.version||x.make+" "+x.model||"Comparable")}</b><br>${money(x.price)} · ${esc(x.year||"")} · ${x.mileage?Number(x.mileage).toLocaleString("fr-FR")+" km":"km non indiqué"}<br><span class="muted">${esc(x.energy||"")} ${esc(x.gearbox||"")} · ${esc(x.seller_type||"")} · ${esc(x.city||"")}</span>${x.url?`<br><a class="link" target="_blank" rel="noopener" href="${esc(x.url)}">Voir l’annonce</a>`:""}</div>`).join("");marketBox.innerHTML=`<h2>Est-ce que ça vaut le coup ?</h2><div class="success"><div class="score">${esc(m.label)}</div><div class="price">${esc(m.asking)}</div><p>${esc(m.gap)}</p></div><div class="grid" style="margin-top:12px"><div class="box"><b>Médiane marché</b><br>${esc(m.median)}</div><div class="box"><b>Fourchette centrale</b><br>${esc(m.low)} – ${esc(m.high)}</div><div class="box"><b>Comparables</b><br>${m.comparables}</div><div class="box"><b>Confiance marché</b><br>${m.confidence}/100</div></div>${m.warning?`<div class="warn">⚠️ ${esc(m.warning)}</div>`:""}${rows?`<h3>Comparables retenus</h3>${rows}`:""}`;}
const money=v=>v==null?"—":Number(v).toLocaleString("fr-FR")+" €";
async function runMarket(){if(!vehicle)return;stage(82,"Recherche du marché…","Comparaison CarHunt en cours");marketBox.hidden=true;try{const r=await fetch("/api/market",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(vehicle)});const m=await r.json();showMarket(m);stage(100,"Analyse terminée","Analyse IA et comparaison marché terminées");go.disabled=false;}catch(e){showMarket({ok:false,user_message:"La comparaison marché est momentanément indisponible."});stage(100,"Analyse terminée","Le marché n’a pas pu être chargé, mais l’analyse IA est disponible");go.disabled=false;}}
go.onclick=async()=>{if(!files.length)return;err.innerHTML="";analysis.hidden=true;marketBox.hidden=true;go.disabled=true;stage(8,"Photos reçues","Préparation de l’analyse");try{const fd=new FormData();files.forEach(f=>fd.append("photos",f));stage(18,"Lecture des photos…","Analyse Gemini en cours");const r=await fetch("/api/analyze",{method:"POST",body:fd});const d=await r.json();if(!r.ok)throw new Error(d.error||"Analyse indisponible");vehicle=d.vehicle;stage(60,"Données du véhicule validées","Informations recoupées entre les captures");showAnalysis(vehicle);stage(72,"Vérification du marché…","L’analyse IA est terminée");await runMarket();}catch(e){err.innerHTML=`<div class="error">❌ ${esc(e.message||"Erreur inattendue")}</div>`;stage(100,"Analyse interrompue","Aucun résultat fiable n’a été produit");go.disabled=false;}};
</script></body></html>`;
app.get("/",(_q,res)=>res.type("html").send(HTML));
app.listen(PORT,"0.0.0.0",()=>console.log(`Vaut le Coup ? — serveur unique sur ${PORT}`));
