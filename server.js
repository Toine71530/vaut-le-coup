import express from "express";
import multer from "multer";

const app = express();
const PORT = Number(process.env.PORT || 10000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 3, fileSize: 12 * 1024 * 1024 }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const CARHUNT_API_KEY = process.env.CARHUNT_API_KEY || "";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => {
  const x = Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(x) ? x : null;
};
const norm = v => String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const money = v => v == null ? "Non déterminé" : Math.round(v).toLocaleString("fr-FR") + " €";
const median = a => {
  const x = [...a].sort((a,b) => a-b);
  if (!x.length) return null;
  const i = Math.floor(x.length / 2);
  return x.length % 2 ? x[i] : (x[i-1] + x[i]) / 2;
};
const quantile = (a, p) => {
  const x = [...a].sort((a,b) => a-b);
  if (!x.length) return null;
  const i = (x.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return x[lo] + (x[hi] - x[lo]) * (i - lo);
};
const parseJson = text => {
  const s = String(text || "").replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("Réponse IA invalide");
  return JSON.parse(s.slice(a, b + 1));
};
const same = (a,b) => !a || !b || norm(a).includes(norm(b)) || norm(b).includes(norm(a));

async function gemini(files) {
  if (!GEMINI_API_KEY) throw new Error("Le moteur Gemini n'est pas configuré.");
  const prompt = [
    "Tu es l'expert automobile de l'application Vaut le Coup ?.",
    "Analyse toutes les photos/captures d'une même annonce automobile et recoupe les informations entre elles.",
    "N'invente jamais une information. Si une donnée n'est pas lisible, mets null.",
    "Si deux informations se contredisent, conserve la donnée la plus explicitement affichée et signale la contradiction dans warnings.",
    "Ne déduis pas le type de vendeur, la finition ou une caractéristique non visible.",
    "Retourne UNIQUEMENT un objet JSON avec exactement ces champs:",
    '{"make":string|null,"model":string|null,"version":string|null,"year":number|null,"mileage_km":number|null,"price_eur":number|null,"energy":string|null,"gearbox":string|null,"power_hp":number|null,"seller_type":"professional"|"private"|null,"location":string|null,"title":string|null,"confidence":number,"uncertain_fields":string[],"visible_claims":string[],"warnings":string[]}'
  ].join(" ");
  const parts = [{ text: prompt }].concat(files.map(f => ({
    inline_data: { mime_type: f.mimetype, data: f.buffer.toString("base64") }
  })));
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(GEMINI_MODEL) + ":generateContent?key=" +
        encodeURIComponent(GEMINI_API_KEY),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
          })
        }
      );
      const raw = await r.text();
      if (!r.ok) {
        last = new Error("Gemini HTTP " + r.status);
        last.status = r.status;
        last.detail = raw.slice(0, 500);
        if ([429,500,502,503,504].includes(r.status)) {
          await sleep(800 * (attempt + 1));
          continue;
        }
        throw last;
      }
      const d = JSON.parse(raw);
      const text = (d?.candidates?.[0]?.content?.parts || []).map(x => x.text || "").join("");
      if (!text) throw new Error("Gemini n'a retourné aucun résultat.");
      return parseJson(text);
    } catch (e) {
      last = e;
      if (attempt < 2 && [429,500,502,503,504].includes(e.status)) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw last;
}

function compatible(item, v, strict = true) {
  if (norm(item.make) !== norm(v.make) || norm(item.model) !== norm(v.model)) return false;
  const iy = num(item.year), vy = num(v.year);
  const ik = num(item.mileage), vk = num(v.mileage_km);
  if (strict && iy != null && vy != null && Math.abs(iy - vy) > 3) return false;
  if (strict && ik != null && vk != null && Math.abs(ik - vk) > 50000) return false;
  if (v.energy && item.energy && !same(v.energy, item.energy)) return false;
  if (v.gearbox && item.gearbox && !same(v.gearbox, item.gearbox)) return false;
  return num(item.price) > 0;
}

