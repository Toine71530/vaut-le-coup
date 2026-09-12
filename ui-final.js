import http from "node:http";
import { spawn } from "node:child_process";
import express from "express";
import multer from "multer";

const PUBLIC_PORT = Number(process.env.PORT || 10000);
const BACKEND_PORT = 10002;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 3, fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|jpg)$/i.test(file.mimetype))
});

const child = spawn(process.execPath, ["market-wrapper.js"], {
  env: { ...process.env, PORT: String(BACKEND_PORT) },
  stdio: "inherit"
});
child.on("exit", (code, signal) => {
  if (code !== 0 && code !== null) process.exit(code);
  if (signal) process.exit(1);
});

const CSS = `<style id="vlc-final-css">
#previews.previews{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:10px!important;width:100%!important;margin:14px 0!important;padding:0!important;}
#previews.previews>.thumb{display:block!important;width:100%!important;min-width:0!important;height:auto!important;aspect-ratio:1/1!important;margin:0!important;position:relative!important;}
#previews.previews>.thumb img{display:block!important;width:100%!important;height:100%!important;object-fit:cover!important;border-radius:16px!important;}
.vlc-progress{display:none;margin:16px 0;padding:16px;border:1px solid #d9e1e8;border-radius:18px;background:#f8fafc;box-shadow:0 2px 10px #0000000b;}
.vlc-progress.visible{display:block}.vlc-progress-head{display:flex;justify-content:space-between;gap:12px;font-weight:800;margin-bottom:10px}.vlc-track{height:15px;background:#dfe6ec;border-radius:99px;overflow:hidden}.vlc-fill{height:100%;width:0;background:#2563eb;border-radius:99px;transition:width .35s ease,background-color .25s ease}.vlc-sub{margin:8px 0 0;color:#667788;font-size:13px}
.vlc-reading{margin-top:14px;padding:13px 15px;border-radius:15px;background:#eef6ff;font-weight:800}.vlc-reading small{display:block;margin-top:5px;color:#64748b;font-weight:500;line-height:1.4}
.vlc-negotiation{margin-top:18px;padding:16px;border-radius:18px;background:#fff8eb;border:1px solid #f0d39a;line-height:1.5}.vlc-negotiation h3{margin:0 0 8px;font-size:18px}.vlc-negotiation ul{margin:8px 0 0 20px;padding:0}
.vlc-market-card{border-radius:20px;padding:16px;border:2px solid #dfe5ea}.vlc-market-green{background:#ecfdf3;border-color:#86efac}.vlc-market-blue{background:#eff6ff;border-color:#93c5fd}.vlc-market-orange{background:#fff7ed;border-color:#fdba74}.vlc-market-red{background:#fef2f2;border-color:#fca5a5}
.vlc-verdict{display:inline-block;padding:9px 14px;border-radius:999px;font-size:21px;font-weight:900;margin-bottom:12px}.vlc-market-green .vlc-verdict{background:#bbf7d0;color:#166534}.vlc-market-blue .vlc-verdict{background:#dbeafe;color:#1e40af}.vlc-market-orange .vlc-verdict{background:#fed7aa;color:#9a3412}.vlc-market-red .vlc-verdict{background:#fecaca;color:#991b1b}
.vlc-price-gauge{margin:16px 0;padding:14px;border:1px solid #e1e6eb;border-radius:18px;background:#fff}.vlc-gauge-track{position:relative;height:18px;border-radius:99px;background:linear-gradient(90deg,#dc2626 0 25%,#f59e0b 25% 45%,#22c55e 45% 75%,#15803d 75% 100%)}.vlc-gauge-dot{position:absolute;top:50%;width:24px;height:24px;border-radius:50%;background:#17212b;border:4px solid white;box-shadow:0 1px 6px #0005;transform:translate(-50%,-50%);transition:left .35s ease}.vlc-gauge-labels{display:flex;justify-content:space-between;font-size:11px;color:#667788;margin-top:7px}
@media(max-width:480px){#previews.previews{gap:7px}.vlc-progress,.vlc-negotiation,.vlc-price-gauge{padding:13px}}
</style>`;

