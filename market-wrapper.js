import express from "express";
import http from "http";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 10001);
const TARGET = `http://127.0.0.1:${INTERNAL_PORT}`;
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

function enhanceHtml(html) {
  const css = `<style id="vlc-mobile-fix">
.previews{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:10px!important;width:100%!important;margin-top:12px!important;padding:0!important;align-items:stretch!important}
.previews .thumb{display:block!important;position:relative!important;width:100%!important;min-width:0!important;max-width:none!important;height:auto!important;aspect-ratio:1/1!important;margin:0!important;padding:0!important}
.previews .thumb img{display:block!important;width:100%!important;height:100%!important;object-fit:cover!important;margin:0!important}
.remove{z-index:10!important}
.vlc-gauge-wrap{margin:22px 0 8px;padding:18px 16px 14px;border-radius:22px;background:#fff;border:1px solid #e1e5e9;text-align:center}
.vlc-gauge{position:relative;width:min(310px,100%);height:155px;margin:0 auto;overflow:hidden}
.vlc-gauge::before{content:"";position:absolute;left:5%;right:5%;bottom:-62%;width:90%;height:150%;border-radius:50%;background:conic-gradient(from 270deg,#dc2626 0deg,#f59e0b 70deg,#eab308 105deg,#22c55e 150deg,#16a34a 180deg,transparent 180deg);transform:rotate(0deg)}
.vlc-gauge::after{content:"";position:absolute;left:10%;right:10%;bottom:-53%;width:80%;height:133%;border-radius:50%;background:#fff}
.vlc-needle{position:absolute;left:50%;bottom:16px;width:5px;height:105px;border-radius:5px;background:#17212b;transform-origin:50% 100%;transform:rotate(0deg);z-index:3;transition:transform .8s ease}
.vlc-hub{position:absolute;left:50%;bottom:10px;width:20px;height:20px;border-radius:50%;background:#17212b;transform:translateX(-50%);z-index:4}
.vlc-gauge-label{font-size:17px;font-weight:800;margin-top:4px}
.vlc-gauge-scale{display:flex;justify-content:space-between;font-size:12px;color:#68727d;margin-top:-2px}
.vlc-result{border-radius:22px!important;border:2px solid #dfe3e7!important;transition:background .3s,border-color .3s}
.vlc-result.green{background:#ecfdf3!important;border-color:#86efac!important}.vlc-result.blue{background:#eff6ff!important;border-color:#93c5fd!important}.vlc-result.orange{background:#fff7ed!important;border-color:#fdba74!important}.vlc-result.red{background:#fef2f2!important;border-color:#fca5a5!important}
.vlc-verdict{display:inline-block;font-size:23px;font-weight:900;padding:10px 16px;border-radius:999px;margin-bottom:10px}.green .vlc-verdict{background:#bbf7d0;color:#166534}.blue .vlc-verdict{background:#dbeafe;color:#1e40af}.orange .vlc-verdict{background:#fed7aa;color:#9a3412}.red .vlc-verdict{background:#fecaca;color:#991b1b}
</style>`;
  const script = `<script id="vlc-mobile-fix-script">(function(){
    function fix(){
      document.querySelectorAll('.previews').forEach(function(p){p.style.display='grid';p.style.gridTemplateColumns='repeat(3,minmax(0,1fr))';p.style.width='100%';p.style.gap='10px';});
      document.querySelectorAll('.previews .thumb').forEach(function(t){t.style.width='100%';t.style.minWidth='0';t.style.height='auto';t.style.aspectRatio='1 / 1';});
      var market=document.getElementById('market'); if(!market||market.hidden)return;
      var status=market.querySelector('.status'); if(!status)return;
      var label=(status.innerText||'').trim();
      if(!label)return;
      var kind=label.includes('Très intéressant')||label.includes('Plutôt intéressant')?'green':label.includes('Dans le marché')?'blue':label.includes('insuffisantes')?'orange':'red';
      status.classList.add('vlc-result',kind);
      var verdict=status.querySelector('.vlc-verdict'); if(!verdict){verdict=document.createElement('div');verdict.className='vlc-verdict';verdict.textContent=label.split('\n')[0];status.insertBefore(verdict,status.firstChild);}
      var existing=status.querySelector('.vlc-gauge-wrap'); if(existing)existing.remove();
      var text=status.innerText||''; var gapMatch=text.match(/prix demandé est (\d+)% (au-dessus|en dessous)/i); var needle=50;
      if(gapMatch){var g=Number(gapMatch[1]);needle=gapMatch[2].toLowerCase()==='en dessous'?Math.min(100,50+g*2):Math.max(0,50-g*2);} else if(kind==='green'){needle=72}else if(kind==='blue'){needle=50}else if(kind==='red'){needle=25}else{needle=50}
      var wrap=document.createElement('div');wrap.className='vlc-gauge-wrap';wrap.innerHTML='<div class="vlc-gauge"><div class="vlc-needle"></div><div class="vlc-hub"></div></div><div class="vlc-gauge-label">Position du prix</div><div class="vlc-gauge-scale"><span>Trop cher</span><span>Marché</span><span>Très intéressant</span></div>';
      status.insertBefore(wrap,status.querySelector('.price')||status.firstChild.nextSibling);
      var angle=-90+(needle*1.8);var n=wrap.querySelector('.vlc-needle');n.style.transform='rotate('+angle+'deg)';
    }
    new MutationObserver(function(){fix()}).observe(document.body,{subtree:true,childList:true,characterData:true});
    document.addEventListener('DOMContentLoaded',fix);setTimeout(fix,100);setTimeout(fix,700);setTimeout(fix,1800);
  })();</script>`;
  if (html.includes('</head>')) html=html.replace('</head>',css+'</head>'); else html=css+html;
  if (html.includes('</body>')) html=html.replace('</body>',script+'</body>'); else html+=script;
  return html;
}

