import http from "node:http";
import { spawn } from "node:child_process";
import express from "express";
import multer from "multer";

const PUBLIC_PORT = Number(process.env.PORT || 10000);
const BACKEND_PORT = 10002;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 3, fileSize: 12 * 1024 * 1024 }, fileFilter: (_r, f, cb) => cb(null, /^image\/(jpeg|png|webp|jpg)$/i.test(f.mimetype)) });

const child = spawn(process.execPath, ["market-wrapper.js"], { env: { ...process.env, PORT: String(BACKEND_PORT) }, stdio: "inherit" });
child.on("exit", (code, signal) => { if (code !== 0 && code !== null) process.exit(code); if (signal) process.exit(1); });

const UI_CSS = `<style id="vlc-ui">
#previews.previews{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:10px!important;width:100%!important}
#previews.previews>.thumb{width:100%!important;min-width:0!important;height:auto!important;aspect-ratio:1/1!important;display:block!important;margin:0!important}
#previews.previews>.thumb img{width:100%!important;height:100%!important;object-fit:cover!important}
#vlc-progress{display:none!important;position:sticky!important;top:8px!important;z-index:9999!important;margin:12px 0!important;padding:16px!important;border-radius:20px!important;background:#fff!important;border:1px solid #d7dee6!important;box-shadow:0 8px 24px #0002!important}
#vlc-progress.vlc-visible{display:block!important}
.vlc-head{display:flex!important;justify-content:space-between!important;font-weight:900!important;font-size:16px!important;margin-bottom:9px!important}
.vlc-track{height:15px!important;background:#e2e8f0!important;border-radius:99px!important;overflow:hidden!important}.vlc-fill{height:100%!important;width:0%;background:#2563eb;border-radius:99px;transition:width .35s ease,background .25s ease!important}.vlc-sub{margin:8px 0 0!important;color:#64748b!important;font-size:14px!important}
.vlc-confidence{margin-top:15px!important;padding:14px 16px!important;border-radius:16px!important;background:#eff6ff!important;font-weight:900!important}.vlc-confidence small{display:block!important;margin-top:5px!important;color:#64748b!important;font-weight:500!important;line-height:1.4!important}
.vlc-negotiation{margin-top:20px!important;padding:18px!important;border-radius:18px!important;background:#fff7ed!important;border:1px solid #fdba74!important}.vlc-negotiation h3{margin:0 0 8px!important;font-size:19px!important}.vlc-negotiation p{margin:0!important;line-height:1.55!important}
.vlc-verdict{padding:15px!important;border-radius:18px!important;font-weight:900!important;border:1px solid transparent!important}.vlc-green{background:#dcfce7!important;color:#166534!important;border-color:#86efac!important}.vlc-blue{background:#dbeafe!important;color:#1e40af!important;border-color:#93c5fd!important}.vlc-orange{background:#ffedd5!important;color:#9a3412!important;border-color:#fdba74!important}.vlc-red{background:#fee2e2!important;color:#991b1b!important;border-color:#fca5a5!important}
@media(max-width:480px){#previews.previews{gap:7px!important}.vlc-confidence,.vlc-negotiation{padding:14px!important}}
</style>`;

