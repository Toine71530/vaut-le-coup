import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 3,
    fileSize: 12 * 1024 * 1024
  }
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function cleanJson(text) {
  const s = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return s.slice(start, end + 1);
  }

  throw new Error("Réponse JSON invalide.");
}

function escapeHtmlServer(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* =========================================================
   PAGE PRINCIPALE
========================================================= */

app.get("/", (_req, res) => {
  res.type("html").send(HTML);
});

/* =========================================================
   ANALYSE IA — 1 À 3 PHOTOS
========================================================= */

app.post("/api/analyze", upload.array("images", 3), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: "Ajoute au moins une photo."
      });
    }

    if (req.files.length > 3) {
      return res.status(400).json({
        error: "Maximum 3 photos."
      });
    }

    if (!openai) {
      return res.status(503).json({
        error: "OPENAI_API_KEY manquante. Le moteur IA n'est pas configuré."
      });
    }

    const images = req.files.map((file) => {
      const mime = file.mimetype || "image/jpeg";

      return (
        "data:" +
        mime +
        ";base64," +
        file.buffer.toString("base64")
      );
    });

    const prompt = `
Tu es le moteur de lecture de l'application française
"Vaut le Coup ? — Avant d'acheter. Demande à l'IA."

Ta mission est d'analyser une annonce automobile à partir d'une ou plusieurs photos.

Il peut y avoir de 1 à 3 photos.

IMPORTANT :
- Analyse uniquement ce qui est réellement visible dans les photos.
- Ne déduis jamais une information simplement parce qu'elle est probable.
- N'invente jamais une finition, une puissance, une énergie, une boîte ou un équipement.
- Si une information est illisible ou absente, mets null.
- Si plusieurs photos montrent la même annonce, croise les informations.
- Si deux photos donnent des informations contradictoires, signale-le dans warnings.
- Une photo peut montrer l'annonce et une autre le véhicule.
- Observe également les défauts visibles du véhicule lorsque ceux-ci sont réellement visibles.
- Ne transforme pas une impression en certitude.
- Si tu vois une rayure, bosse, voyant ou défaut apparent, indique-le prudemment.
- Ne prétends jamais avoir vérifié l'historique réel du véhicule si celui-ci n'est pas visible.
- Ne prétends jamais avoir vérifié le kilométrage réel si ce n'est pas visible.
- Ne prétends jamais avoir vérifié le marché automobile : cette partie sera réalisée séparément.

Retourne UNIQUEMENT un objet JSON valide avec exactement ces clés :

{
  "make": string|null,
  "model": string|null,
  "version": string|null,
  "year": number|null,
  "mileage_km": number|null,
  "price_eur": number|null,
  "energy": string|null,
  "gearbox": string|null,
  "power_hp": number|null,
  "seller_type": "professional"|"private"|null,
  "location": string|null,
  "title": string|null,
  "confidence": number,
  "uncertain_fields": string[],
  "visible_claims": string[],
  "warnings": string[]
}

Règles supplémentaires :

confidence :
- entier de 0 à 100.
- représente uniquement la confiance dans la lecture des informations visibles.

uncertain_fields :
- liste uniquement les informations difficiles à lire, absentes ou ambiguës.

visible_claims :
- éléments réellement visibles ou écrits dans l'annonce.
- exemples : "1ère main", "garantie 12 mois", "révision effectuée", uniquement si ces éléments sont visibles.

warnings :
- contradictions entre les photos.
- défauts visuellement apparents.
- incohérences visibles.
- informations importantes à vérifier avant achat.

Ne donne aucune explication en dehors du JSON.
`;

    const content = [
      {
        type: "input_text",
        text: prompt
      }
    ];

    for (const imageUrl of images) {
      content.push({
        type: "input_image",
        image_url: imageUrl,
        detail: "high"
      });
    }

    const response = await openai.responses.create({
      model: "gpt-5.6-luna",
      input: [
        {
          role: "user",
          content
        }
      ]
    });

    const vehicle = JSON.parse(
      cleanJson(response.output_text)
    );

    res.json({
      ok: true,
      vehicle
    });

  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: e.message || "Erreur pendant l'analyse."
    });
  }
});

