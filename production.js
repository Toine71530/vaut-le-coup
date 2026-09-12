// Final production entrypoint: runs the existing app behind a single resilient
// public proxy and adds a last-resort client UI layer. This layer never replaces
// the application's own result; it only guarantees visible progress and a
// readable market/negotiation result when the inner UI fails to render it.
import http from "node:http";

const INNER_PORT = 10004;
const PUBLIC_PORT = Number(process.env.PORT || 10000);
process.env.PORT = String(INNER_PORT);
await import("./ui-final.js");

const FINAL_UI = `<script id="vlc-final-safety-ui">(function(){
let active=false, value=0, timer=null, vehicle=null;
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
function ensure(){let p=$('vlc-safe-progress');if(p)return p;p=document.createElement('div');p.id='vlc-safe-progress';p.innerHTML='<div class="vhead"><b id="vlc-safe-label">🤖 Analyse des photos…</b><b id="vlc-safe-pct">0 %</b></div><div class="vtrack"><i id="vlc-safe-fill"></i></div><small id="vlc-safe-sub">L’IA lit et croise les informations visibles.</small>';document.body.appendChild(p);return p}
function style(){if($('vlc-safe-style'))return;const s=document.createElement('style');s.id='vlc-safe-style';s.textContent='#vlc-safe-progress{position:fixed;z-index:2147483647;top:10px;left:10px;right:10px;display:none;background:#fff;border:2px solid #d9e1e8;border-radius:18px;padding:14px 16px;box-shadow:0 8px 28px #0003;font-family:system-ui,sans-serif}.vhead{display:flex;justify-content:space-between;gap:12px;margin-bottom:9px}.vtrack{height:14px;background:#e5eaf0;border-radius:99px;overflow:hidden}.vtrack i{display:block;height:100%;width:0;background:#2563eb;border-radius:99px;transition:width .3s ease,background .2s}.vlc-safe-progress small{display:block;margin-top:7px;color:#64748b}.vlc-safe-result{margin-top:18px;padding:20px;border-radius:22px;border:2px solid #dfe5ea}.safe-green{background:#ecfdf3;border-color:#86efac}.safe-blue{background:#eff6ff;border-color:#93c5fd}.safe-orange{background:#fff7ed;border-color:#fdba74}.safe-red{background:#fef2f2;border-color:#fca5a5}.safe-verdict{display:inline-block;padding:9px 14px;border-radius:999px;font-size:21px;font-weight:900}.safe-green .safe-verdict{background:#bbf7d0;color:#166534}.safe-blue .safe-verdict{background:#dbeafe;color:#1e40af}.safe-orange .safe-verdict{background:#fed7aa;color:#9a3412}.safe-red .safe-verdict{background:#fecaca;color:#991b1b}.safe-neg{margin-top:16px;padding:15px;border-radius:17px;background:#fff;border:1px solid #e1e6eb;line-height:1.5}.safe-neg h3{margin:0 0 7px}.safe-neg ul{margin:8px 0 0 20px;padding:0}';document.head.appendChild(s)}
function progress(n,label,sub,color){style();const p=ensure();p.style.display='block';value=Math.max(0,Math.min(100,Math.round(n)));$('vlc-safe-fill').style.width=value+'%';$('vlc-safe-fill').style.background=color||'#2563eb';$('vlc-safe-pct').textContent=value+' %';$('vlc-safe-label').textContent=label;$('vlc-safe-sub').textContent=sub||''}
function start(){active=true;clearInterval(timer);progress(5,'🤖 Analyse des photos…','Lecture et extraction des informations visibles.','#2563eb');timer=setInterval(()=>{if(value<48)progress(value+2,'🔎 Analyse des photos…','Croisement des informations visibles.','#2563eb')},600)}
function marketStart(){clearInterval(timer);progress(55,'💶 Recherche du marché…','Recherche de comparables compatibles.','#f59e0b');timer=setInterval(()=>{if(value<90)progress(value+3,'📊 Comparaison des prix…','Calcul du positionnement du prix.','#f59e0b')},500)}
function finish(ok){clearInterval(timer);progress(100,ok?'✅ Analyse terminée':'⚠️ Analyse interrompue',ok?'Résultat prêt.':'Le service est momentanément indisponible.',ok?'#16a34a':'#f59e0b');if(!ok)$('vlc-safe-fill').style.background='#dc2626';setTimeout(()=>{const p=$('vlc-safe-progress');if(p)p.style.display='none'},ok?2500:8000);active=false}
function renderFallback(data){const market=$('market');if(!market||market.hidden||!data)return;if(market.querySelector('.safe-fallback'))return;const label=String(data.label||'Données de marché insuffisantes');let cls=/Très intéressant|Plutôt intéressant/i.test(label)?'safe-green':/Dans le marché/i.test(label)?'safe-blue':/insuffisant/i.test(label)?'safe-orange':'safe-red';const box=document.createElement('div');box.className='vlc-safe-result '+cls+' safe-fallback';let comp=Array.isArray(data.comparables)?data.comparables:[];box.innerHTML='<div class="safe-verdict">'+esc(label)+'</div><p><b>Prix demandé :</b> '+esc(data.asking_display||'Non déterminé')+'</p><p><b>Marché estimé :</b> '+esc(data.median_display||'Non déterminé')+'<br><span>'+esc(data.gap_text||'Positionnement non déterminé.')+'</span></p><p>📊 '+comp.length+' comparable(s) retenu(s).</p><h3>💬 Axes d’amélioration / négociation</h3><div class="safe-neg"><ul><li>Demander les factures et l’historique d’entretien.</li><li>Vérifier le contrôle technique et les éventuels frais à venir.</li><li>Contrôler pneus, freins, carrosserie et cohérence du kilométrage.</li><li>'+( /insuffisant/i.test(label)?'Le marché est trop limité pour fixer une remise fiable : négociez uniquement sur des éléments vérifiables.':'Utiliser les comparables compatibles et les défauts constatés pour construire l’offre.')+'</li></ul></div>';market.appendChild(box)}
const native=window.fetch;window.fetch=async function(input,init){const u=typeof input==='string'?input:(input&&input.url)||'';if(u.includes('/api/analyze'))start();if(u.includes('/api/market'))marketStart();try{const r=await native.apply(this,arguments);if(u.includes('/api/analyze')){let d=null;try{d=await r.clone().json()}catch{}if(r.ok){vehicle=d?.vehicle||d;progress(52,'🔎 Lecture terminée…','Recherche du marché…','#2563eb')}else finish(false)}if(u.includes('/api/market')){let d=null;try{d=await r.clone().json()}catch{}if(r.ok){renderFallback(d);finish(true)}else finish(false)}return r}catch(e){if(u.includes('/api/analyze')||u.includes('/api/market'))finish(false);throw e}};
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('#go');if(b&&!b.disabled)start()},true);style();
})();</script>`;