async function carhuntSearch(params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const url = "https://api-pro.carhunt.fr/v1/listings/search?" + params.toString();
    const r = await fetch(url, {
      headers: { Authorization: "Bearer " + CARHUNT_API_KEY, Accept: "application/json" },
      signal: controller.signal
    });
    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {}
    if (!r.ok) {
      const err = new Error("CarHunt HTTP " + r.status);
      err.status = r.status;
      err.detail = raw.slice(0, 800);
      throw err;
    }
    return Array.isArray(data.listings) ? data.listings : [];
  } finally {
    clearTimeout(timer);
  }
}

async function market(v) {
  if (!CARHUNT_API_KEY) {
    return { ok:false, code:"CONFIG", user_message:"Comparaison marché indisponible : clé CarHunt non configurée." };
  }
  if (!v?.make || !v?.model) {
    return { ok:false, code:"INPUT", user_message:"Impossible de comparer : marque ou modèle non identifié." };
  }

  const base = new URLSearchParams({
    make: String(v.make).trim().toUpperCase(),
    model: String(v.model).trim().toUpperCase(),
    page_size: "30"
  });
  if (num(v.year) != null) {
    base.set("year_min", String(num(v.year) - 3));
    base.set("year_max", String(num(v.year) + 3));
  }

  try {
    let all = await carhuntSearch(base);
    let comps = all.filter(x => compatible(x, v, true));

    if (comps.length < 5) {
      const broad = new URLSearchParams({
        make: String(v.make).trim().toUpperCase(),
        model: String(v.model).trim().toUpperCase(),
        page_size: "30"
      });
      const wider = await carhuntSearch(broad);
      const seen = new Set(comps.map(x => x.id || x.source_url || JSON.stringify(x)));
      for (const x of wider) {
        const key = x.id || x.source_url || JSON.stringify(x);
        if (!seen.has(key) && compatible(x, v, false)) {
          comps.push(x);
          seen.add(key);
        }
      }
    }

    const priced = comps.filter(x => num(x.price) > 0);
    const prices = priced.map(x => num(x.price));
    const med = median(prices);
    const ask = num(v.price_eur);

    if (med == null) {
      return {
        ok:true, comparables:0, asking:money(ask), median:"Non déterminé",
        low:"Non déterminé", high:"Non déterminé", confidence:20,
        label:"Marché insuffisant",
        gap:"Aucun comparatif tarifaire exploitable n'a été trouvé.", sample:[]
      };
    }

    const gapPct = ask == null ? null : Math.round((ask / med - 1) * 100);
    const label = gapPct == null ? "Marché comparable"
      : gapPct <= -15 ? "Très bonne affaire potentielle"
      : gapPct <= -8 ? "Prix très intéressant"
      : gapPct <= -3 ? "Plutôt intéressant"
      : gapPct <= 3 ? "Dans le marché"
      : gapPct <= 10 ? "Plutôt cher"
      : "Cher";

    const confidence = Math.min(
      95,
      45 + Math.min(15, prices.length * 2) +
      (v.year != null ? 8 : 0) + (v.mileage_km != null ? 8 : 0) +
      (v.energy ? 4 : 0) + (v.gearbox ? 4 : 0)
    );

    const sample = priced.slice(0, 8).map(x => ({
      id:x.id, price:x.price, year:x.year, mileage:x.mileage,
      energy:x.energy, gearbox:x.gearbox, horsepower:x.horsepower,
      version:x.version, seller_type:x.seller_type, city:x.city,
      source:x.source, url:x.source_url, deal_score:x.deal_score
    }));

    return {
      ok:true, comparables:prices.length, asking:money(ask), median:money(med),
      low:money(quantile(prices, .25)), high:money(quantile(prices, .75)),
      confidence, label,
      gap: gapPct == null ? "Prix demandé non déterminé." :
        "Prix demandé " + Math.abs(gapPct) + " % " + (gapPct >= 0 ? "au-dessus" : "en dessous") + " du prix médian.",
      warning: prices.length < 5 ? "Échantillon limité : interprétation prudente." : null,
      sample
    };
  } catch (e) {
    console.error("CarHunt error:", e.status || "", e.detail || e.message);
    return {
      ok:false, code:e.name === "AbortError" ? "TIMEOUT" : "UPSTREAM",
      user_message:"La comparaison marché est temporairement indisponible. L'analyse du véhicule reste complète."
    };
  }
}