/* =========================================================
   COMPARAISON MARCHÉ — CARHUNT
========================================================= */

app.post("/api/market", async (req, res) => {
  try {
    const key = process.env.CARHUNT_API_KEY;

    if (!key) {
      return res.status(503).json({
        error:
          "CARHUNT_API_KEY manquante. La comparaison marché n'est pas encore activée."
      });
    }

    const v = req.body || {};

    if (!v.make || !v.model) {
      return res.status(400).json({
        error: "Marque/modèle nécessaires."
      });
    }

    const params = new URLSearchParams();

    params.set("make", String(v.make).toUpperCase());

    /*
      On retire un éventuel numéro de génération
      en fin de modèle :
      "PRIUS 5" -> "PRIUS"
      "GOLF 8" -> "GOLF"
    */
    const normalizedModel = String(v.model)
      .toUpperCase()
      .replace(/\s+(?:[IVX]+|\d+)$/i, "")
      .trim();

    params.set("model", normalizedModel);

    if (v.year) {
      params.set("year", String(v.year));
    }

    params.set("page_size", "50");

    const url =
      "https://api-pro.carhunt.fr/v1/listings/search?" +
      params.toString();

    const r = await fetch(url, {
      headers: {
        Authorization: "Bearer " + key
      }
    });

    if (!r.ok) {
      const detail = await r.text();

      throw new Error(
        "CarHunt HTTP " + r.status + ": " + detail
      );
    }

    const data = await r.json();

    let listings = Array.isArray(data.listings)
      ? data.listings
      : [];

    /*
      Première sélection :
      - prix valide
      - année proche
      - kilométrage proche
      - exclusion de l'annonce analysée si elle
        correspond exactement.
    */

    listings = listings.filter((x) => {
      if (
        !Number.isFinite(Number(x.price)) ||
        Number(x.price) <= 0
      ) {
        return false;
      }

      if (
        v.year &&
        x.year &&
        Math.abs(
          Number(x.year) - Number(v.year)
        ) > 1
      ) {
        return false;
      }

      if (
        v.mileage_km &&
        x.mileage &&
        Math.abs(
          Number(x.mileage) -
          Number(v.mileage_km)
        ) > 30000
      ) {
        return false;
      }

      if (
        v.price_eur &&
        v.year &&
        v.mileage_km &&
        Number(x.price) === Number(v.price_eur) &&
        Number(x.year) === Number(v.year) &&
        Number(x.mileage) === Number(v.mileage_km)
      ) {
        return false;
      }

      return true;
    });

    /*
      Si l'année ou le kilométrage sont connus,
      on privilégie les véhicules les plus proches.
    */

    listings.sort((a, b) => {
      const distanceA =
        Math.abs(
          Number(a.year || 0) -
          Number(v.year || a.year || 0)
        ) * 100000 +
        Math.abs(
          Number(a.mileage || 0) -
          Number(v.mileage_km || a.mileage || 0)
        );

      const distanceB =
        Math.abs(
          Number(b.year || 0) -
          Number(v.year || b.year || 0)
        ) * 100000 +
        Math.abs(
          Number(b.mileage || 0) -
          Number(v.mileage_km || b.mileage || 0)
        );

      return distanceA - distanceB;
    });

    const prices = listings
      .map((x) => Number(x.price))
      .filter((p) => Number.isFinite(p) && p > 0)
      .sort((a, b) => a - b);

    /*
      Moins de 5 véhicules réellement comparables :
      on ne prétend pas connaître le marché.
    */

    if (prices.length < 5) {
      return res.json({
        ok: true,
        comparables: prices.length,
        market_median_eur: null,
        low_eur: null,
        high_eur: null,
        asking_price_eur:
          Number.isFinite(Number(v.price_eur))
            ? Number(v.price_eur)
            : null,
        gap_eur: null,
        gap_pct: null,
        deal_score: null,
        sample: []
      });
    }

    const median =
      prices[Math.floor(prices.length / 2)];

    const q = (p) => {
      const index = Math.floor(
        (prices.length - 1) * p
      );

      return prices[
        Math.max(
          0,
          Math.min(
            prices.length - 1,
            index
          )
        )
      ];
    };

    const asking = Number(v.price_eur);

    const gapPct =
      asking > 0
        ? ((median - asking) / median) * 100
        : null;

    /*
      Score volontairement prudent :
      50 = autour du marché.
      >50 = sous le marché.
      <50 = au-dessus du marché.

      Avec moins de 10 comparables,
      le score est limité à 90.
    */

    const dealScore =
      gapPct == null
        ? null
        : Math.min(
            prices.length < 10 ? 90 : 100,
            Math.max(
              0,
              Math.round(50 + gapPct * 2.5)
            )
          );

    res.json({
      ok: true,
      comparables: prices.length,

      market_median_eur:
        Math.round(median),

      low_eur:
        Math.round(q(0.15)),

      high_eur:
        Math.round(q(0.85)),

      asking_price_eur:
        Number.isFinite(asking)
          ? asking
          : null,

      gap_eur:
        Number.isFinite(asking)
          ? Math.round(median - asking)
          : null,

      gap_pct:
        gapPct == null
          ? null
          : Math.round(gapPct * 10) / 10,

      deal_score: dealScore,

      sample: listings
        .slice(0, 8)
        .map((x) => ({
          price: x.price,
          year: x.year,
          mileage: x.mileage,
          energy: x.energy,
          gearbox: x.gearbox,
          horsepower: x.horsepower,
          seller_type: x.seller_type,
          source: x.source,
          source_url: x.source_url
        }))
    });

  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: e.message || "Erreur marché."
    });
  }
});

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    vision: Boolean(process.env.OPENAI_API_KEY),
    market: Boolean(process.env.CARHUNT_API_KEY)
  });
});