const UI_JS = `<script id="vlc-ui-js">(function(){
function ready(f){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',f,{once:true});else f()}
ready(function(){
let progress=null,value=0,timer=null;
function ensure(){if(progress&&document.body.contains(progress))return progress;progress=document.createElement('div');progress.id='vlc-progress';progress.innerHTML='<div class="vlc-head"><span id="vlc-label">🤖 Préparation de l’analyse…</span><b id="vlc-pct">0 %</b></div><div class="vlc-track"><div class="vlc-fill" id="vlc-fill"></div></div><p class="vlc-sub" id="vlc-sub">Analyse des informations visibles.</p>';let target=document.querySelector('main')||document.getElementById('go')?.parentElement||document.body;target.prepend(progress);return progress}
function set(v,label,sub,color){value=Math.max(value,Math.min(100,Math.round(v)));ensure().classList.add('vlc-visible');let f=document.getElementById('vlc-fill'),p=document.getElementById('vlc-pct'),l=document.getElementById('vlc-label'),s=document.getElementById('vlc-sub');if(f){f.style.width=value+'%';f.style.background=color||'#2563eb'}if(p)p.textContent=value+' %';if(l)l.textContent=label;if(s)s.textContent=sub}
function start(){clearInterval(timer);value=3;set(3,'🤖 Analyse des photos…','Lecture des informations visibles.','#2563eb');timer=setInterval(()=>{if(value>=48)return clearInterval(timer);set(value+3,'🔎 Analyse des photos…','Extraction et vérification des caractéristiques.','#2563eb')},400)}
function market(){clearInterval(timer);set(55,'💶 Recherche du marché…','Recherche de véhicules réellement compatibles.','#f59e0b');timer=setInterval(()=>{if(value>=90)return clearInterval(timer);set(value+3,'📊 Comparaison des prix…','Calcul du positionnement.','#f59e0b')},450)}
function done(ok){clearInterval(timer);set(100,ok?'✅ Analyse terminée':'⚠️ Analyse terminée avec réserve',ok?'Résultat prêt.':'Une partie des données doit être vérifiée.',ok?'#16a34a':'#f59e0b')}
function photos(){let p=document.getElementById('previews');if(!p)return;p.classList.add('previews');p.style.setProperty('display','grid','important');p.style.setProperty('grid-template-columns','repeat(3,minmax(0,1fr))','important');p.style.setProperty('gap','10px','important');Array.from(p.children).forEach(x=>{x.style.setProperty('width','100%','important');x.style.setProperty('height','auto','important');x.style.setProperty('aspect-ratio','1/1','important');x.style.setProperty('display','block','important')})}
function confidence(){let r=document.getElementById('analysis');if(!r)return;Array.from(r.querySelectorAll('*')).forEach(e=>{if(e.children.length)return;let t=e.textContent||'';if(!/confiance de lecture/i.test(t))return;let m=t.match(/(\\d+(?:[.,]\\d+)?)\\s*\\/\\s*100/);if(!m)return;let n=parseFloat(m[1].replace(',','.'));if(n<=1)n*=100;e.className='vlc-confidence';e.innerHTML='🔎 Fiabilité de lecture : '+Math.round(Math.max(0,Math.min(100,n)))+'/100<small>Qualité de lecture des informations visibles. Ce score ne juge pas le véhicule et ne garantit pas sa valeur.</small>'})}
function result(){let m=document.getElementById('market');if(!m||m.hidden)return;let text=(m.innerText||'').trim(),low=text.toLowerCase();if(!text)return;Array.from(m.querySelectorAll('*')).forEach(e=>{if(e.children.length)return;let t=e.textContent||'';if(!/Très intéressant|Plutôt intéressant|Dans le marché|Plutôt cher|Cher/i.test(t))return;e.classList.add('vlc-verdict');if(/Très intéressant|Plutôt intéressant/i.test(t))e.classList.add('vlc-green');else if(/Dans le marché/i.test(t))e.classList.add('vlc-blue');else if(/Plutôt cher/i.test(t))e.classList.add('vlc-orange');else e.classList.add('vlc-red')});if(!m.querySelector('.vlc-negotiation')){let p=document.createElement('div');p.className='vlc-negotiation';let advice;if(/insuffisant|non déterminé|aucun|erreur/.test(low))advice='Le marché disponible est insuffisant pour fixer une remise fiable. Demandez les factures d’entretien, vérifiez le contrôle technique, le kilométrage, les pneus, les freins et les travaux à venir. Comparez au moins 2 ou 3 véhicules réellement équivalents avant de faire une offre.';else if(/plutôt cher|cher/.test(low))advice='Le prix semble élevé face aux comparables. Appuyez la négociation sur les annonces comparables et sur les éléments vérifiables : entretien, factures, contrôle technique, kilométrage, pneus, freins, carrosserie et frais à venir.';else advice='Le prix paraît cohérent, mais il reste possible de négocier sur des éléments vérifiables : entretien, factures, contrôle technique, pneus, freins, carrosserie, deuxième clé et travaux à prévoir. Utilisez les comparables comme base.';p.innerHTML='<h3>💬 Axes d’amélioration / négociation</h3><p>'+advice+'</p>';m.appendChild(p)}}
let native=window.fetch;window.fetch=function(input,init){let url=typeof input==='string'?input:(input&&input.url)||'';if(url.includes('/api/analyze'))start();if(url.includes('/api/market'))market();return native.apply(this,arguments).then(r=>{if(url.includes('/api/analyze')){if(r.ok)set(52,'🔎 Lecture terminée…','Recherche du marché…','#2563eb');else done(false)}if(url.includes('/api/market'))done(r.ok);setTimeout(()=>{photos();confidence();result()},100);return r}).catch(e=>{if(url.includes('/api/analyze')||url.includes('/api/market'))done(false);throw e})};
document.addEventListener('click',e=>{let b=e.target.closest&&e.target.closest('#go');if(b&&!b.disabled)start()},true);photos();new MutationObserver(()=>{photos();confidence();result()}).observe(document.body,{childList:true,subtree:true});setInterval(()=>{photos();confidence();result()},800)
})})();</script>`;

