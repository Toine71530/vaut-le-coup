import http from "node:http";
import { spawn } from "node:child_process";

const PUBLIC_PORT = Number(process.env.PORT || 10000);
const BACKEND_PORT = 10002;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

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
    var previews=document.getElementById('previews');
    if(previews){ previews.style.cssText='display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;grid-template-rows:1fr!important;gap:8px!important;width:100%!important;margin:14px 0 0!important;padding:0!important;'; }
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
      var w=document.getElementById('vlc-progress');
      if(w)return w;
      w=document.createElement('div'); w.id='vlc-progress'; w.className='vlc-progress';
      w.innerHTML='<div class="vlc-progress-head"><span class="vlc-progress-label">Analyse des photos…</span><span class="vlc-progress-pct">0 %</span></div><div class="vlc-progress-track"><div class="vlc-progress-fill"></div></div>';
      market.appendChild(w); return w;
    }
    function set(v,label,color){
      value=Math.max(value,v); var w=ensure(); w.classList.add('visible');
      var f=w.querySelector('.vlc-progress-fill'),p=w.querySelector('.vlc-progress-pct'),l=w.querySelector('.vlc-progress-label');
      f.style.width=value+'%'; f.style.backgroundColor=color; p.textContent=value+' %'; l.textContent=label;
    }
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

await waitForBackend();
const server=http.createServer((req,res)=>proxy(req,res));
server.listen(PUBLIC_PORT,'0.0.0.0',()=>console.log(`UI wrapper listening on ${PUBLIC_PORT}`));
process.on('SIGTERM',()=>{child.kill('SIGTERM');server.close(()=>process.exit(0));});
process.on('SIGINT',()=>{child.kill('SIGINT');server.close(()=>process.exit(0));});
