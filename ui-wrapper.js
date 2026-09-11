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
.previews{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;grid-template-rows:1fr!important;gap:8px!important;width:100%!important;margin:14px 0 0!important;padding:0!important;overflow:visible!important;}
.thumb{position:relative!important;width:100%!important;min-width:0!important;max-width:none!important;height:auto!important;aspect-ratio:1/1!important;margin:0!important;display:block!important;}
.thumb img{display:block!important;width:100%!important;height:100%!important;object-fit:cover!important;border-radius:18px!important;}
.remove{right:-4px!important;top:-4px!important;width:32px!important;height:32px!important;z-index:5!important;}
.vlc-progress{display:none!important;margin-top:16px!important;padding:16px!important;border-radius:20px!important;background:#f4f7fa!important;border:1px solid #dce4eb!important;}
.vlc-progress.visible{display:block!important;}
.vlc-progress-head{display:flex!important;justify-content:space-between!important;align-items:center!important;gap:10px!important;margin-bottom:9px!important;font-size:16px!important;font-weight:800!important;}
.vlc-progress-track{width:100%!important;height:14px!important;background:#e2e7ec!important;border-radius:999px!important;overflow:hidden!important;}
.vlc-progress-fill{height:100%!important;width:0%!important;border-radius:999px!important;background:#2f80ed!important;transition:width .45s ease,background-color .3s ease!important;}
.vlc-progress-pct{font-variant-numeric:tabular-nums!important;white-space:nowrap!important;}
@media(max-width:420px){.previews{gap:6px!important}.remove{width:30px!important;height:30px!important}}
</style>`;

const UI_JS = `<script id="vaut-le-coup-ui-fix-js">
(function(){
  function ready(fn){ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',fn); else fn(); }
  ready(function(){
    var market=document.getElementById('market');
    function fixThumbs(){
      var p=document.getElementById('previews'); if(!p)return;
      p.style.cssText='display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;grid-template-rows:1fr!important;gap:8px!important;width:100%!important;margin:14px 0 0!important;padding:0!important;overflow:visible!important;';
      Array.prototype.forEach.call(p.children,function(t){t.style.cssText='position:relative!important;width:100%!important;min-width:0!important;max-width:none!important;height:auto!important;aspect-ratio:1/1!important;margin:0!important;display:block!important;';});
    }
    new MutationObserver(fixThumbs).observe(document.body,{childList:true,subtree:true});
    fixThumbs();
    if(!market)return;
    var timer=null, value=0, run=0;
    function ensure(){
      var w=document.getElementById('vlc-progress'); if(w)return w;
      w=document.createElement('div'); w.id='vlc-progress'; w.className='vlc-progress';
      w.innerHTML='<div class="vlc-progress-head"><span class="vlc-progress-label">Analyse des photos…</span><span class="vlc-progress-pct">0 %</span></div><div class="vlc-progress-track"><div class="vlc-progress-fill"></div></div>';
      market.appendChild(w); return w;
    }
    function set(v,label,color){ value=Math.max(value,v); var w=ensure(); w.classList.add('visible'); var f=w.querySelector('.vlc-progress-fill'),p=w.querySelector('.vlc-progress-pct'),l=w.querySelector('.vlc-progress-label'); f.style.width=value+'%'; f.style.backgroundColor=color; p.textContent=value+' %'; l.textContent=label; }
    function start(){clearInterval(timer);value=5;run++;var r=run;set(5,'Analyse des photos…','#2f80ed');timer=setInterval(function(){if(r!==run||value>=55){clearInterval(timer);return;}set(value+1,'Analyse et extraction des informations…','#2f80ed');},350);}
    function marketStart(){clearInterval(timer);set(60,'Recherche des comparables…','#f59e0b');timer=setInterval(function(){if(value>=92){clearInterval(timer);return;}set(value+1,'Recherche et comparaison du marché…','#f59e0b');},450);}
    function done(){clearInterval(timer);run++;set(100,'Analyse terminée','#22a06b');}
    var nativeFetch=window.fetch;
    window.fetch=function(input,init){
      var url=typeof input==='string'?input:(input&&input.url)||'';
      if(url.indexOf('/api/analyze')!==-1) start();
      if(url.indexOf('/api/market')!==-1) marketStart();
      return nativeFetch.apply(this,arguments).then(function(resp){
        if(url.indexOf('/api/analyze')!==-1 && resp.ok) set(55,'Informations extraites — recherche du marché…','#2563eb');
        if(url.indexOf('/api/market')!==-1 && resp.ok) done();
        return resp;
      });
    };
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

async function analyzeWithGemini(files) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY manquante. L’analyse IA gratuite n’est pas configurée.");

  const prompt = `Tu es le moteur de lecture de l'application "Vaut le Coup ? — Avant d'acheter. Demande à l'IA.".
Analyse de 1 à 3 photos d'une annonce automobile.
Croise les informations de toutes les photos. Utilise uniquement les informations réellement visibles. N'invente rien. Si une information est absente, illisible ou ambiguë : null. Ne déduis jamais une finition ni une puissance. Signale les contradictions et les défauts réellement visibles. Les mentions comme "1ère main", "garantie" ou "entretien constructeur" sont des affirmations de l'annonce et ne sont pas vérifiées. Ne prétends jamais avoir vérifié l'historique, le kilométrage ou le marché. La confiance concerne uniquement la qualité de lecture.
Retourne UNIQUEMENT cet objet JSON :
{"make":string|null,"model":string|null,"version":string|null,"year":number|null,"mileage_km":number|null,"price_eur":number|null,"energy":string|null,"gearbox":string|null,"power_hp":number|null,"seller_type":"professional"|"private"|null,"location":string|null,"title":string|null,"confidence":number,"uncertain_fields":string[],"visible_claims":string[],"warnings":string[]}`;

  const parts = [{ text: prompt }];
  for (const file of files) {
    parts.push({ inline_data: { mime_type: file.mimetype, data: file.buffer.toString("base64") } });
  }

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(key), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", temperature: 0 }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || `Gemini HTTP ${response.status}`;
    throw new Error(message);
  }

  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
  if (!text) throw new Error("Réponse IA vide.");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Réponse IA JSON invalide.");
  return JSON.parse(text.slice(start, end + 1));
}

function proxy(req,res){
  const options={hostname:'127.0.0.1',port:BACKEND_PORT,path:req.url,method:req.method,headers:{...req.headers,host:`127.0.0.1:${BACKEND_PORT}`}};
  const upstream=http.request(options,upstreamRes=>{
    const chunks=[];
    upstreamRes.on('data',c=>chunks.push(c));
    upstreamRes.on('end',()=>{
      const body=Buffer.concat(chunks);
      const type=String(upstreamRes.headers['content-type']||'');
      if(req.method==='GET'&&req.url==='/'&&type.includes('text/html')){
        const html=enhanceHtml(body.toString('utf8'));
        const headers={...upstreamRes.headers,'content-length':Buffer.byteLength(html),'cache-control':'no-store, no-cache, must-revalidate'};
        delete headers['content-encoding'];
        res.writeHead(upstreamRes.statusCode||200,headers);res.end(html);return;
      }
      res.writeHead(upstreamRes.statusCode||200,upstreamRes.headers);res.end(body);
    });
  });
  upstream.on('error',err=>{res.statusCode=502;res.setHeader('content-type','text/plain; charset=utf-8');res.end(`Backend indisponible: ${err.message}`);});
  req.pipe(upstream);
}

app.post('/api/analyze', upload.array('images', 3), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'Ajoute au moins une photo.' });
    const vehicle = await analyzeWithGemini(req.files);
    res.json({ ok: true, vehicle });
  } catch (error) {
    console.error('Gemini vision error:', error);
    const msg = String(error?.message || 'Erreur pendant l’analyse IA.');
    const status = /GEMINI_API_KEY manquante/i.test(msg) ? 503 : (/429|quota|rate.?limit/i.test(msg) ? 429 : 500);
    res.status(status).json({ error: status === 429 ? 'Le service IA gratuit a atteint sa limite temporaire. Réessaie plus tard.' : msg });
  }
});

app.use((req,res)=>proxy(req,res));

await waitForBackend();
const server=http.createServer(app);
server.listen(PUBLIC_PORT,'0.0.0.0',()=>console.log(`Vaut le Coup free-vision wrapper listening on ${PUBLIC_PORT}`));
process.on('SIGTERM',()=>{child.kill('SIGTERM');server.close(()=>process.exit(0));});
process.on('SIGINT',()=>{child.kill('SIGINT');server.close(()=>process.exit(0));});