const JS = `<script id="vlc-final-js">
(function(){
  let progress, timer, current=0, lastMarket=null;
  const clamp=n=>Math.max(0,Math.min(100,Math.round(n)));
  function placeProgress(){
    if(progress && document.body.contains(progress)) return progress;
    progress=document.createElement('div'); progress.className='vlc-progress'; progress.id='vlc-progress';
    progress.innerHTML='<div class="vlc-progress-head"><span id="vlc-progress-label">🤖 Préparation de l’analyse…</span><b id="vlc-progress-pct">0 %</b></div><div class="vlc-track"><div class="vlc-fill" id="vlc-progress-fill"></div></div><div class="vlc-sub" id="vlc-progress-sub">Lecture des informations visibles.</div>';
    const anchor=document.getElementById('go')||document.getElementById('previews')||document.querySelector('main')||document.body;
    anchor.parentNode.insertBefore(progress,anchor.nextSibling); return progress;
  }
  function setProgress(n,label,sub,color){
    current=clamp(n); const p=placeProgress(); p.classList.add('visible');
    const f=document.getElementById('vlc-progress-fill'),pct=document.getElementById('vlc-progress-pct'),lab=document.getElementById('vlc-progress-label'),s=document.getElementById('vlc-progress-sub');
    if(f){f.style.width=current+'%';f.style.backgroundColor=color||'#2563eb'} if(pct)pct.textContent=current+' %'; if(lab)lab.textContent=label||'Analyse…'; if(s)s.textContent=sub||'';
  }
  function start(){clearInterval(timer);current=3;setProgress(3,'🤖 Analyse des photos…','Lecture et extraction des informations visibles.','#2563eb');timer=setInterval(()=>{if(current>=48){clearInterval(timer);return}setProgress(current+3,'🔎 Extraction des caractéristiques…','Vérification des informations visibles.','#2563eb')},350)}
  function marketStart(){clearInterval(timer);setProgress(55,'💶 Recherche du marché…','Recherche de comparables réellement compatibles.','#f59e0b');timer=setInterval(()=>{if(current>=91){clearInterval(timer);return}setProgress(current+3,'📊 Comparaison des prix…','Calcul du positionnement du prix.','#f59e0b')},400)}
  function finish(ok){clearInterval(timer);setProgress(100,ok?'✅ Analyse terminée':'⚠️ Analyse terminée avec réserve',ok?'Résultat prêt.':'Certaines données restent à vérifier.',ok?'#16a34a':'#f59e0b')}
  function photos(){const p=document.getElementById('previews');if(!p)return;p.style.setProperty('display','grid','important');p.style.setProperty('grid-template-columns','repeat(3,minmax(0,1fr))','important');p.style.setProperty('gap','10px','important');Array.from(p.children).forEach(t=>{t.style.setProperty('width','100%','important');t.style.setProperty('min-width','0','important');t.style.setProperty('height','auto','important');t.style.setProperty('aspect-ratio','1/1','important')})}
  function confidence(){const root=document.getElementById('analysis');if(!root)return;root.querySelectorAll('*').forEach(el=>{if(el.children.length)return;let t=(el.textContent||'').trim();if(!/confiance de lecture/i.test(t)||el.dataset.vlcDone)return;let m=t.match(/([0-9]+(?:[.,][0-9]+)?)\s*\/\s*100/);if(!m)return;let n=parseFloat(m[1].replace(',','.'));if(n<=1)n*=100;n=clamp(n);el.className='vlc-reading';el.innerHTML='🔎 Fiabilité des informations extraites : <b>'+n+'/100</b><small>Qualité de lecture des informations visibles. Ce score ne juge pas le véhicule et ne garantit pas sa valeur.</small>';el.dataset.vlcDone='1'})}
  function marketDecor(data){
    const m=document.getElementById('market');if(!m||m.hidden)return;
    const label=String(data?.label||m.innerText||''); let cls=/Très intéressant|Plutôt intéressant/i.test(label)?'vlc-market-green':/Dans le marché/i.test(label)?'vlc-market-blue':/insuffisant/i.test(label)?'vlc-market-orange':'vlc-market-red';m.classList.add('vlc-market-card',cls);
    let status=m.querySelector('.status');if(!status)status=m; let old=status.querySelector('.vlc-verdict');if(!old){old=document.createElement('div');old.className='vlc-verdict';old.textContent=data?.label||'Résultat marché';status.insertBefore(old,status.firstChild)}
    if(!status.querySelector('.vlc-price-gauge')){let ratio=50;if(data?.median&&data?.price_eur){const gap=(data.price_eur/data.median-1)*100;ratio=clamp(50-gap*2)}else if(cls==='vlc-market-green')ratio=72;else if(cls==='vlc-market-red')ratio=22;const g=document.createElement('div');g.className='vlc-price-gauge';g.innerHTML='<b>📍 Position du prix</b><div class="vlc-gauge-track" style="margin-top:10px"><i class="vlc-gauge-dot" style="left:'+ratio+'%"></i></div><div class="vlc-gauge-labels"><span>🔴 Cher</span><span>🟠 À surveiller</span><span>🟢 Intéressant</span></div>';status.appendChild(g)}
    if(!status.querySelector('.vlc-negotiation')){const insufficient=/insuffisant/i.test(label);const p=document.createElement('div');p.className='vlc-negotiation';p.innerHTML='<h3>💬 Axes d’amélioration / négociation</h3><ul><li>'+ (insufficient?'Ne pas fixer d’offre à partir d’une médiane non fiable.':'S’appuyer sur les comparables compatibles avant de faire une offre.') +'</li><li>Demander les factures et l’historique d’entretien.</li><li>Vérifier le contrôle technique, les pneus, les freins, la carrosserie et les éventuels gros travaux.</li><li>Tout défaut réel, frais à venir ou justificatif manquant peut devenir un argument de négociation.</li></ul>';status.appendChild(p)}
  }
  const nativeFetch=window.fetch;
  window.fetch=function(input,init){const url=typeof input==='string'?input:(input&&input.url)||'';if(url.includes('/api/analyze'))start();if(url.includes('/api/market'))marketStart();return nativeFetch.apply(this,arguments).then(async resp=>{if(url.includes('/api/analyze')){if(resp.ok)setProgress(52,'🔎 Lecture terminée…','Caractéristiques extraites. Recherche du marché…','#2563eb');else finish(false)}if(url.includes('/api/market')){if(resp.ok){try{lastMarket=await resp.clone().json()}catch{lastMarket=null}finish(true)}else finish(false)}setTimeout(()=>{photos();confidence();marketDecor(lastMarket)},80);return resp}).catch(err=>{if(url.includes('/api/analyze')||url.includes('/api/market'))finish(false);throw err})};
  document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('#go');if(b&&!b.disabled)start()},true);
  new MutationObserver(()=>{photos();confidence();marketDecor(lastMarket)}).observe(document.documentElement,{childList:true,subtree:true});
  setInterval(()=>{photos();confidence();marketDecor(lastMarket)},800); photos();
})();
</script>`;