function enhanceHtml(html){let out=String(html);if(!out.includes('id="vlc-ui"'))out=out.replace('</head>',UI_CSS+'</head>');if(!out.includes('id="vlc-ui-js"'))out=out.replace('</body>',UI_JS+'</body>');return out}

async function readResponse(res){const text=await res.text();let data=null;try{data=text?JSON.parse(text):null}catch{}return {text,data}}
async function callGemini(files){
 const key=process.env.GEMINI_API_KEY;if(!key)throw new Error('GEMINI_API_KEY manquante.');
 const prompt=`Tu es le moteur de lecture de "Vaut le Coup ?". Analyse 1 à 3 captures d'une annonce automobile. Utilise uniquement ce qui est réellement visible. N'invente rien. Si absent/illisible/ambigu: null. Ne déduis jamais une finition ou une puissance. Les affirmations du vendeur ne sont pas des faits vérifiés. Retourne UNIQUEMENT JSON avec make,model,version,year,mileage_km,price_eur,energy,gearbox,power_hp,seller_type,location,title,confidence,uncertain_fields,visible_claims,warnings.`;
 const parts=[{text:prompt},...files.map(f=>({inline_data:{mime_type:f.mimetype,data:f.buffer.toString('base64')}}))];
 let last='';
 for(let attempt=0;attempt<3;attempt++){
   const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key='+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts}],generationConfig:{responseMimeType:'application/json',temperature:0}})});
   const {text,data}=await readResponse(r);last=data?.error?.message||text||'';
   if(r.ok){const raw=data?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim()||'';const a=raw.indexOf('{'),b=raw.lastIndexOf('}');if(a>=0&&b>a){try{const v=JSON.parse(raw.slice(a,b+1));let c=Number(v.confidence);if(Number.isFinite(c)){if(c<=1)c*=100;v.confidence=Math.round(Math.max(0,Math.min(100,c)))}else v.confidence=0;return v}catch(e){last='JSON IA invalide'}}}
   if(attempt<2)await new Promise(r=>setTimeout(r,900*(attempt+1)));
 }
 throw new Error(last||'Le service IA est temporairement indisponible.');
}

app.post('/api/analyze',upload.array('images',3),async(req,res)=>{try{if(!req.files?.length)throw new Error('Ajoutez au moins une photo.');const vehicle=await callGemini(req.files);res.json({vehicle,...vehicle});}catch(e){res.status(502).json({error:e?.message||'Analyse impossible pour le moment.'})}});

app.use(async(req,res,next)=>{
 if(req.path==='/api/market'&&req.method==='POST')return next();
 if(req.method==='GET'&&req.path==='/'){try{const r=await fetch(BACKEND_URL+'/');const text=await r.text();res.status(r.status).type('html').send(enhanceHtml(text));}catch(e){res.status(502).send('Service temporairement indisponible.');}return}
 const body=await new Promise(resolve=>{let chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>resolve(Buffer.concat(chunks)))});const headers={...req.headers,host:undefined};delete headers['content-length'];const r=await fetch(BACKEND_URL+req.originalUrl,{method:req.method,headers,body:body.length?body:undefined});const ab=await r.arrayBuffer();res.status(r.status);for(const [k,v] of r.headers)if(k.toLowerCase()!=='content-encoding'&&k.toLowerCase()!=='transfer-encoding')res.setHeader(k,v);res.send(Buffer.from(ab));
});

app.post('/api/market',express.json({limit:'2mb'}),async(req,res)=>{try{
 const incoming=req.body||{};const vehicle=incoming.vehicle&&typeof incoming.vehicle==='object'?incoming.vehicle:incoming;
 const payload={...incoming,vehicle};
 const r=await fetch(BACKEND_URL+'/api/market',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 const {text,data}=await readResponse(r);res.status(r.status).type('application/json').send(data?JSON.stringify(data):text||JSON.stringify({error:'Réponse marché vide.'}));
 }catch(e){res.status(502).json({error:e?.message||'Recherche du marché impossible pour le moment.'})}});

app.get('*',(req,res)=>res.status(404).send('Not found'));

function waitForBackend(){return new Promise(resolve=>{const loop=()=>{const r=http.get(BACKEND_URL+'/',x=>{x.resume();resolve()});r.on('error',()=>setTimeout(loop,200));r.setTimeout(1200,()=>r.destroy())};loop()})}
await waitForBackend();
app.listen(PUBLIC_PORT,()=>console.log(`Vaut le Coup UI listening on ${PUBLIC_PORT}`));
