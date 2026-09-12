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

const UI_CSS = `<style id="vaut-le-coup-ui-fix">
/* Photos: toujours 3 colonnes */
#previews.previews{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;grid-auto-rows:auto!important;gap:10px!important;width:100%!important;margin:14px 0!important;padding:0!important;align-items:stretch!important;}
#previews.previews>.thumb{display:block!important;position:relative!important;width:100%!important;min-width:0!important;max-width:none!important;height:auto!important;aspect-ratio:1/1!important;margin:0!important;}
#previews.previews>.thumb img{display:block!important;width:100%!important;height:100%!important;object-fit:cover!important;border-radius:18px!important;}
#previews.previews>.thumb .remove{right:-5px!important;top:-5px!important;z-index:10!important;}
/* Jauge d'avancement */
#vlc-progress{display:none!important;margin-top:18px!important;padding:18px!important;border-radius:20px!important;background:#f7f9fb!important;border:1px solid #d8e0e7!important;box-shadow:0 2px 8px #0000000a!important;}
#vlc-progress.vlc-visible{display:block!important;}
#vlc-progress .vlc-head{display:flex!important;justify-content:space-between!important;align-items:center!important;gap:12px!important;margin-bottom:10px!important;font-size:16px!important;font-weight:800!important;}
#vlc-progress .vlc-track{height:16px!important;width:100%!important;background:#dfe6ec!important;border-radius:999px!important;overflow:hidden!important;}
#vlc-progress .vlc-fill{height:100%!important;width:0%!important;background:#2563eb!important;border-radius:999px!important;transition:width .35s ease,background-color .25s ease!important;}
#vlc-progress .vlc-sub{margin:9px 0 0!important;color:#667788!important;font-size:14px!important;}
/* Confiance */
.vlc-confidence{margin-top:16px!important;padding:14px 16px!important;border-radius:16px!important;background:#eef6ff!important;font-weight:800!important;}
.vlc-confidence small{display:block!important;margin-top:5px!important;color:#637487!important;font-weight:500!important;line-height:1.4!important;}
/* Négociation */
.vlc-negotiation{margin-top:20px!important;padding:18px!important;border-radius:18px!important;background:#fff7e6!important;border:1px solid #f0d39a!important;}
.vlc-negotiation h3{margin:0 0 8px!important;font-size:19px!important;}
.vlc-negotiation p{margin:0!important;line-height:1.5!important;}
/* Verdict */
.vlc-verdict{border-radius:18px!important;padding:18px!important;font-weight:900!important;border:1px solid transparent!important;}
.vlc-green{background:#dcfce7!important;color:#166534!important;border-color:#86efac!important;}
.vlc-blue{background:#dbeafe!important;color:#1e40af!important;border-color:#93c5fd!important;}
.vlc-orange{background:#ffedd5!important;color:#9a3412!important;border-color:#fdba74!important;}
.vlc-red{background:#fee2e2!important;color:#991b1b!important;border-color:#fca5a5!important;}
@media(max-width:480px){#previews.previews{gap:7px!important}.vlc-confidence,.vlc-negotiation{padding:14px!important}}
</style>`;