app.use(express.json({ limit:"1mb" }));
app.get("/api/health", (_req,res) => res.json({
  ok:true, vision:Boolean(GEMINI_API_KEY), vision_provider:"gemini",
  model:GEMINI_MODEL, market:Boolean(CARHUNT_API_KEY)
}));
app.post("/api/analyze", upload.array("photos", 3), async (req,res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error:"Aucune image reçue." });
    res.json({ ok:true, vehicle:await gemini(req.files) });
  } catch (e) {
    console.error("Analyze error:", e);
    res.status(500).json({ error:"Analyse IA indisponible. Réessaie dans quelques instants." });
  }
});
app.post("/api/market", async (req,res) => {
  const out = await market(req.body || {});
  res.status(out.ok ? 200 : 503).json(out);
});

const HTML = String.raw`<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vaut le Coup ?</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17212b;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:780px;margin:auto;padding:24px 14px 70px}h1{font-size:42px;margin:0 0 5px}.sub{color:#69747e;font-size:19px;margin-bottom:22px}
.card{background:#fff;border:1px solid #e0e4e8;border-radius:26px;padding:24px;margin:16px 0;box-shadow:0 2px 10px #00000008}h2{font-size:29px;margin:0 0 14px}p{font-size:17px}
.drop{display:block;border:3px dashed #c8ced4;border-radius:22px;padding:30px 15px;text-align:center;cursor:pointer}.drop strong{font-size:24px}.small{display:block;color:#7a838c;margin-top:9px}
#file{display:none}.previews{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}.thumb{position:relative;aspect-ratio:1}.thumb img{width:100%;height:100%;object-fit:cover;border-radius:17px}.remove{position:absolute;right:-5px;top:-5px;border:0;border-radius:50%;width:34px;height:34px;background:#17212b;color:#fff;font-size:21px}
.btn{width:100%;border:0;border-radius:17px;padding:17px;background:#17212b;color:#fff;font-size:20px;font-weight:800;cursor:pointer;margin-top:17px}.btn:disabled{opacity:.45}
.progress{display:none;margin-top:16px;padding:18px;border-radius:20px;background:#f1f4f7}.progress.on{display:block}.step{font-size:18px;font-weight:800}.track{height:13px;background:#dce2e7;border-radius:99px;overflow:hidden;margin-top:10px}.bar{height:100%;width:0;background:#2563eb;transition:width .35s}.note{color:#68737d;margin-top:8px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.box{background:#f6f7f8;border-radius:15px;padding:13px}.big{font-size:35px;font-weight:900}.tag{display:inline-block;background:#e8edf1;border-radius:99px;padding:7px 10px;margin:3px}.warn{background:#fff0d2;border-radius:17px;padding:15px;margin:10px 0}.good{background:#e6f6eb;border-radius:19px;padding:18px}.market{background:#f7f8fa;border-radius:20px;padding:18px}.comp{padding:13px 0;border-bottom:1px solid #dde2e6}.comp:last-child{border-bottom:0}.muted{color:#68737d}.error{background:#ffe1e1;color:#8e2424;border-radius:17px;padding:15px;margin-top:14px}.badge{display:inline-block;border-radius:99px;padding:8px 12px;font-weight:800;background:#e9eef2}
@media(max-width:520px){main{padding:18px 11px}.card{padding:20px}h1{font-size:36px}.grid{grid-template-columns:1fr}.previews{gap:8px}}
</style></head><body><main>
<h1>Vaut le Coup ? ✓</h1><div class="sub">Avant d’acheter. Demande à l’IA.</div>
<section class="card"><h2>Analyse une annonce</h2><p>Ajoute jusqu’à 3 captures ou photos de la même annonce.</p>
<label class="drop" for="file">📸<br><strong>Ajouter une capture ou une photo</strong><span class="small">JPG, PNG, WEBP — 12 Mo par photo — 3 maximum</span></label>
<input id="file" type="file" accept="image/jpeg,image/png,image/webp" multiple><div id="previews" class="previews"></div><div id="err"></div>
<div id="progress" class="progress"><div id="step" class="step"></div><div class="track"><div id="bar" class="bar"></div></div><div id="note" class="note"></div></div>
<button id="go" class="btn" disabled>Analyser l’annonce</button></section>
<section id="analysis" class="card" hidden></section><section id="market" class="card" hidden></section>
</main><script>
const $=id=>document.getElementById(id),input=$("file"),pre=$("previews"),go=$("go"),err=$("err"),prog=$("progress"),step=$("step"),bar=$("bar"),note=$("note"),analysis=$("analysis"),marketBox=$("market");
let files=[],vehicle=null,busy=false;
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]})}
function render(){pre.innerHTML="";files.forEach(function(f,i){const d=document.createElement("div"),img=document.createElement("img"),b=document.createElement("button");d.className="thumb";img.src=URL.createObjectURL(f);b.className="remove";b.type="button";b.dataset.i=String(i);b.textContent="×";d.appendChild(img);d.appendChild(b);pre.appendChild(d)});go.disabled=!files.length||busy}
input.onchange=function(){files=files.concat(Array.from(input.files)).slice(0,3);input.value="";render()};
pre.onclick=function(e){const b=e.target.closest("button.remove");if(!b)return;files.splice(Number(b.dataset.i),1);render()};
function stage(p,s,n){prog.classList.add("on");bar.style.width=p+"%";step.textContent=s;note.textContent=n||""}
function field(label,value){return '<div class="box"><b>'+esc(label)+'</b><br>'+esc(value==null||value===""?"Non déterminé":value)+'</div>'}
function showAnalysis(v){const claims=(v.visible_claims||[]).map(x=>'<span class="tag">'+esc(x)+'</span>').join("");const warns=(v.warnings||[]).map(x=>'<div class="warn">⚠️ '+esc(x)+'</div>').join("");const uncertain=(v.uncertain_fields||[]).length?'<div class="warn">⚠️ À vérifier : '+esc(v.uncertain_fields.join(", "))+'</div>':"";analysis.hidden=false;analysis.innerHTML='<h2>Ce que l’IA a lu</h2><div class="grid">'+field("Marque",v.make)+field("Modèle",v.model)+field("Version",v.version)+field("Année",v.year)+field("Kilométrage",v.mileage_km==null?null:Number(v.mileage_km).toLocaleString("fr-FR")+" km")+field("Prix",v.price_eur==null?null:Number(v.price_eur).toLocaleString("fr-FR")+" €")+field("Énergie",v.energy)+field("Boîte",v.gearbox)+field("Puissance",v.power_hp==null?null:v.power_hp+" ch")+field("Vendeur",v.seller_type==="professional"?"Professionnel":v.seller_type==="private"?"Particulier":null)+field("Lieu",v.location)+'</div><p><b>Confiance de lecture :</b> '+esc(v.confidence==null?"—":v.confidence)+"/100</p>"+uncertain+warns+(claims?'<h3>Éléments visibles</h3>'+claims:"")}
function showMarket(m){marketBox.hidden=false;if(!m.ok){marketBox.innerHTML='<h2>Est-ce que ça vaut le coup ?</h2><div class="warn">⚠️ '+esc(m.user_message||"Comparaison indisponible.")+'</div><p class="muted">L’analyse du véhicule est terminée. Tu peux relancer uniquement la comparaison.</p><button id="retry" class="btn">Réessayer la comparaison</button>';$('retry').onclick=function(){runMarket(true)};return}let html='<h2>Est-ce que ça vaut le coup ?</h2><div class="good"><div class="badge">'+esc(m.label)+'</div><div class="big">'+esc(m.asking)+'</div><div>Marché médian : <b>'+esc(m.median)+'</b></div><div>'+esc(m.gap)+'</div></div><div class="grid" style="margin-top:12px">'+field("Comparables retenus",m.comparables)+field("Confiance marché",m.confidence+"/100")+field("25 % du marché",m.low)+field("75 % du marché",m.high)+'</div>';if(m.warning)html+='<div class="warn">⚠️ '+esc(m.warning)+'</div>';html+='<h3>Comparaisons du marché</h3><div class="market">';if(!m.sample?.length)html+='<div class="muted">Aucune annonce comparable exploitable.</div>';else m.sample.forEach(function(x){html+='<div class="comp"><b>'+esc(x.price==null?"—":Number(x.price).toLocaleString("fr-FR")+" €")+'</b> · '+esc(x.year||"année ?")+' · '+esc(x.mileage==null?"km ?":Number(x.mileage).toLocaleString("fr-FR")+" km")+'<br><span class="muted">'+esc([x.energy,x.gearbox,x.seller_type==="professional"?"Pro":x.seller_type==="private"?"Particulier":"",x.city].filter(Boolean).join(" · "))+'</span>'+(x.url?'<br><a href="'+esc(x.url)+'" target="_blank" rel="noopener">Voir l’annonce</a>':"")+'</div>'});html+='</div><p class="muted">Comparaison basée sur les annonces CarHunt disponibles au moment de l’analyse, puis filtrées par modèle, année, kilométrage, énergie et boîte lorsque ces données sont connues.</p>';marketBox.innerHTML=html}
async function analyze(){if(busy||!files.length)return;busy=true;go.disabled=true;err.innerHTML="";analysis.hidden=true;marketBox.hidden=true;stage(8,"Envoi des photos…","Les captures sont transmises à Gemini.");const fd=new FormData();files.forEach(function(f){fd.append("photos",f,f.name)});try{stage(25,"Lecture des photos…","Recoupement des informations visibles.");const controller=new AbortController(),timeout=setTimeout(function(){controller.abort()},45000);let r;try{r=await fetch("/api/analyze",{method:"POST",body:fd,signal:controller.signal})}finally{clearTimeout(timeout)}const d=await r.json();if(!r.ok)throw new Error(d.error||"Analyse impossible.");vehicle=d.vehicle;stage(62,"Analyse terminée…","Préparation de la comparaison marché.");showAnalysis(vehicle);await runMarket(false);stage(100,"Terminé","Analyse et comparaison disponibles.")}catch(e){err.innerHTML='<div class="error">⚠️ '+esc(e.name==="AbortError"?"L’analyse a dépassé le délai prévu.":e.message)+'</div>';stage(0,"Échec","Tu peux relancer sans renvoyer les photos.")}finally{busy=false;render()}}
async function runMarket(retry){if(!vehicle)return;stage(retry?72:70,"Comparaison du marché…","Recherche d’annonces comparables.");try{const controller=new AbortController(),timeout=setTimeout(function(){controller.abort()},15000);let r;try{r=await fetch("/api/market",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(vehicle),signal:controller.signal})}finally{clearTimeout(timeout)}const m=await r.json();showMarket(m)}catch(e){showMarket({ok:false,user_message:e.name==="AbortError"?"La comparaison a dépassé le délai prévu.":"Impossible de joindre le service de comparaison."})}}
go.onclick=analyze;
</script></body></html>`;

app.get("/", (_req,res) => res.type("html").send(HTML));
app.listen(PORT, () => console.log("Vaut le Coup ? listening on " + PORT));