function proxy(req,res){
  const options={hostname:'127.0.0.1',port:INNER_PORT,path:req.url,method:req.method,headers:{...req.headers,host:`127.0.0.1:${INNER_PORT}`}};
  const upstream=http.request(options,rr=>{
    const chunks=[];rr.on('data',c=>chunks.push(c));rr.on('end',()=>{
      let body=Buffer.concat(chunks);const headers={...rr.headers};
      delete headers['content-length'];delete headers['transfer-encoding'];delete headers['content-encoding'];
      const isRoot=req.method==='GET'&&(/^\/?$/.test(req.url?.split('?')[0]||'')||req.url?.split('?')[0]==='/index.html');
      if(isRoot&&rr.statusCode>=200&&rr.statusCode<300&&/text\/html/i.test(String(headers['content-type']||''))){body=Buffer.from(body.toString('utf8').replace(/<\/body>/i,FINAL_UI+'</body>'));headers['content-type']='text/html; charset=utf-8'}
      for(const[k,v]of Object.entries(headers))if(v!==undefined)res.setHeader(k,v);res.statusCode=rr.statusCode||502;res.setHeader('cache-control','no-store, no-cache, must-revalidate, proxy-revalidate');res.setHeader('content-length',body.length);res.end(body);
    })
  });
  upstream.on('error',e=>{if(!res.headersSent){res.statusCode=502;res.setHeader('content-type','application/json; charset=utf-8');res.end(JSON.stringify({error:'Service momentanément indisponible',detail:e.message}))}else res.end()});req.pipe(upstream)
}
http.createServer(proxy).listen(PUBLIC_PORT,()=>console.log(`Vaut le Coup production gateway listening on ${PUBLIC_PORT}, inner ${INNER_PORT}`));
