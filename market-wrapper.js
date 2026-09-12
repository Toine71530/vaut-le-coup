import express from "express";
import http from "http";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 10001);
const TARGET = `http://127.0.0.1:${INTERNAL_PORT}`;
app.use(express.json({ limit: "2mb" }));

const n = v => { const x = Number(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return Number.isFinite(x) ? x : null; };
const norm = v => String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const median = a => { const x=[...a].sort((a,b)=>a-b); if(!x.length)return null; const i=Math.floor(x.length/2); return x.length%2?x[i]:(x[i-1]+x[i])/2; };
const quantile = (a,p) => { const x=[...a].sort((a,b)=>a-b); if(!x.length)return null; const i=(x.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i); return x[lo]+(x[hi]-x[lo])*(i-lo); };
const euro = x => x==null ? "Non déterminé" : Math.round(x).toLocaleString("fr-FR")+" €";
const fuelMatch = (a,b) => !b || norm(a).includes(norm(b)) || norm(b).includes(norm(a));
const gearMatch = (a,b) => !b || norm(a).includes(norm(b)) || (norm(b).includes("manuel") && norm(a).includes("manual")) || (norm(b).includes("auto") && norm(a).includes("auto"));
const apiError = (data, status) => {
  const d = data?.detail ?? data?.message ?? data?.error;
  let text = typeof d === "string" ? d : d ? JSON.stringify(d) : "Requête refusée par CarHunt.";
  return `CarHunt HTTP ${status}: ${text}`;
};

async function carhunt(body){
  const key=process.env.CARHUNT_API_KEY;
  if(!key)return {error:"CARHUNT_API_KEY manquante."};
  const v=body||{}, make=String(v.make||"").trim(), model=String(v.model||"").trim();
  if(!make||!model)return {error:"Marque et modèle nécessaires."};

  // IMPORTANT : la documentation CarHunt valide explicitement make/model/page_size.
  // On commence sans aucun filtre optionnel afin d'éviter les 422 liés aux valeurs normalisées.
  // Tous les critères spécifiques au véhicule sont ensuite filtrés localement.
  const params=new URLSearchParams({make:make.toUpperCase(),model:model.toUpperCase(),page_size:"100"});
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),15000);
  try{
    const url=`https://api-pro.carhunt.fr/v1/listings/search?${params.toString()}`;
    const r=await fetch(url,{headers:{Authorization:`Bearer ${key}`,Accept:"application/json"},signal:controller.signal});
    const raw=await r.text();
    let data={}; try{data=raw?JSON.parse(raw):{}}catch{}
    if(!r.ok) return {error:apiError(data,r.status)};
    let listings=(Array.isArray(data.listings)?data.listings:[]).filter(x=>n(x.price)!=null&&n(x.price)>0);

    const targetKm=n(v.mileage_km), targetYear=n(v.year);
    if(targetKm!=null) listings=listings.filter(x=>{const k=n(x.mileage);return k==null||Math.abs(k-targetKm)<=30000;});
    if(v.energy) listings=listings.filter(x=>fuelMatch(x.energy,v.energy));
    if(v.gearbox) listings=listings.filter(x=>gearMatch(x.gearbox,v.gearbox));
    if(targetYear!=null) listings=listings.filter(x=>{const y=n(x.year);return y==null||Math.abs(y-targetYear)<=1;});

    const prices=listings.map(x=>n(x.price)).filter(x=>x!=null);
    const med=median(prices), asking=n(v.price_eur);
    if(med==null)return {ok:true,comparables:0,asking_display:euro(asking),median_display:"Non déterminé",low_display:"Non déterminé",high_display:"Non déterminé",confidence:25,label:"Marché insuffisant",gap_text:"Aucun comparable suffisamment proche n'a été trouvé."};
    const gap=asking!=null?Math.round((asking/med-1)*100):null;
    const label=gap==null?"Marché comparable":gap<=-10?"Très intéressant":gap<=-3?"Plutôt intéressant":gap<=3?"Dans le marché":gap<=10?"Plutôt cher":"Cher";
    const confidence=Math.min(95,50+Math.min(5,prices.length)*7+(targetYear!=null?6:0)+(v.energy?5:0)+(v.gearbox?4:0));
    return {ok:true,comparables:prices.length,asking_display:euro(asking),median_display:euro(med),low_display:euro(quantile(prices,.15)),high_display:euro(quantile(prices,.85)),confidence,label,gap_text:gap==null?"Écart au marché non déterminé.":`Le prix demandé est ${Math.abs(gap)}% ${gap>=0?"au-dessus":"en dessous"} du prix médian.`,warning:prices.length<5?"Échantillon limité : interpréter le résultat avec prudence.":null,sample:listings.slice(0,10).map(x=>({price:x.price,year:x.year,mileage:x.mileage,energy:x.energy,gearbox:x.gearbox,horsepower:x.horsepower,seller_type:x.seller_type,source:x.source,source_url:x.source_url}))};
  }catch(e){
    if(e.name==="AbortError")return {error:"La recherche marché a dépassé 15 secondes. L'analyse IA reste disponible."};
    return {error:e.message||"Erreur CarHunt."};
  }finally{clearTimeout(timeout);}
}