/* =========================================================
   INTERFACE
========================================================= */

const HTML = `<!doctype html>

<html lang="fr">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>Vaut le Coup ?</title>

<style>

:root{
  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  background:#f5f7f9;
  color:#17202a;
}

*{
  box-sizing:border-box;
}

body{
  margin:0;
}

.wrap{
  max-width:720px;
  margin:auto;
  padding:20px;
}

header{
  padding:16px 0 22px;
}

.brand{
  font-size:30px;
  font-weight:900;
}

.tag{
  color:#68737d;
  margin-top:5px;
}

.card{
  background:white;
  border:1px solid #e2e7eb;
  border-radius:18px;
  padding:18px;
  margin:14px 0;
  box-shadow:0 5px 18px #00000008;
}

.drop{
  display:block;
  width:100%;
  border:2px dashed #bdc7cf;
  border-radius:16px;
  padding:28px;
  text-align:center;
  cursor:pointer;
  line-height:1.45;
}

input[type=file]{
  display:none;
}

button{
  border:0;
  border-radius:12px;
  padding:13px 16px;
  font-weight:800;
  cursor:pointer;
  background:#17202a;
  color:white;
}

button:disabled{
  opacity:.45;
  cursor:not-allowed;
}

.status{
  padding:12px;
  border-radius:12px;
  background:#f0f3f5;
  margin-top:14px;
}

.previews{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:10px;
  margin-top:14px;
}

.preview-item{
  position:relative;
  border-radius:12px;
  overflow:hidden;
  background:#eef2f4;
  aspect-ratio:1/1;
}

.preview-thumb{
  width:100%;
  height:100%;
  object-fit:cover;
  display:block;
}

.remove-photo{
  position:absolute;
  top:6px;
  right:6px;
  width:30px;
  height:30px;
  border-radius:50%;
  padding:0;
  background:#17202a;
  color:white;
  font-size:16px;
}

.grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:12px;
}

.k{
  font-size:12px;
  color:#75808a;
}

.v{
  font-size:16px;
  font-weight:750;
}

.pill{
  display:inline-block;
  padding:6px 10px;
  border-radius:99px;
  background:#eef2f4;
  margin:3px 3px 0 0;
}

.score{
  font-size:52px;
  font-weight:950;
  line-height:1;
}

.scoreline{
  display:flex;
  align-items:center;
  gap:16px;
  flex-wrap:wrap;
}

.verdict{
  font-size:22px;
  font-weight:900;
}

.muted{
  color:#69747d;
}

.warning{
  background:#fff5df;
  padding:10px;
  border-radius:10px;
  margin-top:8px;
}

.good{
  background:#e9f7ef;
  padding:12px;
  border-radius:12px;
  margin-top:10px;
}

.bad{
  background:#fff0ef;
  padding:12px;
  border-radius:12px;
  margin-top:10px;
}

.hidden{
  display:none;
}

.small{
  font-size:12px;
  color:#7a858e;
}

.comp{
  border-top:1px solid #edf0f2;
  padding:10px 0;
}

.price{
  font-weight:900;
}

.bar{
  height:10px;
  background:#e8edf0;
  border-radius:99px;
  overflow:hidden;
  margin-top:10px;
}

.bar>div{
  height:100%;
  width:0;
  background:#17202a;
}

@media(max-width:520px){

  .grid{
    grid-template-columns:1fr;
  }

  .previews{
    grid-template-columns:repeat(3,1fr);
  }

}

</style>

</head>

<body>

<div class="wrap">

<header>

<div class="brand">
Vaut le Coup ? ✓
</div>

<div class="tag">
Avant d’acheter. Demande à l’IA.
</div>

</header>

<section class="card">

<h2>
Analyse une annonce
</h2>

<p class="muted">
Ajoute jusqu'à 3 photos de l'annonce ou du véhicule.
</p>

<label
  class="drop"
  for="file"
>

📸<br>

<strong>
Ajoute une capture ou une photo
</strong>

<br>

<span class="small">
JPG, PNG, WEBP — 12 Mo max par photo — 3 photos maximum
</span>

</label>

<input
  id="file"
  type="file"
  accept="image/*"
  multiple
>

<div
  id="previews"
  class="previews"
></div>

<div
  id="status"
  class="status hidden"
></div>

<button
  id="analyze"
  style="margin-top:14px;width:100%"
  disabled
>
Analyser l’annonce
</button>

</section>

<section
  id="result"
  class="card hidden"
>

<h2>
Lecture de l’annonce
</h2>

<div id="confidence"></div>

<div
  id="fields"
  class="grid"
  style="margin-top:14px"
></div>

<div
  id="claims"
  style="margin-top:14px"
></div>

<div id="warnings"></div>

</section>

<section
  id="market"
  class="card hidden"
>

<h2>
Est-ce que ça vaut le coup ?
</h2>

<div
  id="marketText"
  class="muted"
>
Recherche de véhicules comparables…
</div>

<div
  id="scoreBox"
  class="hidden"
  style="margin-top:18px"
>

<div class="scoreline">

<div
  id="score"
  class="score"
>
—
</div>

<div
  id="verdict"
  class="verdict"
></div>

</div>

<div
  id="gap"
  class="muted"
  style="margin-top:10px"
></div>

<div class="bar">

<div id="barFill"></div>

</div>

<h3>
Quelques comparables
</h3>

<div id="comparables"></div>

</div>

</section>

</div>

<script>

const fileEl =
  document.querySelector("#file");

const previews =
  document.querySelector("#previews");

const analyze =
  document.querySelector("#analyze");

const status =
  document.querySelector("#status");

const result =
  document.querySelector("#result");

const fields =
  document.querySelector("#fields");

const confidence =
  document.querySelector("#confidence");

const claims =
  document.querySelector("#claims");

const warnings =
  document.querySelector("#warnings");

const market =
  document.querySelector("#market");

const marketText =
  document.querySelector("#marketText");

const scoreBox =
  document.querySelector("#scoreBox");

const score =
  document.querySelector("#score");

const verdict =
  document.querySelector("#verdict");

const gap =
  document.querySelector("#gap");

const barFill =
  document.querySelector("#barFill");

const comparables =
  document.querySelector("#comparables");

let files = [];

/* =========================================================
   SÉLECTION DES PHOTOS
========================================================= */

fileEl.onchange = function(){

  const selected =
    Array.from(fileEl.files || []);

  if (!selected.length){
    return;
  }

  files =
    selected
      .slice(0,3);

  renderPreviews();

  analyze.disabled =
    files.length === 0;

  result.classList.add("hidden");
  market.classList.add("hidden");
  scoreBox.classList.add("hidden");

  status.classList.remove("hidden");

  status.textContent =
    files.length === 1
      ? "1 photo prête."
      : files.length + " photos prêtes.";

};

/* =========================================================
   APERÇU DES PHOTOS
========================================================= */

function renderPreviews(){

  previews.innerHTML = "";

  files.forEach(function(file,index){

    const item =
      document.createElement("div");

    item.className =
      "preview-item";

    const img =
      document.createElement("img");

    img.className =
      "preview-thumb";

    img.src =
      URL.createObjectURL(file);

    const remove =
      document.createElement("button");

    remove.type =
      "button";

    remove.className =
      "remove-photo";

    remove.textContent =
      "×";

    remove.title =
      "Supprimer cette photo";

    remove.onclick =
      function(){

        files.splice(index,1);

        renderPreviews();

        analyze.disabled =
          files.length === 0;

        status.classList.remove("hidden");

        status.textContent =
          files.length === 0
            ? "Ajoute au moins une photo."
            : files.length + " photo(s) prête(s).";
      };

    item.appendChild(img);
    item.appendChild(remove);

    previews.appendChild(item);

  });

}

/* =========================================================
   ANALYSE
========================================================= */

analyze.onclick = async function(){

  if (!files.length){
    status.textContent =
      "Ajoute au moins une photo.";

    return;
  }

  analyze.disabled = true;

  status.classList.remove("hidden");

  status.textContent =
    "🧠 Lecture des photos par l’IA…";

  result.classList.add("hidden");
  market.classList.add("hidden");
  scoreBox.classList.add("hidden");

  try {

    const fd =
      new FormData();

    files.forEach(function(file){

      fd.append(
        "images",
        file
      );

    });

    const response =
      await fetch(
        "/api/analyze",
        {
          method:"POST",
          body:fd
        }
      );

    const data =
      await response.json();

    if (!response.ok){
      throw new Error(
        data.error || "Erreur pendant l'analyse."
      );
    }

    const vehicle =
      data.vehicle;

    renderVehicle(vehicle);

    status.textContent =
      "✅ Lecture terminée.";

    market.classList.remove("hidden");

    marketText.textContent =
      "🔎 Recherche de véhicules comparables…";

    const marketResponse =
      await fetch(
        "/api/market",
        {
          method:"POST",
          headers:{
            "Content-Type":
              "application/json"
          },
          body:
            JSON.stringify(vehicle)
        }
      );

    const marketData =
      await marketResponse.json();

    renderMarket(marketData);

  } catch(error){

    console.error(error);

    status.textContent =
      "❌ " +
      (error.message ||
       "Une erreur est survenue.");

  }

  analyze.disabled =
    files.length === 0;

};

/* =========================================================
   AFFICHAGE DE L'ANNONCE
========================================================= */

function renderVehicle(v){

  result.classList.remove("hidden");

  confidence.innerHTML =
    '<span class="pill">' +
    "Confiance de lecture : " +
    (v.confidence ?? 0) +
    "/100" +
    "</span>";

  const map = [

    ["Marque",v.make],

    ["Modèle",v.model],

    ["Version",v.version],

    ["Année",v.year],

    [
      "Kilométrage",
      v.mileage_km
        ? Number(v.mileage_km)
            .toLocaleString("fr-FR") +
          " km"
        : null
    ],

    [
      "Prix",
      v.price_eur
        ? Number(v.price_eur)
            .toLocaleString("fr-FR") +
          " €"
        : null
    ],

    ["Énergie",v.energy],

    ["Boîte",v.gearbox],

    [
      "Puissance",
      v.power_hp
        ? v.power_hp + " ch"
        : null
    ],

    [
      "Vendeur",
      v.seller_type === "professional"
        ? "Professionnel"
        : v.seller_type === "private"
          ? "Particulier"
          : null
    ],

    ["Lieu",v.location]

  ];

  fields.innerHTML =
    map.map(function(item){

      const label =
        item[0];

      const value =
        item[1];

      return (
        '<div>' +
          '<div class="k">' +
            escapeHtml(label) +
          '</div>' +
          '<div class="v">' +
            (
              value == null
                ? "Non déterminé"
                : escapeHtml(value)
            ) +
          '</div>' +
        '</div>'
      );

    }).join("");

  const visibleClaims =
    Array.isArray(v.visible_claims)
      ? v.visible_claims
      : [];

  claims.innerHTML =
    visibleClaims.length
      ? "<h3>Éléments visibles</h3>" +
        visibleClaims.map(function(item){

          return (
            '<span class="pill">' +
            escapeHtml(item) +
            "</span>"
          );

        }).join("")
      : "";

  const uncertain =
    Array.isArray(v.uncertain_fields)
      ? v.uncertain_fields
      : [];

  const warningList =
    Array.isArray(v.warnings)
      ? v.warnings
      : [];

  warnings.innerHTML =
    uncertain.map(function(item){

      return (
        '<div class="warning">' +
        "⚠️ À vérifier : " +
        escapeHtml(item) +
        "</div>"
      );

    }).join("") +

    warningList.map(function(item){

      return (
        '<div class="warning">' +
        "⚠️ " +
        escapeHtml(item) +
        "</div>"
      );

    }).join("");

}

/* =========================================================
   AFFICHAGE DU MARCHÉ
========================================================= */

function renderMarket(m){

  if (!m.ok){

    scoreBox.classList.add("hidden");

    marketText.innerHTML =
      '<div class="warning">' +
      escapeHtml(
        m.error ||
        "Comparaison marché indisponible."
      ) +
      "</div>";

    return;
  }

  if (!m.market_median_eur){

    scoreBox.classList.add("hidden");

    marketText.innerHTML =
      '<div class="warning">' +
      "Pas assez de données comparables " +
      "pour conclure de manière fiable." +
      "</div>";

    if (
      m.comparables !== undefined
    ){

      marketText.innerHTML +=
        '<div class="small" style="margin-top:8px">' +
        m.comparables +
        " véhicule(s) comparable(s) trouvé(s)." +
        "</div>";

    }

    return;
  }

  marketText.innerHTML =
    "<strong>" +
    "Marché observé : " +
    Number(m.market_median_eur)
      .toLocaleString("fr-FR") +
    " €" +
    "</strong>" +

    "<br>" +

    "Fourchette indicative : " +

    Number(m.low_eur)
      .toLocaleString("fr-FR") +

    " – " +

    Number(m.high_eur)
      .toLocaleString("fr-FR") +

    " €" +

    "<br>" +

    '<span class="small">' +
    m.comparables +
    " comparables utilisés." +
    "</span>";

  scoreBox.classList.remove("hidden");

  score.textContent =
    m.deal_score ?? "—";

  const s =
    Number(m.deal_score);

  if (s >= 75){

    verdict.textContent =
      "🔥 Très bonne affaire";

  } else if (s >= 60){

    verdict.textContent =
      "👍 Intéressant";

  } else if (s >= 45){

    verdict.textContent =
      "🟡 Prix correct";

  } else {

    verdict.textContent =
      "🔴 Trop cher";

  }

  if (
    m.gap_pct == null
  ){

    gap.textContent = "";

  } else {

    const direction =
      m.gap_pct >= 0
        ? "Sous"
        : "Au-dessus";

    gap.textContent =
      direction +
      " du marché de " +
      Math.abs(m.gap_pct).toFixed(1) +
     
