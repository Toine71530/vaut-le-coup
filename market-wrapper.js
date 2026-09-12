import express from "express";
import http from "http";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 10001);
const TARGET = `http://127.0.0.1:${INTERNAL_PORT}`;
app.use(express.json({ limit: "2mb" }));

const num = (v) => {
  const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const median = (a) => {
  const x = [...a].sort((a,b) => a-b);
  if (!x.length) return null;
  const i = Math.floor(x.length / 2);
  return x.length % 2 ? x[i] : (x[i-1] + x[i]) / 2;
};
const quantile = (a,p) => {
  const x = [...a].sort((a,b) => a-b);
  if (!x.length) return null;
  const i = (x.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return x[lo] + (x[hi] - x[lo]) * (i - lo);
};
const euro = (n) => n == null ? "Non déterminé" : Math.round(n).toLocaleString("fr-FR") + " €";

async function market(body) {
  const key = process.env.CARHUNT_API_KEY;
  if (!key) return { error: "CARHUNT_API_KEY manquante." };
  const v = body || {};
  const make = String(v.make || "").trim();
  const model = String(v.model || "").trim();
  if (!make || !model) return { error: "Marque et modèle nécessaires." };

  const params = new URLSearchParams({ make, model, page_size: "100" });
  if (v.year) {
    params.set("year_min", String(Number(v.year) - 1));
    params.set("year_max", String(Number(v.year) + 1));
  }
  if (v.mileage_km) {
    const k = Number(v.mileage_km);
    params.set("mileage_min", String(Math.max(0, k - 30000)));
    params.set("mileage_max", String(k + 30000));
  }
  if (v.energy) params.set("energy", String(v.energy));
  if (v.gearbox) params.set("gearbox", String(v.gearbox));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(`https://api-pro.carhunt.fr/v1/listings/search?${params}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal
    });
    if (!r.ok) throw new Error(`CarHunt HTTP ${r.status}`);
    const data = await r.json();
    const listings = (data.listings || []).filter(x => num(x.price) != null && num(x.price) > 0);
    const prices = listings.map(x => num(x.price));
    const med = median(prices);
    const asking = num(v.price_eur);
    if (med == null) {
      return { ok:true, comparables:0, asking_display:euro(asking), median_display:"Non déterminé", low_display:"Non déterminé", high_display:"Non déterminé", confidence:0, label:"Données de marché insuffisantes", gap_text:"Aucun comparable exploitable trouvé." };
    }
    const gap = asking != null ? Math.round((asking / med - 1) * 100) : null;
    const label = gap == null ? "Marché comparable" : gap <= -10 ? "Très intéressant" : gap <= -3 ? "Plutôt intéressant" : gap <= 3 ? "Dans le marché" : gap <= 10 ? "Plutôt cher" : "Cher";
    const confidence = Math.min(95, 45 + Math.min(5, prices.length) * 8 + (v.year && v.energy && v.power_hp ? 12 : 0));
    return {
      ok:true, comparables:prices.length, asking_display:euro(asking), price_eur:asking,
      median_display:euro(med), median:med, low_display:euro(quantile(prices,.15)), low:quantile(prices,.15),
      high_display:euro(quantile(prices,.85)), high:quantile(prices,.85), confidence, label,
      gap_text: gap == null ? "Écart au marché non déterminé." : `Le prix demandé est ${Math.abs(gap)}% ${gap >= 0 ? "au-dessus" : "en dessous"} du prix médian.`,
      warning: prices.length < 5 ? "Échantillon limité : interpréter la fourchette avec prudence." : null,
      sample:listings.slice(0,10).map(x => ({ price:x.price, year:x.year, mileage:x.mileage, energy:x.energy, gearbox:x.gearbox, horsepower:x.horsepower, seller_type:x.seller_type, source:x.source, source_url:x.source_url }))
    };
  } catch (e) {
    if (e.name === "AbortError") return { error:"La recherche marché prend trop de temps. Le service marché est momentanément indisponible ; l’analyse IA reste disponible." };
    return { error:e.message || "Erreur marché." };
  } finally { clearTimeout(timeout); }
}

function inject(html) {
  html = html.replace("</head>", `<style>
.previews{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:10px!important;width:100%!important;overflow:visible!important}
.thumb{width:100%!important;min-width:0!important;aspect-ratio:1/1!important;height:auto!important}
.thumb img{width:100%!important;height:100%!important;object-fit:cover!important}
.analysis-progress{display:none;margin-top:18px;padding:18px;border-radius:20px;background:#f4f7fa;border:1px solid #dce4eb}
.analysis-progress.active{display:block}
.analysis-progress-title{font-weight:800;font-size:18px;margin-bottom:10px}.analysis-progress-track{height:14px;background:#e1e6eb;border-radius:99px;overflow:hidden}.analysis-progress-bar{height:100%;width:5%;border-radius:99px;background:#2563eb;transition:width .7s ease}.analysis-progress-note{font-size:14px;color:#68727d;margin-top:9px}
</style></head>`);
  html = html.replace('<div id="error"></div>', '<div id="error"></div><div id="analysis-progress" class="analysis-progress" aria-live="polite"><div id="analysis-progress-title" class="analysis-progress-title">Analyse des photos…</div><div class="analysis-progress-track"><div id="analysis-progress-bar" class="analysis-progress-bar"></div></div><div id="analysis-progress-note" class="analysis-progress-note">Lecture des informations visibles</div></div>');
  html = html.replace('</body>', `<script>(function(){const b=document.getElementById('go'),p=document.getElementById('analysis-progress'),bar=document.getElementById('analysis-progress-bar'),title=document.getElementById('analysis-progress-title'),note=document.getElementById('analysis-progress-note'),a=document.getElementById('analysis'),m=document.getElementById('market'),err=document.getElementById('error');if(!b||!p)return;let timer=null,i=0;const s=[['Analyse des photos…','Lecture des informations visibles',18],['Extraction des données…','Identification du véhicule, du prix et du kilométrage',38],['Vérification…','Contrôle des informations détectées',58],['Recherche du marché…','Recherche de véhicules comparables',78],['Finalisation…','Préparation du résultat',94]];function set(n){const x=s[Math.min(n,s.length-1)];title.textContent=x[0];note.textContent=x[1];bar.style.width=x[2]+'%'}function start(){p.classList.add('active');i=0;set(0);clearInterval(timer);timer=setInterval(()=>{if(i<s.length-1){i++;set(i)}},1700)}function stop(ok){clearInterval(timer);if(ok){bar.style.width='100%';title.textContent='Analyse terminée';note.textContent='Résultat prêt';setTimeout(()=>p.classList.remove('active'),900)}else{p.classList.remove('active')}}const originalFetch=window.fetch.bind(window);window.fetch=function(input,init){const url=typeof input==='string'?input:(input&&input.url)||'';if(url.includes('/api/market')){const controller=new AbortController();const opts={...(init||{}),signal:controller.signal};const timeout=setTimeout(()=>controller.abort(),12000);return originalFetch(input,opts).then(r=>{clearTimeout(timeout);return r}).catch(e=>{clearTimeout(timeout);if(e.name==='AbortError')return new Response(JSON.stringify({error:'La recherche du marché est momentanément indisponible. L’analyse IA reste disponible.'}),{status:503,headers:{'Content-Type':'application/json'}});throw e})}return originalFetch(input,init)};document.addEventListener('click',e=>{if(e.target===b)start()},true);new MutationObserver(()=>{if(err&&err.textContent.trim())stop(false);if(m&&!m.hidden&&m.innerText.trim())stop(true)}).observe(document.body,{subtree:true,childList:true,characterData:true})})();</script></body>`);
  return html;
}

function proxy(req,res) {
  if (req.path === "/api/market") {
    market(req.body).then(data => res.status(data.error ? 503 : 200).json(data)).catch(e => res.status(500).json({error:e.message || "Erreur marché."}));
    return;
  }
  const headers = { ...req.headers, host:`127.0.0.1:${INTERNAL_PORT}` };
  const r = http.request(`${TARGET}${req.originalUrl}`, { method:req.method, headers }, up => {
    const chunks=[]; up.on("data",c=>chunks.push(c)); up.on("end",()=>{
      const raw=Buffer.concat(chunks); const type=String(up.headers["content-type"]||"");
      if(type.includes("text/html")){
        const html=inject(raw.toString("utf8"));
        res.status(up.statusCode||200).set({"content-type":"text/html; charset=utf-8","cache-control":"no-store"}).send(html); return;
      }
      res.status(up.statusCode||200); Object.entries(up.headers).forEach(([k,v])=>{if(!["transfer-encoding","content-length"].includes(k.toLowerCase())&&v!=null)res.set(k,v)}); res.send(raw);
    });
  });
  r.on("error",e=>res.status(502).json({error:e.message||"Service interne indisponible."})); req.pipe(r);
}
app.use((req,res)=>proxy(req,res));
const child=spawn(process.execPath,["server.js"],{env:{...process.env,PORT:String(INTERNAL_PORT)},stdio:"inherit"});
child.on("exit",code=>{if(code&&code!==0)process.exit(code)});
app.listen(PORT,"0.0.0.0",()=>console.log(`Vaut le Coup wrapper ${PORT}; server ${INTERNAL_PORT}`));
process.on("SIGTERM",()=>child.kill("SIGTERM")); process.on("SIGINT",()=>child.kill("SIGINT"));