const UI_JS = `<script id="vaut-le-coup-ui-fix-js">
(function(){
  function ready(fn){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',fn,{once:true});else fn();}
  ready(function(){
    var progress=null, value=0, timer=null;
    function ensureProgress(){
      if(progress && document.body.contains(progress)) return progress;
      progress=document.createElement('div');
      progress.id='vlc-progress';
      progress.innerHTML='<div class="vlc-head"><span id="vlc-label">🤖 Préparation de l’analyse…</span><b id="vlc-pct">0 %</b></div><div class="vlc-track"><div class="vlc-fill" id="vlc-fill"></div></div><p class="vlc-sub" id="vlc-sub">Analyse des informations visibles.</p>';
      var target=document.getElementById('go')?.parentElement || document.querySelector('main');
      if(target) target.appendChild(progress); else document.body.appendChild(progress);
      return progress;
    }
    function setProgress(v,label,sub,color){
      value=Math.max(value,Math.min(100,Math.round(v)));
      var w=ensureProgress();w.classList.add('vlc-visible');
      var f=document.getElementById('vlc-fill'),p=document.getElementById('vlc-pct'),l=document.getElementById('vlc-label'),s=document.getElementById('vlc-sub');
      if(f){f.style.width=value+'%';f.style.backgroundColor=color||'#2563eb';}
      if(p)p.textContent=value+' %';if(l)l.textContent=label||'Analyse…';if(s)s.textContent=sub||'';
    }
    function startProgress(){clearInterval(timer);value=3;setProgress(3,'🤖 Analyse des photos…','Lecture et extraction des informations visibles.','#2563eb');timer=setInterval(function(){if(value>=48){clearInterval(timer);return;}setProgress(value+3,'🔎 Extraction des caractéristiques…','Vérification des informations visibles.','#2563eb');},350);}
    function marketProgress(){clearInterval(timer);setProgress(55,'💶 Recherche du marché…','Comparaison avec des véhicules réellement compatibles.','#f59e0b');timer=setInterval(function(){if(value>=90){clearInterval(timer);return;}setProgress(value+3,'📊 Comparaison des prix…','Calcul du positionnement du prix.','#f59e0b');},400);}
    function finishProgress(ok){clearInterval(timer);setProgress(100,ok?'✅ Analyse terminée':'⚠️ Analyse terminée avec réserve',ok?'Résultat prêt.':'Certaines données restent à vérifier.',ok?'#16a34a':'#f59e0b');}

    /* Photos: réapplique le layout après chaque ajout */
    function fixPhotos(){
      var p=document.getElementById('previews');if(!p)return;
      p.classList.add('previews');
      p.style.setProperty('display','grid','important');
      p.style.setProperty('grid-template-columns','repeat(3,minmax(0,1fr))','important');
      p.style.setProperty('grid-auto-rows','auto','important');
      p.style.setProperty('gap','10px','important');
      Array.prototype.forEach.call(p.children,function(t){
        t.style.setProperty('width','100%','important');t.style.setProperty('height','auto','important');t.style.setProperty('aspect-ratio','1/1','important');t.style.setProperty('display','block','important');t.style.setProperty('min-width','0','important');
      });
    }
    fixPhotos();
    new MutationObserver(function(){fixPhotos();}).observe(document.body,{childList:true,subtree:true});

    /* Si le navigateur a déjà une fonction d'affichage, on la laisse faire puis on corrige le DOM. */
    function fixConfidence(){
      var root=document.getElementById('analysis');if(!root)return;
      var nodes=root.querySelectorAll('*');
      Array.prototype.forEach.call(nodes,function(el){
        if(el.children.length) return;
        var txt=(el.textContent||'').trim();
        if(!/confiance de lecture/i.test(txt)) return;
        var m=txt.match(/(\\d+(?:[.,]\\d+)?)\\s*\\/\\s*100/);if(!m)return;
        var n=parseFloat(m[1].replace(',','.'));
        if(n<=1)n*=100;
        n=Math.max(0,Math.min(100,n));
        el.className='vlc-confidence';
        el.innerHTML='🔎 Fiabilité de lecture : '+Math.round(n)+'/100<small>Qualité de lecture des informations visibles. Ce score ne juge pas le véhicule et ne garantit pas sa valeur.</small>';
      });
    }

    function addNegotiation(){
      var market=document.getElementById('market');if(!market||market.hidden)return;
      if(market.querySelector('.vlc-negotiation'))return;
      var text=(market.innerText||'').toLowerCase();
      var p=document.createElement('div');p.className='vlc-negotiation';
      var advice;
      if(/insuffisant|non calcul|aucun|erreur/.test(text)){
        advice='Le marché disponible est insuffisant pour fixer un prix de négociation fiable. Avant de faire une offre, demande les factures d’entretien, vérifie le contrôle technique et les gros travaux, puis compare au moins 2 ou 3 annonces réellement équivalentes. Toute dépense à prévoir ou justificatif manquant peut servir d’argument de négociation.';
      }else if(/cher/.test(text)){
        advice='Le prix paraît élevé par rapport au marché comparable. Demande les justificatifs d’entretien et les factures, vérifie le kilométrage et le contrôle technique, puis appuie ta négociation sur les annonces comparables et sur les éventuels frais à prévoir (pneus, freins, carrosserie, entretien).';
      }else{
        advice='Même si le prix paraît cohérent, négocie sur des éléments vérifiables : factures d’entretien, contrôle technique, état des pneus et freins, carrosserie, deuxième clé et travaux à prévoir. Compare aussi 2 ou 3 annonces réellement équivalentes avant de faire ton offre.';
      }
      p.innerHTML='<h3>💬 Axes d’amélioration / négociation</h3><p>'+advice+'</p>';
      market.appendChild(p);
    }

    function colorVerdict(){
      var market=document.getElementById('market');if(!market||market.hidden)return;
      var els=market.querySelectorAll('*');
      Array.prototype.forEach.call(els,function(el){
        if(el.children.length)return;
        var t=(el.textContent||'').trim();if(!t)return;
        if(!/Très intéressant|Plutôt intéressant|Dans le marché|Plutôt cher|Cher/i.test(t))return;
        el.classList.add('vlc-verdict');
        if(/Très intéressant|Plutôt intéressant/i.test(t))el.classList.add('vlc-green');
        else if(/Dans le marché/i.test(t))el.classList.add('vlc-blue');
        else if(/Plutôt cher/i.test(t))el.classList.add('vlc-orange');
        else el.classList.add('vlc-red');
      });
    }

    var nativeFetch=window.fetch;
    window.fetch=function(input,init){
      var url=typeof input==='string'?input:(input&&input.url)||'';
      if(url.indexOf('/api/analyze')>=0)startProgress();
      if(url.indexOf('/api/market')>=0)marketProgress();
      return nativeFetch.apply(this,arguments).then(function(resp){
        if(url.indexOf('/api/analyze')>=0){if(resp.ok)setProgress(52,'🔎 Lecture terminée…','Caractéristiques extraites. Recherche du marché…','#2563eb');else finishProgress(false);}
        if(url.indexOf('/api/market')>=0){if(resp.ok)finishProgress(true);else finishProgress(false);}
        setTimeout(function(){fixPhotos();fixConfidence();colorVerdict();addNegotiation();},50);
        return resp;
      }).catch(function(err){if(url.indexOf('/api/analyze')>=0||url.indexOf('/api/market')>=0)finishProgress(false);throw err;});
    };

    /* Le bouton peut lancer l'analyse même si l'implémentation change: on démarre visuellement dès le clic. */
    document.addEventListener('click',function(e){
      var b=e.target.closest && e.target.closest('#go');
      if(b && !b.disabled){startProgress();setTimeout(function(){fixPhotos();},30);}
    },true);

    setInterval(function(){fixPhotos();fixConfidence();colorVerdict();addNegotiation();},700);
  });
})();
</script>`;