function enhance(html){let out=String(html);out=out.replace('</head>',CSS+'</head>');out=out.replace('</body>',JS+'</body>');return out}

async function analyze(files){
  const key=process.env.GEMINI_API_KEY;if(!key)throw new Error('GEMINI_API_KEY manquante.');
  const prompt=`Tu es le moteur de lecture de l’application "Vaut le Coup ?". Analyse de 1 à 3 photos d’une annonce automobile. Croise toutes les photos. Utilise uniquement les informations réellement visibles. N’invente rien. Si absent, illisible ou ambigu : null. Ne déduis jamais une finition ni une puissance. Signale les contradictions visibles. Les mentions de garantie, entretien, première main ou CT sont des affirmations de l’annonce et ne sont pas vérifiées. La confiance mesure uniquement la qualité de lecture. Retourne UNIQUEMENT ce JSON : {"make":string|null,"model":string|null,"version":string|null,"year":number|null,"mileage_km":number|null,"price_eur":number|null,"energy":string|null,"gearbox":string|null,"power_hp":number|null,"seller_type":"professional"|"private"|null,"location":string|null,"title":string|null,"confidence":number,"uncertain_fields":string[],"visible_claims":string[],"warnings":string[]}`;
  const parts=[{text:prompt},...files.map(f=>({inline_data:{mime_type:f.mimetype,data:f.buffer.toString('base64')}}))];
  const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key='+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts}],generationConfig:{responseMimeType:'application/json',temperature:0}})});
  const d=await r.json();if(!r.ok)throw new Error(d?.error?.message||`Gemini HTTP ${r.status}`);const text=d?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim();if(!text)throw new Error('Réponse IA vide.');const a=text.indexOf('{'),b=text.lastIndexOf('}');if(a<0||b<=a)throw new Error('Réponse IA JSON invalide.');const v=JSON.parse(text.slice(a,b+1));let c=Number(v.confidence);if(Number.isFinite(c)){if(c<=1)c*=100;v.confidence=Math.max(0,Math.min(100,Math.round(c)))}else v.confidence=0;return v;
}

app.post('/api/analyze',upload.array('images',3),async(req,res)=>{try{if(!req.files?.length)return res.status(400).json({error:'Aucune image reçue.'});res.json(await analyze(req.files))}catch(e){res.status(500).json({error:e?.message||'Erreur analyse IA.'})}});

function proxy(req,res){const target=new URL(req.originalUrl,BACKEND_URL);const headers={...req.headers,host:'127.0.0.1:'+BACKEND_PORT};const options={hostname:'127.0.0.1',port:BACKEND_PORT,path:target.pathname+target.search,method:req.method,headers};const r=http.request(options,rr=>{res.statusCode=rr.statusCode||502;for(const [k,v] of Object.entries(rr.headers)){if(k.toLowerCase()!=='content-length')res.setHeader(k,v)}rr.pipe(res)});r.on('error',e=>{if(!res.headersSent)res.status(502).json({error:'Backend indisponible',detail:e.message})});req.pipe(r)}

app.get('*',(req,res)=>{if(req.path==='/'||req.path==='/index.html'){http.get(`${BACKEND_URL}/`,rr=>{let body='';rr.setEncoding('utf8');rr.on('data',c=>body+=c);rr.on('end',()=>res.status(rr.statusCode||200).send(enhance(body)))}).on('error',e=>res.status(502).send('Backend indisponible: '+e.message));return}proxy(req,res)});
app.use((req,res)=>proxy(req,res));
app.listen(PUBLIC_PORT,()=>console.log(`Vaut le Coup final UI listening on ${PUBLIC_PORT}`));