function proxy(req, res) {
  if (req.path === "/api/market") {
    market(req.body).then((data) => res.status(200).json(data)).catch((e) => res.status(500).json({ error: e.message || "Erreur marché." }));
    return;
  }
  const headers = { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}`, "accept-encoding": "identity" };
  const r = http.request(`${TARGET}${req.originalUrl}`, { method: req.method, headers }, (up) => {
    const chunks = [];
    up.on("data", (c) => chunks.push(c));
    up.on("end", () => {
      const raw = Buffer.concat(chunks);
      const type = String(up.headers["content-type"] || "");
      if (type.includes("text/html")) {
        const html = enhanceHtml(raw.toString("utf8"));
        res.status(up.statusCode || 200).set({"content-type":"text/html; charset=utf-8","cache-control":"no-store, no-cache, must-revalidate, proxy-revalidate","pragma":"no-cache","expires":"0"}).send(html);
        return;
      }
      res.status(up.statusCode || 200);
      Object.entries(up.headers).forEach(([k,v])=>{if(!['transfer-encoding','content-length','content-encoding'].includes(k.toLowerCase())&&v!=null)res.set(k,v)});
      res.send(raw);
    });
  });
  r.on("error", (e) => res.status(502).json({ error: e.message || "Service interne indisponible." }));
  req.pipe(r);
}

app.use((req,res)=>proxy(req,res));
const child=spawn(process.execPath,["server.js"],{env:{...process.env,PORT:String(INTERNAL_PORT)},stdio:"inherit"});
child.on("exit",(code)=>{if(code&&code!==0)process.exit(code)});
app.listen(PORT,"0.0.0.0",()=>console.log(`Vaut le Coup wrapper ${PORT}; server ${INTERNAL_PORT}`));
process.on("SIGTERM",()=>child.kill("SIGTERM"));
process.on("SIGINT",()=>child.kill("SIGINT"));
