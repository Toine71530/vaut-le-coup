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

const UI_CSS = '<style id="vaut-le-coup-ui-fix">' +
'.previews{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;grid-template-rows:1fr!important;gap:8px!important;width:100%!important;margin:14px 0 0!important;overflow:visible!important;flex-wrap:nowrap!important}' +
'.thumb{position:relative!important;width:100%!important;min-width:0!important;max-width:none!important;height:auto!important;aspect-ratio:1/1!important;margin:0!important;flex:none!important}' +
'.thumb img{display:block!important;width:100%!important;height:100%!important;object-fit:cover!important;border-radius:18px!important}' +
'.remove{right:-4px!important;top:-4px!important;width:32px!important;height:32px!important;z-index:5!important}' +
'.progress-wrap{display:block!important;margin-top:16px!important}' +
'.progress-head{display:flex!important;justify-content:space-between!important;align-items:center!important;gap:12px!important;margin-bottom:8px!important;font-size:16px!important;font-weight:700!important}' +
'.progress-track{width:100%!important;height:14px!important;border-radius:999px!important;background:#e4e8ec!important;overflow:hidden!important;box-shadow:inset 0 1px 2px #00000012!important}' +
'.progress-fill{width:0%;height:100%;border-radius:999px!important;background:#2f80ed!important;transition:width .55s ease,background-color .45s ease!important}' +
'.progress-percent{min-width:42px!important;text-align:right!important;font-variant-numeric:tabular-nums!important}' +
'@media(max-width:380px){.previews{gap:6px!important}}' +
'</style>';

const UI_JS = '<script id="vaut-le-coup-ui-fix-js">' +
'(()=>{' +
'const market=document.getElementById("market");if(!market)return;' +
'let timer=null,lastState="",progress=0;' +
'function ensure(){let w=market.querySelector(".progress-wrap");if(w)return w;w=document.createElement("div");w.className="progress-wrap";w.innerHTML="<div class=\"progress-head\"><span class=\"progress-label\">Préparation de l’analyse…</span><span class=\"progress-percent\">0 %</span></div><div class=\"progress-track\" role=\"progressbar\" aria-valuemin=\"0\" aria-valuemax=\"100\" aria-valuenow=\"0\"><div class=\"progress-fill\"></div></div>";const s=market.querySelector(".status");if(s)s.appendChild(w);else market.prepend(w);return w;}' +
'function set(v,label,color){progress=Math.max(progress,v);const w=ensure(),f=w.querySelector(".progress-fill"),p=w.querySelector(".progress-percent"),t=w.querySelector(".progress-label"),tr=w.querySelector(".progress-track");f.style.width=progress+"%";f.style.backgroundColor=color;p.textContent=progress+" %";t.textContent=label;tr.setAttribute("aria-valuenow",String(progress));}' +
'function advance(target){clearInterval(timer);timer=setInterval(()=>{if(progress>=target){clearInterval(timer);return;}set(progress+1,progress<55?"Analyse et extraction des informations…":"Recherche et comparaison du marché…",progress<60?"#2f80ed":"#f59e0b");},300);}' +
'function inspect(){const text=market.textContent||"";let state="";if(text.includes("Analyse des photos"))state="ai";else if(text.includes("Recherche des comparables"))state="market";else if(market.querySelector(".price"))state="done";else return;if(state===lastState)return;lastState=state;if(state==="ai"){progress=0;set(8,"Analyse des photos…","#2f80ed");advance(55);}else if(state==="market"){clearInterval(timer);set(60,"Recherche des comparables…","#f59e0b");advance(92);}else{clearInterval(timer);set(100,"Analyse terminée","#22a06b");}}' +
'new MutationObserver(inspect).observe(market,{childList:true,subtree:true,characterData:true});inspect();' +
'})();' +
'</script>';

function enhanceHtml(html) {
  let out = String(html);
  out = out.replace("</head>", UI_CSS + "</head>");
  out = out.replace("</body>", UI_JS + "</body>");
  return out;
}

function waitForBackend() {
  return new Promise((resolve) => {
    const tryIt = () => {
      const req = http.get(`${BACKEND_URL}/`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => setTimeout(tryIt, 150));
      req.setTimeout(1500, () => req.destroy());
    };
    tryIt();
  });
}

function proxy(req, res) {
  const options = {
    hostname: "127.0.0.1",
    port: BACKEND_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}` }
  };
  const upstream = http.request(options, (upstreamRes) => {
    const chunks = [];
    upstreamRes.on("data", (chunk) => chunks.push(chunk));
    upstreamRes.on("end", () => {
      const body = Buffer.concat(chunks);
      const contentType = String(upstreamRes.headers["content-type"] || "");
      if (req.method === "GET" && req.url === "/" && contentType.includes("text/html")) {
        const html = enhanceHtml(body.toString("utf8"));
        const headers = { ...upstreamRes.headers, "content-length": Buffer.byteLength(html), "cache-control": "no-store" };
        delete headers["content-encoding"];
        res.writeHead(upstreamRes.statusCode || 200, headers);
        res.end(html);
      } else {
        res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
        res.end(body);
      }
    });
  });
  upstream.on("error", (err) => {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`Backend indisponible: ${err.message}`);
  });
  req.pipe(upstream);
}

await waitForBackend();
const server = http.createServer((req, res) => proxy(req, res));
server.listen(PUBLIC_PORT, "0.0.0.0", () => console.log(`UI wrapper listening on ${PUBLIC_PORT}`));
process.on("SIGTERM", () => { child.kill("SIGTERM"); server.close(() => process.exit(0)); });
process.on("SIGINT", () => { child.kill("SIGINT"); server.close(() => process.exit(0)); });