function enhanceHtml(html){
  let out=String(html);
  out=out.replace('</head>',UI_CSS+'</head>');
  out=out.replace('</body>',UI_JS+'</body>');
  return out;
}

function waitForBackend(){
  return new Promise(resolve=>{
    const tryIt=()=>{
      const req=http.get(`${BACKEND_URL}/`,res=>{res.resume();resolve();});
      req.on('error',()=>setTimeout(tryIt,150));
      req.setTimeout(1500,()=>req.destroy());
    };
    tryIt();
  });
}

async function analyzeWithGemini(files){
  const key=process.env.GEMINI_API_KEY;
  if(!key)throw new Error('GEMINI_API_KEY manquante. L’analyse IA gratuite n’est pas configurée.');
  const prompt=`Tu es le moteur de lecture de l'application "Vaut le Coup ?". Analyse de 1 à 3 photos d'une annonce automobile. Croise toutes les photos. Utilise uniquement les informations réellement visibles. N'invente rien. Si une information est absente, illisible ou ambiguë: null. Ne déduis jamais une finition ni une puissance. Signale les contradictions et défauts réellement visibles. Les mentions "1ère main", "garantie" ou "entretien constructeur" sont des affirmations de l'annonce, pas des faits vérifiés. La confiance concerne uniquement la qualité de lecture. Retourne UNIQUEMENT cet objet JSON: {"make":string|null,"model":string|null,"version":string|null,"year":number|null,"mileage_km":number|null,"price_eur":number|null,"energy":string|null,"gearbox":string|null,"power_hp":number|null,"seller_type":"professional"|"private"|null,"location":string|null,"title":string|null,"confidence":number,"uncertain_fields":string[],"visible_claims":string[],"warnings":string[]}`;
  const parts=[{text:prompt}];
  for(const file of files)parts.push({inline_data:{mime_type:file.mimetype,data:file.buffer.toString('base64')}});
  const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key='+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts}],generationConfig:{responseMimeType:'application/json',temperature:0}})});
  const data=await response.json();
  if(!response.ok)throw new Error(data?.error?.message||`Gemini HTTP ${response.status}`);
  const text=data?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim();
  if(!text)throw new Error('Réponse IA vide.');
  const start=text.indexOf('{'),end=text.lastIndexOf('}');
  if(start<0||end<=start)throw new Error('Réponse IA JSON invalide.');
  const vehicle=JSON.parse(text.slice(start,end+1));
  let confidence=Number(vehicle.confidence);
  if(Number.isFinite(confidence)){
    if(confidence<=1)confidence*=100;
    vehicle.confidence=Math.max(0,Math.min(100,confidence));
  }else vehicle.confidence=0;
  return vehicle;
}