function inject(html){
  html=html.replace("</head>",`<style>
.previews{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:10px!important;width:100%!important}.thumb{width:100%!important;min-width:0!important;aspect-ratio:1/1!important;height:auto!important}.thumb img{width:100%!important;height:100%!important;object-fit:cover!important}
.analysis-progress{display:none;margin-top:18px;padding:18px;border-radius:20px;background:#f4f7fa;border:1px solid #dce4eb}.analysis-progress.active{display:block}.analysis-progress-title{font-weight:800;font-size:18px;margin-bottom:10px}.analysis-progress-track{height:14px;background:#e1e6eb;border-radius:99px;overflow:hidden}.analysis-progress-bar{height:100%;width:5%;border-radius:99px;background:#2563eb;transition:width .7s ease}.analysis-progress-note{font-size:14px;color:#68727d;margin-top:9px}.market-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.market-box{background:#f7f8fa;border-radius:18px;padding:14px}.market-comp{padding:14px 0;border-bottom:1px solid #ddd}.market-link{color:inherit;text-decoration:underline}@media(max-width:520px){.market-grid{grid-template-columns:1fr}}
</style></head>`);
  html=html.replace('<div id="error"></div>','<div id="error"></div><div id="analysis-progress" class="analysis-progress" aria-live="polite"><div id="analysis-progress-title" class="analysis-progress-title">Analyse des photos…</div><div class="analysis-progress-track"><div id="analysis-progress-bar" class="analysis-progress-bar"></div></div><div id="analysis-progress-note" class="analysis-progress-note">Lecture des informations visibles</div></div>');
  html=html.replace('</body>',`<script>(function(){const b=document.getElementById('go'),p=document.getElementById('analysis-progress'),bar=document.getElementById('analysis-progress-bar'),title=document.getElementById('analysis-progress-title'),note=document.getElementById('analysis-progress-note'),m=document.getElementById('market'),err=document.getElementById('error');if(!b||!p)return;let timer=null,i=0;const steps=[['Analyse des photos…','Lecture des informations visibles',18],['Extraction des données…','Identification du véhicule, du prix et du kilométrage',38],['Vérification…','Contrôle des informations détectées',58],['Recherche du marché…','Recherche de véhicules comparables',78],['Finalisation…','Préparation du résultat',94]];const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));function setStep(k){const s=steps[Math.min(k,steps.length-1)];title.textContent=s[0];note.textContent=s[1];bar.style.width=s[2]+'%'}function start(){p.classList.add('active');i=0;setStep(0);clearInterval(timer);timer=setInterval(()=>{if(i<steps.length-1){i++;setStep(i)}},1700)}function done(){clearInterval(timer);bar.style.width='100%';title.textContent='Analyse terminée';note.textContent='Résultat prêt';setTimeout(()=>p.classList.remove('active'),900)}function renderMarket(x){m.hidden=false;if(x.error){m.innerHTML='<h2>Est-ce que ça vaut le coup ?</h2><div class="warn">⚠️ '+esc(x.error)+'</div>';done();return}let h='<h2>Est-ce que ça vaut le coup ?</h2><div class="status"><b>'+esc(x.label||'Marché comparable')+'</b><p>Confiance marché : <b>'+esc(x.confidence??'—')+'/100</b></p><div class="market-grid"><div class="market-box"><div class="muted">Prix demandé</div><strong>'+esc(x.asking_display||'—')+'</strong></div><div class="market-box"><div class="muted">Prix médian</div><strong>'+esc(x.median_display||'—')+'</strong></div><div class="market-box"><div class="muted">Fourchette basse</div><strong>'+esc(x.low_display||'—')+'</strong></div><div class="market-box"><div class="muted">Fourchette haute</div><strong>'+esc(x.high_display||'—')+'</strong></div></div><p>'+esc(x.gap_text||'')+'</p>'+(x.warning?'<div class="warn">⚠️ '+esc(x.warning)+'</div>':'')+'</div><h3>Comparables utilisés ('+esc(x.comparables??0)+')</h3>';
if(x.sample?.length)h+=x.sample.map((c,j)=>'<div class="market-comp"><b>#'+(j+1)+' — '+esc(c.price!=null?Number(c.price).toLocaleString('fr-FR')+' €':'Prix non indiqué')+'</b><br><span class="muted">'+esc([c.year,c.mileage!=null?Number(c.mileage).toLocaleString('fr-FR')+' km':null,c.energy,c.gearbox].filter(Boolean).join(' · '))+'</span>'+(c.source_url?'<br><a class="market-link" target="_blank" rel="noopener" href="'+esc(c.source_url)+'">Voir l’annonce</a>':'')+'</div>').join('');else h+='<div class="warn">Aucun comparable détaillé retourné par le marché.</div>';m.innerHTML=h;done()}
const realFetch=window.fetch.bind(window);window.fetch=function(input,init){const url=typeof input==='string'?input:(input&&input.url)||'';if(url.includes('/api/market')){const c=new AbortController(),opts={...(init||{}),signal:c.signal},t=setTimeout(()=>c.abort(),16000);return realFetch(input,opts).then(r=>{clearTimeout(t);return r}).catch(e=>{clearTimeout(t);if(e.name==='AbortError')return new Response(JSON.stringify({error:'La recherche marché est momentanément indisponible. L’analyse IA reste disponible.'}),{status:503,headers:{'Content-Type':'application/json'}});throw e})}if(url.includes('/api/analyze')){return realFetch(input,init).then(async r=>{try{const d=await r.clone().json();if(d?.ok&&d.vehicle){setStep(3);try{const mr=await realFetch('/api/market',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d.vehicle)});renderMarket(await mr.json())}catch(e){renderMarket({error:'Impossible de récupérer les comparaisons marché pour le moment.'})}}}catch(e){}return r})}return realFetch(input,init)};document.addEventListener('click',e=>{if(e.target===b)start()},true);new MutationObserver(()=>{if(err?.textContent.trim()){clearInterval(timer);p.classList.remove('active')}}).observe(document.body,{subtree:true,childList:true,characterData:true})})();</script></body>`);return html;
}

