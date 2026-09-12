import http from 'node:http';
import { spawn } from 'node:child_process';

const PUBLIC_PORT = Number(process.env.PORT || 10000);
const INTERNAL_PORT = 10001;
const TARGET = `http://127.0.0.1:${INTERNAL_PORT}`;

// Resilient Gemini gateway: keep the existing multimodal model fallback server-side.
const nativeFetch = globalThis.fetch;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function isGeminiGenerate(url) {
  return typeof url === 'string' && url.includes('generativelanguage.googleapis.com') && url.includes(':generateContent');
}
function replaceModel(url, model) {
  return url.replace(/\/models\/[^:]+:generateContent/, `/models/${model}:generateContent`);
}
async function resilientGeminiFetch(input, init) {
  const originalUrl = typeof input === 'string' ? input : input?.url;
  if (!isGeminiGenerate(originalUrl)) return nativeFetch(input, init);
  const models = ['gemini-3.5-flash-lite','gemini-3.5-flash','gemini-3.6-flash','gemini-2.5-flash-lite'];
  let lastResponse;
  for (let i=0;i<models.length;i++) {
    const url=replaceModel(originalUrl,models[i]);
    const request=typeof input==='string'?url:new Request(url,input);
    const response=await nativeFetch(request,init);
    lastResponse=response;
    if(response.ok)return response;
    if(![408,429,500,502,503,504].includes(response.status))return response;
    if(i<models.length-1)await sleep(Math.min(8000,1000*2**i)+Math.floor(Math.random()*400));
  }
  return lastResponse;
}
globalThis.fetch=resilientGeminiFetch;
process.env.PORT=String(INTERNAL_PORT);
await import('./ui-final.js');

// Final production layer: guarantees a real, visible negotiation section after the market result.
const FINAL_SCRIPT=`<style id="vlc-final-negotiation-style">
#vlc-negotiation-final{margin:22px 0;padding:20px;border-radius:22px;background:#fff7e6;border:2px solid #f2cf8a;box-shadow:0 3px 12px #0000000a}
#vlc-negotiation-final h2{margin:0 0 10px;font-size:22px}
#vlc-negotiation-final .vlc-neg-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}
#vlc-negotiation-final .vlc-neg-item{padding:12px;border-radius:14px;background:#fff;border:1px solid #eadfc9;line-height:1.4}
#vlc-negotiation-final .vlc-neg-note{margin-top:14px;font-size:14px;line-height:1.45;color:#5f6872}
@media(max-width:600px){#vlc-negotiation-final .vlc-neg-grid{grid-template-columns:1fr}}
</style>
<script id="vlc-final-negotiation-script">(function(){
function add(){
 const market=document.getElementById('market');
 if(!market||market.hidden)return;
 if(document.getElementById('vlc-negotiation-final'))return;
 const txt=(market.innerText||'').toLowerCase();
 const insufficient=/insuffisant|non déterminé|pas d'estimation|aucun comparable|erreur/.test(txt);
 const expensive=/très cher|plutôt cher|\bcher\b/.test(txt)&&!/très intéressant|plutôt intéressant/.test(txt);
 const intro=insufficient?'Le marché disponible ne permet pas de fixer une marge de négociation fiable. La priorité est donc de sécuriser l’achat et d’identifier les frais réellement à prévoir.':expensive?'Le prix semble supérieur au marché comparable. Les annonces comparables constituent votre premier levier pour demander une baisse.':'Le prix paraît cohérent avec le marché. La négociation doit surtout s’appuyer sur des éléments concrets et vérifiables.';
 const items=insufficient?['📄 Demander toutes les factures et l’historique d’entretien.','🔧 Vérifier les gros entretiens et travaux à venir.','🧾 Contrôler le contrôle technique et les éventuelles contre-visites.','🛞 Examiner pneus, freins, carrosserie et équipements.']:['💶 Comparer le prix avec les annonces réellement équivalentes.','📄 Demander les factures et vérifier que l’entretien annoncé est justifié.','🔧 Chiffrer les frais à venir : pneus, freins, entretien ou réparations.','🧾 Vérifier contrôle technique, kilométrage, clés et historique.'];
 const box=document.createElement('section');box.id='vlc-negotiation-final';
 box.innerHTML='<h2>💬 Négociation : comment améliorer l’achat ?</h2><p>'+intro+'</p><div class="vlc-neg-grid">'+items.map(x=>'<div class="vlc-neg-item">'+x+'</div>').join('')+'</div><p class="vlc-neg-note">⚠️ Ne négociez pas sur un défaut supposé. Utilisez uniquement des éléments constatés, des justificatifs manquants ou des frais réellement identifiés.</p>';
 market.parentNode.insertBefore(box,market.nextSibling);
}
function start(){add();new MutationObserver(add).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','class']});setInterval(add,500)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();</script>`;

const server=http.createServer((req,res)=>{
 const target=new URL(req.url||'/',TARGET);
 const upstream=http.request({hostname:'127.0.0.1',port:INTERNAL_PORT,path:target.pathname+target.search,method:req.method,headers:{...req.headers,host:`127.0.0.1:${INTERNAL_PORT}`}},up=>{
   const chunks=[];
   up.on('data',c=>chunks.push(c));
   up.on('end',()=>{
     let body=Buffer.concat(chunks);
     const headers={...up.headers};
     delete headers['content-length'];delete headers['content-encoding'];delete headers['transfer-encoding'];
     const isHtml=req.method==='GET'&&/text\/html/i.test(String(headers['content-type']||''));
     if(isHtml){
       body=Buffer.from(body.toString('utf8').replace(/<\/head>/i,FINAL_SCRIPT+'</head>'),'utf8');
     }
     res.writeHead(up.statusCode||502,{...headers,'content-length':String(body.length),'cache-control':'no-store, no-cache, must-revalidate, proxy-revalidate'});
     res.end(body);
   });
 });
 upstream.on('error',()=>{if(!res.headersSent){res.statusCode=502;res.setHeader('content-type','application/json; charset=utf-8');res.end(JSON.stringify({error:'Service temporairement indisponible. Réessayez dans quelques instants.'}))}else res.end()});
 req.pipe(upstream);
});
server.listen(PUBLIC_PORT,()=>console.log(`Vaut le Coup production gateway listening on ${PUBLIC_PORT}`));
