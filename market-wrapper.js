import express from "express";
import http from "http";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 10001);
const TARGET = `http://127.0.0.1:${INTERNAL_PORT}`;

// Only parse JSON requests. Multipart/form-data (photos) must keep its
// original request stream so it can be forwarded to the internal server.
app.use(express.json({ limit: "2mb" }));

const upper = (v) => String(v ?? "").toUpperCase();
function num(v) { if (typeof v === "number" && Number.isFinite(v)) return v; const s = String(v ?? "").replace(/\u00a0/g, " ").replace(/[^0-9,.-]/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", "."); const n = Number(s); return Number.isFinite(n) ? n : null; }
function year(v) { return num(v?.year); }
function km(v) { return num(v?.mileage_km ?? v?.mileage ?? v?.mileage_display); }
function price(v) { return num(v?.price_eur ?? v?.price ?? v?.price_display); }
function generation(v) { const s = [v?.make,v?.model,v?.version,v?.trim,v?.title,v?.name,v?.description].map(upper).join(" "); if (/\b(?:PRIUS\s*(?:5|V)|GEN(?:ERATION)?\s*5|MK\s*5)\b/.test(s)) return 5; if (/\b(?:PRIUS\s*(?:4|IV)|GEN(?:ERATION)?\s*4|MK\s*4)\b/.test(s)) return 4; if (/\b(?:PRIUS\s*(?:3|III)|GEN(?:ERATION)?\s*3|MK\s*3)\b/.test(s)) return 3; const y = year(v); if (/\bPRIUS\b/.test(s) && y !== null && y >= 2023) return 5; return null; }
function energy(v) { const s = [v?.energy,v?.version,v?.trim,v?.title,v?.name,v?.description].map(upper).join(" "); if (/PHEV|PLUG.?IN|RECHARGEABLE|HYBRIDE\s+RECHARGEABLE/.test(s)) return "phev"; if (/HYBRIDE|HEV/.test(s)) return "hybrid"; if (/ELECTRIQUE|\bEV\b/.test(s)) return "ev"; return null; }
function power(v) { const d = num(v?.power_hp ?? v?.power); if (d !== null && d >= 80 && d <= 1000) return d; const s = [v?.version,v?.trim,v?.title,v?.name,v?.description].map(upper).join(" "); const m = s.match(/(?:^|\D)(\d{3})\s*(?:CH|HP)(?:\D|$)/); return m ? Number(m[1]) : null; }
function gearbox(v) { const s = [v?.gearbox,v?.version,v?.title,v?.name].map(upper).join(" "); if (/AUTOMAT|E-CVT|CVT/.test(s)) return "automatic"; if (/MANUEL/.test(s)) return "manual"; return null; }
function seller(v) { return v?.seller_type ?? null; }
function targetModel(v) { return upper(v?.model || "PRIUS").replace(/\s+(?:IV|III|II|I|[0-9]+)$/i, "").trim() || "PRIUS"; }
function compatible(t, c) { const cg = generation(c), targetGen = generation(t); if (targetGen === 5 && cg !== 5) return false; if (targetGen && cg && targetGen !== cg) return false; const te = energy(t), ce = energy(c); if (te === "phev" && ce !== "phev") return false; if (te && ce && te !== ce) return false; const tp = power(t), cp = power(c); if (tp !== null && cp !== null && Math.abs(tp - cp) > 20) return false; if (tp !== null && cp === null) return false; const ty = year(t), cy = year(c); if (ty !== null && cy !== null && Math.abs(ty - cy) > 2) return false; const targetGearbox = gearbox(t), comparableGearbox = gearbox(c); if (targetGearbox && comparableGearbox && targetGearbox !== comparableGearbox) return false; const p = price(c); return p !== null && p > 0; }
function score(t,c) { let s = 0; const targetGen=generation(t), comparableGen=generation(c), te=energy(t), ce=energy(c), tp=power(t), cp=power(c), ty=year(t), cy=year(c), tk=km(t), ck=km(c); if (targetGen && targetGen===comparableGen) s += 100; if (te && te===ce) s += 80; if (tp && cp) s += Math.max(0,30-Math.abs(tp-cp)); if (ty && cy) s += Math.max(0,20-Math.abs(ty-cy)*5); if (tk && ck) s += Math.max(0,15-Math.min(15,Math.abs(tk-ck)/10000)); if (seller(c)==="professional") s += 2; return s; }
function median(a){ const x=[...a].sort((a,b)=>a-b); if(!x.length)return null; return x.length%2?x[(x.length-1)/2]:(x[x.length/2-1]+x[x.length/2])/2; }
function quantile(a,p){ const x=[...a].sort((a,b)=>a-b); if(!x.length)return null; if(x.length===1)return x[0]; const i=(x.length-1)*p,l=Math.floor(i),u=Math.ceil(i); return x[l]+(x[u]-x[l])*(i-l); }
function euro(n){ return n===null?"Non déterminé":Math.round(n).toLocaleString("fr-FR")+" €"; }
function kmDisplay(n){ return n===null?null:Math.round(n).toLocaleString("fr-FR")+" km"; }
function normalize(c){ const p=price(c), k=km(c); return {...c,price_eur:p,mileage_km:k,price_display:euro(p),mileage_display:kmDisplay(k)}; }
function formatComparable(c){ const n=normalize(c); const link=n.source_url||n.url||n.link||null; return { price_display:n.price_display, price_eur:n.price_eur, year:n.year??null, mileage_display:n.mileage_display, mileage_km:n.mileage_km, energy:n.energy??null, version:n.version||n.finition||n.trim||null, source:n.source??null, url:link, link, source_url:link, seller_type:n.seller_type??null }; }
async function searchCarHunt(key, make, model, targetYear) { const params = new URLSearchParams({ make, model, page_size:"50" }); if (targetYear !== null) params.set("year", String(targetYear)); const r = await fetch(`https://api-pro.carhunt.fr/v1/listings/search?${params}`, { headers:{Authorization:`Bearer ${key}`} }); if(!r.ok) throw new Error(`CarHunt HTTP ${r.status}: ${await r.text()}`); const d=await r.json(); return Array.isArray(d.listings)?d.listings:[]; }
async function market(body) { const key=process.env.CARHUNT_API_KEY; if(!key) return {error:"CARHUNT_API_KEY manquante."}; const t=body||{}; const make=upper(t.make||"TOYOTA").trim(); const model=targetModel(t); const ty=year(t), tk=km(t), asking=price(t), targetGen=generation(t), te=energy(t), tp=power(t); if(!make || !model) return {error:"Marque et modèle nécessaires."}; let raw=await searchCarHunt(key,make,model,ty); if(raw.length<10) raw=raw.concat(await searchCarHunt(key,make,model,null)); const seen=new Set(), candidates=[]; for(const item of raw.map(normalize)){ const id=item.id||[item.make,item.model,item.year,item.mileage,item.price,item.source_url].join("|"); if(seen.has(id)) continue; seen.add(id); if(asking!==null && price(item)===asking && ty!==null && year(item)===ty && tk!==null && km(item)===tk) continue; if(compatible(t,item)) candidates.push(item); } candidates.sort((a,b)=>score(t,b)-score(t,a)); const top=candidates.slice(0,20), prices=top.map(price).filter(n=>n!==null); if(prices.length<3){ return {asking_display:euro(asking),price_eur:asking,median_display:"Non déterminé",median:null,low_display:"Non déterminé",low:null,high_display:"Non déterminé",high:null,confidence:Math.min(20,prices.length*7),label:"Données de marché insuffisantes",gap_text:`${prices.length} comparable(s) réellement compatible(s). Pas d'estimation artificielle.`,warning:`Seulement ${prices.length} comparable(s) compatibles avec la génération, l'énergie et la puissance identifiées.`,comparables_count:prices.length,comparables:top.slice(0,10).map(formatComparable)}; } const med=median(prices), low=quantile(prices,.15), high=quantile(prices,.85); const gap=asking!==null&&med?Math.round((asking/med-1)*100):null; const confidence=Math.min(95,45+Math.min(5,prices.length)*8+((targetGen&&te&&tp)?12:0)); const label=gap===null?"Marché comparable":gap<=-10?"Très intéressant":gap<=-3?"Plutôt intéressant":gap<=3?"Dans le marché":gap<=10?"Plutôt cher":"Cher"; return {asking_display:euro(asking),price_eur:asking,median_display:euro(med),median:med,low_display:euro(low),low,high_display:euro(high),high,confidence,label,gap_text:gap===null?"Écart au marché non déterminé.":`Le prix demandé est ${Math.abs(gap)}% ${gap>=0?"au-dessus":"en dessous"} du prix médian.`,warning:prices.length<5?"Échantillon encore limité : interpréter la fourchette avec prudence.":null,comparables_count:prices.length,comparables:top.slice(0,10).map(formatComparable)}; }

function proxy(req, res) {
  const isMarket = req.path === "/api/market";

  if (isMarket) {
    market(req.body)
      .then((data) => res.status(200).json(data))
      .catch((e) => res.status(500).json({ error: e.message || "Erreur marché." }));
    return;
  }

  const headers = { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}` };
  const r = http.request(`${TARGET}${req.originalUrl}`, { method: req.method, headers }, (up) => {
    const chunks = [];
    up.on("data", (c) => chunks.push(c));
    up.on("end", () => {
      const raw = Buffer.concat(chunks);
      const type = String(up.headers["content-type"] || "");
      if (type.includes("text/html")) {
        let html = raw.toString("utf8");
        html = html.replace("</head>", `<style>
.previews{display:flex;flex-wrap:nowrap;gap:10px;margin-top:12px;overflow-x:auto;align-items:flex-start}
.thumb{position:relative;flex:1 1 0;width:auto;max-width:none;height:auto;aspect-ratio:1;min-width:0}
.thumb img{width:100%;height:100%;object-fit:cover;border-radius:18px;border:1px solid #ddd}
.remove{z-index:2}
.analysis-progress{display:none;margin-top:18px;padding:18px;border-radius:20px;background:#f4f7fa;border:1px solid #dce4eb}
.analysis-progress.active{display:block}
.analysis-progress-title{font-weight:800;font-size:18px;margin-bottom:10px}
.analysis-progress-track{height:12px;background:#e1e6eb;border-radius:99px;overflow:hidden}
.analysis-progress-bar{height:100%;width:8%;border-radius:99px;background:#17212b;transition:width .7s ease}
.analysis-progress-note{font-size:14px;color:#68727d;margin-top:9px}
</style></head>`);
        html = html.replace("<div id=\"error\"></div>", `<div id="error"></div><div id="analysis-progress" class="analysis-progress" aria-live="polite"><div id="analysis-progress-title" class="analysis-progress-title">Analyse des photos…</div><div class="analysis-progress-track"><div id="analysis-progress-bar" class="analysis-progress-bar"></div></div><div id="analysis-progress-note" class="analysis-progress-note">Lecture des informations visibles</div></div>`);
        html = html.replace("</body>", `<script>(function(){const go=document.getElementById('go'),box=document.getElementById('analysis-progress'),bar=document.getElementById('analysis-progress-bar'),title=document.getElementById('analysis-progress-title'),note=document.getElementById('analysis-progress-note'),error=document.getElementById('error');if(!go||!box)return;let timer=null,step=0;const stages=[['Analyse des photos…','Lecture des informations visibles',18],['Extraction des données…','Identification du véhicule, du prix et du kilométrage',38],['Vérification…','Contrôle des informations détectées',58],['Recherche du marché…','Recherche de véhicules réellement comparables',78],['Finalisation…','Préparation du résultat',92]];function setStage(i){const s=stages[Math.min(i,stages.length-1)];title.textContent=s[0];note.textContent=s[1];bar.style.width=s[2]+'%';}function start(){if(!go||go.disabled)return;box.classList.add('active');step=0;setStage(0);clearInterval(timer);timer=setInterval(()=>{if(step<stages.length-1){step++;setStage(step)}},1800)}function finish(){clearInterval(timer);bar.style.width='100%';title.textContent='Analyse terminée';note.textContent='Résultat prêt';setTimeout(()=>box.classList.remove('active'),500)}document.addEventListener('click',e=>{if(e.target===go){setTimeout(start,0)}},true);new MutationObserver(()=>{if(error&&error.textContent.trim()){box.classList.remove('active');clearInterval(timer)}const market=document.getElementById('market');if(market&&!market.hidden&&market.innerText.trim())finish()}).observe(document.body,{subtree:true,childList:true,characterData:true});})();</script></body>`);
        rawHtmlSend(res, up.statusCode || 200, html);
        return;
      }
      res.status(up.statusCode || 200);
      Object.entries(up.headers).forEach(([k, v]) => { if (!['transfer-encoding', 'content-length'].includes(k.toLowerCase()) && v != null) res.set(k, v); });
      res.send(raw);
    });
  });
  r.on("error", (e) => res.status(502).json({ error: e.message || "Service interne indisponible." }));
  req.pipe(r);
}

function rawHtmlSend(res, status, html) { res.status(status).set("content-type", "text/html; charset=utf-8").send(Buffer.from(html)); }

app.use((req, res) => proxy(req, res));

const child = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(INTERNAL_PORT) }, stdio: "inherit" });
child.on("exit", (code) => { if (code && code !== 0) process.exit(code); });
app.listen(PORT, "0.0.0.0", () => console.log(`Vaut le Coup wrapper ${PORT}; server ${INTERNAL_PORT}`));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