function proxy(req,res){if(req.path==='/api/market'){carhunt(req.body).then(x=>res.status(x.error?503:200).json(x)).catch(e=>res.status(500).json({error:e.message||'Erreur marché.'}));return}const headers={...req.headers,host:`127.0.0.1:${INTERNAL_PORT}`};const r=http.request(`${TARGET}${req.originalUrl}`,{method:req.method,headers},up=>{const chunks=[];up.on('data',c=>chunks.push(c));up.on('end',()=>{const raw=Buffer.concat(chunks),type=String(up.headers['content-type']||'');if(type.includes('text/html')){const out=inject(raw.toString('utf8'));res.status(up.statusCode||200).set({'content-type':'text/html; charset=utf-8','cache-control':'no-store'}).send(out);return}res.status(up.statusCode||200);Object.entries(up.headers).forEach(([k,v])=>{if(!['transfer-encoding','content-length'].includes(k.toLowerCase())&&v!=null)res.set(k,v)});res.send(raw)})});r.on('error',e=>res.status(502).json({error:e.message||'Service interne indisponible.'}));req.pipe(r)}
app.use((req,res)=>proxy(req,res));
const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(INTERNAL_PORT)},stdio:'inherit'});child.on('exit',code=>{if(code&&code!==0)process.exit(code)});app.listen(PORT,'0.0.0.0',()=>console.log(`Vaut le Coup wrapper ${PORT}; server ${INTERNAL_PORT}`));process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));