function proxy(req,res){
  const options={hostname:'127.0.0.1',port:BACKEND_PORT,path:req.url,method:req.method,headers:{...req.headers,host:`127.0.0.1:${BACKEND_PORT}`, 'cache-control':'no-cache'}};
  const upstream=http.request(options,upstreamRes=>{
    const chunks=[];
    upstreamRes.on('data',c=>chunks.push(c));
    upstreamRes.on('end',()=>{
      const body=Buffer.concat(chunks),type=String(upstreamRes.headers['content-type']||'');
      if(req.method==='GET'&&req.url==='/'&&type.includes('text/html')){
        const html=enhanceHtml(body.toString('utf8'));
        const headers={...upstreamRes.headers,'content-length':Buffer.byteLength(html),'cache-control':'no-store, no-cache, must-revalidate, max-age=0'};
        delete headers['content-encoding'];
        res.writeHead(upstreamRes.statusCode||200,headers);res.end(html);return;
      }
      res.writeHead(upstreamRes.statusCode||200,upstreamRes.headers);res.end(body);
    });
  });
  upstream.on('error',err=>{res.statusCode=502;res.setHeader('content-type','text/plain; charset=utf-8');res.end(`Backend indisponible: ${err.message}`);});
  req.pipe(upstream);
}

app.post('/api/analyze',upload.array('images',3),async(req,res)=>{
  try{
    if(!req.files?.length)return res.status(400).json({error:'Ajoute au moins une photo.'});
    const vehicle=await analyzeWithGemini(req.files);
    res.json({ok:true,vehicle});
  }catch(error){
    console.error('Gemini vision error:',error);
    const msg=String(error?.message||'Erreur pendant l’analyse IA.');
    const status=/GEMINI_API_KEY manquante/i.test(msg)?503:(/429|quota|rate.?limit/i.test(msg)?429:500);
    res.status(status).json({error:status===429?'Le service IA gratuit a atteint sa limite temporaire. Réessaie plus tard.':msg});
  }
});

app.use((req,res)=>proxy(req,res));

await waitForBackend();
const server=http.createServer(app);
server.listen(PUBLIC_PORT,'0.0.0.0',()=>console.log(`Vaut le Coup free-vision wrapper listening on ${PUBLIC_PORT}`));
process.on('SIGTERM',()=>{child.kill('SIGTERM');server.close(()=>process.exit(0));});
process.on('SIGINT',()=>{child.kill('SIGINT');server.close(()=>process.exit(0));});
