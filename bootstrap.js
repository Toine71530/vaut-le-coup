// Production bootstrap: resilient Gemini + reliable UI progress.
import http from "node:http";

const nativeFetch = globalThis.fetch;
const INTERNAL_PORT = 10003;
const PUBLIC_PORT = Number(process.env.PORT || 10000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isGeminiGenerate(url) {
  return typeof url === "string" && url.includes("generativelanguage.googleapis.com") && url.includes(":generateContent");
}
function replaceModel(url, model) {
  return url.replace(/\/models\/[^:]+:generateContent/, `/models/${model}:generateContent`);
}

async function resilientGeminiFetch(input, init) {
  const originalUrl = typeof input === "string" ? input : input?.url;
  if (!isGeminiGenerate(originalUrl)) return nativeFetch(input, init);

  // Stable multimodal models. Start with the economical Flash-Lite model and
  // move upward only when Google reports a transient capacity/rate-limit error.
  const models = ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-2.5-flash-lite"];
  let lastResponse;
  for (let i = 0; i < models.length; i++) {
    const url = replaceModel(originalUrl, models[i]);
    const request = typeof input === "string" ? url : new Request(url, input);
    const response = await nativeFetch(request, init);
    lastResponse = response;
    if (response.ok) return response;
    if (![408, 429, 500, 502, 503, 504].includes(response.status)) return response;
    if (i < models.length - 1) await sleep(Math.min(8000, 1000 * 2 ** i) + Math.floor(Math.random() * 400));
  }
  return lastResponse;
}

globalThis.fetch = resilientGeminiFetch;
process.env.PORT = String(INTERNAL_PORT);
await import("./ui-final.js");

// Guaranteed visible progress overlay. It is independent of the page's own
// UI code so it remains visible even when the analysis takes a long time.
const PROGRESS_SCRIPT = `<script id="vlc-reliable-progress">(function(){let timer=null,value=0,busy=false;function ensure(){let b=document.getElementById('vlc-live-progress');if(b)return b;b=document.createElement('div');b.id='vlc-live-progress';b.innerHTML='<div class="vlc-live-head"><strong id="vlc-live-label">🤖 Analyse des photos…</strong><b id="vlc-live-pct">0 %</b></div><div class="vlc-live-track"><div id="vlc-live-fill"></div></div><div id="vlc-live-sub">Lecture des informations visibles dans vos captures.</div>';document.body.appendChild(b);return b}function style(){if(document.getElementById('vlc-live-style'))return;let s=document.createElement('style');s.id='vlc-live-style';s.textContent='#vlc-live-progress{position:fixed;z-index:2147483647;left:10px;right:10px;top:10px;padding:14px 16px;background:#fff;border:2px solid #dbe3ea;border-radius:18px;box-shadow:0 8px 30px #0003;display:none;font-family:system-ui,-apple-system,sans-serif}.vlc-live-head{display:flex;justify-content:space-between;gap:12px;font-size:15px;margin-bottom:9px}.vlc-live-track{height:14px;background:#e7edf2;border-radius:99px;overflow:hidden}.vlc-live-track>#vlc-live-fill{height:100%;width:0;background:#2563eb;border-radius:99px;transition:width .35s ease,background-color .25s ease}.vlc-live-sub{font-size:12px;color:#64748b;margin-top:7px}.vlc-live-spin{display:inline-block;width:12px;height:12px;border:2px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;animation:vlcspin .7s linear infinite;margin-right:6px;vertical-align:-1px}@keyframes vlcspin{to{transform:rotate(360deg)}}';document.head.appendChild(s)}function set(n,label,sub,color){style();let b=ensure();b.style.display='block';value=Math.max(0,Math.min(100,Math.round(n)));document.getElementById('vlc-live-fill').style.width=value+'%';document.getElementById('vlc-live-fill').style.backgroundColor=color||'#2563eb';document.getElementById('vlc-live-pct').textContent=value+' %';document.getElementById('vlc-live-label').innerHTML='<span class="vlc-live-spin"></span>'+label;document.getElementById('vlc-live-sub').textContent=sub||''}function start(){clearInterval(timer);busy=true;set(5,'Analyse des photos…','L’IA lit et croise les informations visibles.','#2563eb');timer=setInterval(()=>{if(value<48)set(value+3,'Analyse des photos…','Lecture progressive des captures.','#2563eb')},650)}function done(ok){clearInterval(timer);busy=false;set(100,ok?'Analyse terminée':'Analyse interrompue',ok?'Résultat prêt.':'Le service IA est temporairement indisponible. Vous pouvez réessayer.',ok?'#16a34a':'#dc2626');setTimeout(()=>{let b=document.getElementById('vlc-live-progress');if(b)b.style.display='none'},ok?2200:7000)}document.addEventListener('click',e=>{let b=e.target.closest&&e.target.closest('#go');if(b&&!b.disabled)start()},true);let old=window.fetch;window.fetch=function(input,init){let u=typeof input==='string'?input:(input&&input.url)||'';if(u.includes('/api/analyze'))start();if(u.includes('/api/market')){clearInterval(timer);set(58,'Recherche du marché…','Recherche de comparables compatibles.','#f59e0b');busy=true}return old.apply(this,arguments).then(r=>{if(u.includes('/api/analyze')){if(r.ok)set(52,'Lecture terminée…','Les caractéristiques sont extraites. Recherche du marché…','#2563eb');else done(false)}if(u.includes('/api/market')){if(r.ok)done(true);else done(false)}return r}).catch(err=>{if(u.includes('/api/analyze')||u.includes('/api/market'))done(false);throw err})};window.addEventListener('error',e=>{if(busy&&e.message)done(false)});})();</script>`;

const server = http.createServer((req, res) => {
  const options = { hostname: "127.0.0.1", port: INTERNAL_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}` } };
  const upstream = http.request(options, upstreamRes => {
    const chunks = [];
    upstreamRes.on("data", chunk => chunks.push(chunk));
    upstreamRes.on("end", () => {
      const headers = { ...upstreamRes.headers };
      delete headers["content-length"]; delete headers["transfer-encoding"]; delete headers["content-encoding"];
      for (const [key,value] of Object.entries(headers)) if(value!==undefined) res.setHeader(key,value);
      res.statusCode = upstreamRes.statusCode || 502;
      let body = Buffer.concat(chunks);
      const isAnalyze = req.url?.split("?")[0] === "/api/analyze";
      const isRoot = req.method === "GET" && (req.url === "/" || req.url?.split("?")[0] === "/index.html");
      if(isAnalyze){try{const parsed=JSON.parse(body.toString('utf8'));const normalized=parsed?.vehicle?parsed:(parsed?.make||parsed?.model||parsed?.year||parsed?.price_eur?{ok:true,vehicle:parsed}:parsed);body=Buffer.from(JSON.stringify(normalized));res.setHeader('content-type','application/json; charset=utf-8')}catch{}}
      if(isRoot && res.statusCode>=200 && res.statusCode<300 && /text\/html/i.test(String(headers['content-type']||''))){body=Buffer.from(body.toString('utf8').replace(/<\/body>/i,PROGRESS_SCRIPT+'</body>'));res.setHeader('content-type','text/html; charset=utf-8')}
      res.setHeader('cache-control','no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('content-length',body.length);res.end(body);
    });
  });
  upstream.on("error",err=>{if(!res.headersSent){res.statusCode=502;res.setHeader("content-type","application/json; charset=utf-8");res.end(JSON.stringify({error:"Service momentanément indisponible",detail:err.message}))}else res.end()});
  req.pipe(upstream);
});
server.listen(PUBLIC_PORT,()=>console.log(`Vaut le Coup public proxy listening on ${PUBLIC_PORT}`));
