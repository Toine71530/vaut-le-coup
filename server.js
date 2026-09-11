import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================================================
   UPLOAD
========================================================= */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 3,
    fileSize: 12 * 1024 * 1024
  }
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* =========================================================
   OPENAI
========================================================= */

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    })
  : null;

/* =========================================================
   OUTILS
========================================================= */

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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatEuro(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "Non déterminé";
  }

  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0
  }).format(Number(value));
}

function formatKm(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "Non déterminé";
  }

  return (
    new Intl.NumberFormat("fr-FR").format(Number(value)) +
    " km"
  );
}

function formatSeller(value) {
  if (value === "professional") {
    return "Professionnel";
  }

  if (value === "private") {
    return "Particulier";
  }

  return null;
}

/* =========================================================
   PAGE
========================================================= */

app.get("/", (_req, res) => {
  res.type("html").send(HTML);
});

/* =========================================================
   ANALYSE IA — 1 À 3 PHOTOS
========================================================= */

app.post(
  "/api/analyze",
  upload.array("images", 3),
  async (req, res) => {
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
          error:
            "OPENAI_API_KEY manquante. Le moteur IA n'est pas configuré."
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

Analyse une annonce automobile à partir de 1 à 3 photos.

IMPORTANT :

1. Analyse uniquement ce qui est réellement visible.
2. Croise les informations entre toutes les photos.
3. Les photos peuvent avoir des rôles différents :
   - capture d'écran de l'annonce
   - caractéristiques du véhicule
   - photo extérieure du véhicule
   - informations d'entretien
   - informations administratives
4. Ne force jamais un rôle particulier à une photo.
5. N'invente aucune information.
6. Si une information est absente, illisible ou ambiguë : null.
7. Ne déduis pas une finition simplement parce qu'elle semble probable.
8. Ne déduis pas la puissance simplement parce qu'elle semble probable.
9. Signale les contradictions entre les photos.
10. Observe les défauts extérieurs réellement visibles.
11. Ne prétends jamais avoir vérifié l'historique réel.
12. Ne prétends jamais avoir vérifié le kilométrage réel.
13. Ne prétends jamais avoir vérifié le marché automobile.
14. Les mentions "1ère main", "entretien constructeur",
    "batterie 100 %", "garantie", etc. sont des AFFIRMATIONS
    visibles dans l'annonce et non des faits vérifiés.
15. Si une photo permet de lire une information avec certitude,
    utilise-la même si elle n'est pas présente sur les autres photos.
16. Si deux photos donnent des informations différentes,
    conserve l'information la plus lisible et signale
    la contradiction dans warnings.

Retourne UNIQUEMENT un objet JSON valide :

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

confidence :
- entier de 0 à 100
- représente uniquement la confiance dans la lecture des photos.

uncertain_fields :
- uniquement les informations absentes, ambiguës ou difficiles à lire.

visible_claims :
- uniquement les éléments réellement visibles dans les photos.

warnings :
- contradictions entre les photos
- défauts visibles
- incohérences
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
        error:
          e.message ||
          "Erreur pendant l'analyse."
      });
    }
  }
);

/* =========================================================
   COMPARAISON MARCHÉ — CARHUNT
========================================================= */

app.post("/api/market", async (req, res) => {
  try {
    const key = process.env.CARHUNT_API_KEY;

    if (!key) {
      return res.status(503).json({
        error: "CARHUNT_API_KEY manquante."
      });
    }

    const v = req.body || {};

    if (!v.make || !v.model) {
      return res.status(400).json({
        error: "Marque et modèle nécessaires."
      });
    }

    const make = String(v.make)
      .toUpperCase()
      .trim();

    /*
      On retire une éventuelle génération finale :
      Prius 5 -> PRIUS
      Golf VIII -> GOLF
      208 II -> 208
    */

    const model = String(v.model)
      .toUpperCase()
      .replace(/\s+(?:[IVX]+|\d+)$/i, "")
      .trim();

    const targetYear = Number(v.year);
    const targetMileage = Number(v.mileage_km);
    const asking = Number(v.price_eur);

    /* =====================================================
       RECHERCHE CARHUNT
    ===================================================== */

    async function searchCarHunt(withYear) {
      const params = new URLSearchParams();

      params.set("make", make);
      params.set("model", model);
      params.set("page_size", "50");

      if (
        withYear &&
        Number.isFinite(targetYear)
      ) {
        params.set(
          "year",
          String(targetYear)
        );
      }

      const url =
        "https://api-pro.carhunt.fr/v1/listings/search?" +
        params.toString();

      const response = await fetch(url, {
        headers: {
          Authorization: "Bearer " + key
        }
      });

      if (!response.ok) {
        const detail = await response.text();

        throw new Error(
          "CarHunt HTTP " +
          response.status +
          ": " +
          detail
        );
      }

      const data = await response.json();

      return Array.isArray(data.listings)
        ? data.listings
        : [];
    }

    /* =====================================================
       FILTRAGE LOCAL
    ===================================================== */

    function filterListings(
      listings,
      mileageTolerance
    ) {
      return listings.filter((x) => {
        const price = Number(x.price);
        const year = Number(x.year);
        const mileage = Number(x.mileage);

        if (
          !Number.isFinite(price) ||
          price <= 0
        ) {
          return false;
        }

        if (
          Number.isFinite(targetYear) &&
          Number.isFinite(year) &&
          Math.abs(year - targetYear) > 1
        ) {
          return false;
        }

        if (
          Number.isFinite(targetMileage) &&
          Number.isFinite(mileage) &&
          Math.abs(
            mileage - targetMileage
          ) > mileageTolerance
        ) {
          return false;
        }

        /*
          On évite de compter l'annonce analysée
          si elle apparaît elle-même dans CarHunt.
        */

        if (
          Number.isFinite(asking) &&
          Number.isFinite(targetYear) &&
          Number.isFinite(targetMileage) &&
          price === asking &&
          year === targetYear &&
          mileage === targetMileage
        ) {
          return false;
        }

        return true;
      });
    }

    /* =====================================================
       NIVEAU 1
       Année ±1
       Kilométrage ±30 000
    ===================================================== */

    let rawListings =
      await searchCarHunt(true);

    let listings =
      filterListings(
        rawListings,
        30000
      );

    /* =====================================================
       NIVEAU 2
       Même année ±1
       Kilométrage ±60 000
    ===================================================== */

    if (listings.length < 5) {
      listings =
        filterListings(
          rawListings,
          60000
        );
    }

    /* =====================================================
       NIVEAU 3
       Recherche sans année
       puis filtrage local
    ===================================================== */

    if (listings.length < 5) {
      const widerListings =
        await searchCarHunt(false);

      const widerFiltered =
        filterListings(
          widerListings,
          60000
        );

      const combined = [
        ...listings,
        ...widerFiltered
      ];

      const seen = new Set();

      listings = combined.filter((x) => {
        const id =
          x.id ??
          [
            x.make,
            x.model,
            x.year,
            x.mileage,
            x.price,
            x.source_url
          ].join("|");

        if (seen.has(id)) {
          return false;
        }

        seen.add(id);
        return true;
      });
    }

    /* =====================================================
       TRI PAR PROXIMITÉ
    ===================================================== */

    listings.sort((a, b) => {
      const yearA = Number(a.year);
      const yearB = Number(b.year);

      const mileageA = Number(a.mileage);
      const mileageB = Number(b.mileage);

      const yearDistanceA =
        Number.isFinite(targetYear) &&
        Number.isFinite(yearA)
          ? Math.abs(
              yearA - targetYear
            ) * 100000
          : 0;

      const yearDistanceB =
        Number.isFinite(targetYear) &&
        Number.isFinite(yearB)
          ? Math.abs(
              yearB - targetYear
            ) * 100000
          : 0;

      const mileageDistanceA =
        Number.isFinite(targetMileage) &&
        Number.isFinite(mileageA)
          ? Math.abs(
              mileageA - targetMileage
            )
          : 0;

      const mileageDistanceB =
        Number.isFinite(targetMileage) &&
        Number.isFinite(mileageB)
          ? Math.abs(
              mileageB - targetMileage
            )
          : 0;

      return (
        yearDistanceA +
        mileageDistanceA -
        yearDistanceB -
        mileageDistanceB
      );
    });

    /* =====================================================
       PRIX
    ===================================================== */

    const prices =
      listings
        .map((x) => Number(x.price))
        .filter(
          (p) =>
            Number.isFinite(p) &&
            p > 0
        )
        .sort(
          (a, b) => a - b
        );

    /* =====================================================
       CONFIANCE MARCHÉ
    ===================================================== */

    let marketConfidence = 0;

    if (prices.length >= 20) {
      marketConfidence = 95;
    } else if (prices.length >= 12) {
      marketConfidence = 85;
    } else if (prices.length >= 8) {
      marketConfidence = 75;
    } else if (prices.length >= 5) {
      marketConfidence = 60;
    } else if (prices.length >= 3) {
      marketConfidence = 40;
    } else if (prices.length > 0) {
      marketConfidence = 20;
    }

    /* =====================================================
       MOINS DE 3 COMPARABLES
    ===================================================== */

    if (prices.length < 3) {
      return res.json({
        ok: true,
        comparables: prices.length,
        market_confidence: marketConfidence,

        market_status:
          "Pas assez de données comparables pour conclure de manière fiable.",

        market_median_eur: null,
        low_eur: null,
        high_eur: null,

        asking_price_eur:
          Number.isFinite(asking)
            ? asking
            : null,

        gap_eur: null,
        gap_pct: null,
        deal_score: null,

        sample:
          listings.slice(0, 8)
      });
    }

    /* =====================================================
       MÉDIANE
    ===================================================== */

    const median =
      prices[
        Math.floor(
          prices.length / 2
        )
      ];

    function percentile(p) {
      const index =
        Math.floor(
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
    }

    const low =
      percentile(0.15);

    const high =
      percentile(0.85);

    /* =====================================================
       ÉCART AU MARCHÉ
    ===================================================== */

    const gapPct =
      Number.isFinite(asking) &&
      asking > 0 &&
      median > 0
        ? ((median - asking) /
            median) *
          100
        : null;

    const gapEur =
      Number.isFinite(asking)
        ? Math.round(
            median - asking
          )
        : null;

    /* =====================================================
       SCORE
       Aucun score sous 5 comparables.
    ===================================================== */

    let dealScore = null;

    if (
      prices.length >= 5 &&
      gapPct !== null
    ) {
      dealScore =
        Math.min(
          prices.length < 10
            ? 90
            : 100,
          Math.max(
            0,
            Math.round(
              50 +
              gapPct * 2.5
            )
          )
        );
    }

    /* =====================================================
       STATUT
    ===================================================== */

    let marketStatus;

    if (prices.length < 5) {
      marketStatus =
        "Marché peu documenté : estimation indicative.";
    } else if (prices.length < 8) {
      marketStatus =
        "Comparaison exploitable, mais échantillon limité.";
    } else {
      marketStatus =
        "Comparaison marché suffisamment documentée.";
    }

    /* =====================================================
       RÉPONSE
    ===================================================== */

    res.json({
      ok: true,

      comparables:
        prices.length,

      market_confidence:
        marketConfidence,

      market_status:
        marketStatus,

      market_median_eur:
        Math.round(median),

      low_eur:
        Math.round(low),

      high_eur:
        Math.round(high),

      asking_price_eur:
        Number.isFinite(asking)
          ? asking
          : null,

      gap_eur:
        gapEur,

      gap_pct:
        gapPct === null
          ? null
          : Math.round(
              gapPct * 10
            ) / 10,

      deal_score:
        dealScore,

      sample:
        listings
          .slice(0, 8)
          .map((x) => ({
            id:
              x.id ?? null,

            make:
              x.make ?? null,

            model:
              x.model ?? null,

            version:
              x.version ?? null,

            finition:
              x.finition ?? null,

            price:
              x.price ?? null,

            year:
              x.year ?? null,

            mileage:
              x.mileage ?? null,

            energy:
              x.energy ?? null,

            gearbox:
              x.gearbox ?? null,

            horsepower:
              x.horsepower ?? null,

            seller_type:
              x.seller_type ?? null,

            source:
              x.source ?? null,

            source_url:
              x.source_url ?? null
          }))
    });

  } catch (e) {
    console.error(e);

    res.status(500).json({
      error:
        e.message ||
        "Erreur pendant la comparaison marché."
    });
  }
});

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,

    vision:
      Boolean(
        process.env.OPENAI_API_KEY
      ),

    market:
      Boolean(
        process.env.CARHUNT_API_KEY
      )
  });
});

/* =========================================================
   INTERFACE
========================================================= */

const HTML = `
<!doctype html>

<html lang="fr">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>Vaut le Coup ?</title>

<style>

:root {
  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  color: #17202a;
  background: #f5f7f9;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f5f7f9;
}

.wrap {
  max-width: 720px;
  margin: auto;
  padding: 20px;
}

header {
  padding: 20px 0 25px;
}

.brand {
  font-size: 32px;
  font-weight: 900;
}

.tag {
  color: #68737d;
  font-size: 18px;
  margin-top: 4px;
}

.card {
  background: white;
  border: 1px solid #e1e6ea;
  border-radius: 20px;
  padding: 22px;
  margin: 16px 0;
  box-shadow: 0 6px 20px #00000008;
}

h1,
h2,
h3 {
  margin-top: 0;
}

.drop {
  display: block;
  border: 2px dashed #bdc7cf;
  border-radius: 18px;
  padding: 30px 20px;
  text-align: center;
  cursor: pointer;
}

.drop strong {
  display: block;
  font-size: 20px;
  margin: 8px 0;
}

.small {
  color: #7a858e;
}

input[type="file"] {
  display: none;
}

#previews {
  display: grid;
  grid-template-columns:
    repeat(3, 1fr);
  gap: 10px;
  margin-top: 14px;
}

.thumb {
  position: relative;
}

.thumb img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 12px;
  border: 1px solid #ddd;
}

.remove {
  position: absolute;
  top: 5px;
  right: 5px;

  width: 32px;
  height: 32px;

  border-radius: 50%;
  border: 0;

  background: #17202a;
  color: white;

  font-size: 20px;
  cursor: pointer;
}

button.primary {
  width: 100%;

  margin-top: 16px;
  padding: 16px;

  border: 0;
  border-radius: 14px;

  background: #17202a;
  color: white;

  font-size: 18px;
  font-weight: 800;

  cursor: pointer;
}

button.primary:disabled {
  opacity: .45;
  cursor: not-allowed;
}

.status {
  margin-top: 15px;

  padding: 14px;

  border-radius: 14px;

  background: #eef1f3;
}

.hidden {
  display: none !important;
}

.confidence {
  display: inline-block;

  background: #eef1f3;

  border-radius: 999px;

  padding: 9px 14px;

  margin-bottom: 18px;
}

.row {
  margin: 15px 0;
}

.label {
  color: #7b858d;
  font-size: 15px;
}

.value {
  font-size: 20px;
  font-weight: 800;
  margin-top: 2px;
}

.pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pill {
  background: #eef2f4;

  border-radius: 999px;

  padding: 9px 13px;
}

.warning {
  background: #fff3dc;

  border-radius: 14px;

  padding: 14px;

  margin: 10px 0;
}

.market {
  background: #f8fafb;

  border-radius: 16px;

  padding: 16px;
}

.market-main {
  font-size: 30px;
  font-weight: 900;
}

.market-range {
  font-size: 18px;
  margin-top: 8px;
}

.score {
  font-size: 42px;
  font-weight: 900;
  margin: 8px 0;
}

.comparable {
  padding: 12px 0;
  border-bottom: 1px solid #e2e6e9;
}

.comparable a {
  color: inherit;
}

.error {
  background: #ffe7e7;

  color: #9d2020;

  padding: 14px;

  border-radius: 14px;
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
Avant d'acheter. Demande à l'IA.
</div>

</header>

<section class="card">

<h1>
Analyse une annonce
</h1>

<p>
Ajoute jusqu'à 3 photos de l'annonce ou du véhicule.
</p>

<label
  class="drop"
  for="file"
>

📸

<strong>
Ajoute une capture ou une photo
</strong>

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

<div id="previews"></div>

<div
  id="status"
  class="status hidden"
></div>

<button
  id="analyze"
  class="primary"
  disabled
>
Analyser l'annonce
</button>

</section>

<div id="result"></div>

</div>

<script>

const fileInput =
  document.getElementById("file");

const previews =
  document.getElementById("previews");

const analyzeButton =
  document.getElementById("analyze");

const statusBox =
  document.getElementById("status");

const result =
  document.getElementById("result");

let files = [];

function formatEuro(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "Non déterminé";
  }

  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0
  }).format(Number(value));
}

function formatKm(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "Non déterminé";
  }

  return new Intl.NumberFormat("fr-FR").format(Number(value)) + " km";
}

function formatSeller(value) {
  if (value === "professional") {
    return "Professionnel";
  }

  if (value === "private") {
    return "Particulier";
  }

  return null;
}

/* =========================================================
   PHOTOS
========================================================= */

fileInput.addEventListener(
  "change",
  function () {

    const selected =
      Array.from(
        fileInput.files || []
      );

    for (const file of selected) {

      if (files.length >= 3) {
        break;
      }

      files.push(file);
    }

    fileInput.value = "";

    renderPreviews();

  }
);

/* =========================================================
   APERÇU PHOTOS
========================================================= */

function renderPreviews() {

  previews.innerHTML = "";

  files.forEach(
    function (file, index) {

      const wrapper =
        document.createElement("div");

      wrapper.className =
        "thumb";

      const img =
        document.createElement("img");

      const objectUrl =
        URL.createObjectURL(file);

      img.src =
        objectUrl;

      img.onload =
        function () {
          URL.revokeObjectURL(
            objectUrl
          );
        };

      const remove =
        document.createElement("button");

      remove.className =
        "remove";

      remove.textContent =
        "×";

      remove.type =
        "button";

      remove.onclick =
        function () {

          files.splice(
            index,
            1
          );

          renderPreviews();

        };

      wrapper.appendChild(img);

      wrapper.appendChild(remove);

      previews.appendChild(wrapper);

    }
  );

  analyzeButton.disabled =
    files.length === 0;
}

/* =========================================================
   ANALYSE
========================================================= */

analyzeButton.addEventListener(
  "click",
  async function () {

    if (!files.length) {
      return;
    }

    analyzeButton.disabled =
      true;

    statusBox.className =
      "status";

    statusBox.textContent =
      "🔎 Analyse des photos en cours…";

    result.innerHTML = "";

    try {

      const formData =
        new FormData();

      files.forEach(
        function (file) {

          formData.append(
            "images",
            file
          );

        }
      );

      const response =
        await fetch(
          "/api/analyze",
          {
            method: "POST",
            body: formData
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Erreur d'analyse."
        );
      }

      statusBox.textContent =
        "✅ Lecture terminée.";

      renderVehicle(
        data.vehicle
      );

      await loadMarket(
        data.vehicle
      );

    } catch (error) {

      statusBox.className =
        "status error";

      statusBox.textContent =
        "❌ " +
        error.message;

    } finally {

      analyzeButton.disabled =
        files.length === 0;

    }

  }
);

/* =========================================================
   AFFICHAGE LECTURE
========================================================= */

function renderVehicle(v) {

  const card =
    document.createElement("section");

  card.className =
    "card";

  const title =
    document.createElement("h2");

  title.textContent =
    "Lecture de l'annonce";

  card.appendChild(title);

  const confidence =
    document.createElement("div");

  confidence.className =
    "confidence";

  confidence.textContent =
    "Confiance de lecture : " +
    Number(v.confidence || 0) +
    "/100";

  card.appendChild(
    confidence
  );

  const fields = [
    ["Marque", v.make],
    ["Modèle", v.model],
    ["Version", v.version],
    ["Année", v.year],
    ["Kilométrage", formatKm(v.mileage_km)],
    ["Prix", formatEuro(v.price_eur)],
    ["Énergie", v.energy],
    ["Boîte", v.gearbox],
    [
      "Puissance",
      v.power_hp
        ? v.power_hp + " ch"
        : null
    ],
    [
      "Vendeur",
      formatSeller(v.seller_type)
    ],
    ["Lieu", v.location]
  ];

  fields.forEach(
    function (item) {

      if (
        item[1] === null ||
        item[1] === undefined ||
        item[1] === ""
      ) {
        return;
      }

      const row =
        document.createElement("div");

      row.className =
        "row";

      const label =
        document.createElement("div");

      label.className =
        "label";

      label.textContent =
        item[0];

      const value =
        document.createElement("div");

      value.className =
        "value";

      value.textContent =
        item[1];

      row.appendChild(label);

      row.appendChild(value);

      card.appendChild(row);

    }
  );

  if (
    Array.isArray(v.visible_claims) &&
    v.visible_claims.length
  ) {

    const h =
      document.createElement("h3");

    h.textContent =
      "Éléments visibles";

    card.appendChild(h);

    const pills =
      document.createElement("div");

    pills.className =
      "pills";

    v.visible_claims.forEach(
      function (claim) {

        const pill =
          document.createElement("div");

        pill.className =
          "pill";

        pill.textContent =
          claim;

        pills.appendChild(pill);

      }
    );

    card.appendChild(pills);

  }

  const warnings = [];

  if (
    Array.isArray(v.uncertain_fields)
  ) {

    v.uncertain_fields.forEach(
      function (field) {

        warnings.push(
          "À vérifier : " +
          field
        );

      }
    );

  }

  if (
    Array.isArray(v.warnings)
  ) {

    v.warnings.forEach(
      function (warning) {

        warnings.push(
          warning
        );

      }
    );

  }

  if (warnings.length) {

    const h =
      document.createElement("h3");

    h.textContent =
      "Points à vérifier";

    card.appendChild(h);

    warnings.forEach(
      function (warning) {

        const box =
          document.createElement("div");

        box.className =
          "warning";

        box.textContent =
          "⚠️ " +
          warning;

        card.appendChild(box);

      }
    );

  }

  result.appendChild(card);
}

/* =========================================================
   MARCHÉ
========================================================= */

async function loadMarket(v) {

  const card =
    document.createElement("section");

  card.className =
    "card";

  card.innerHTML =
    "<h2>Est-ce que ça vaut le coup ?</h2>" +
    "<div class='market'>" +
    "Recherche des comparables…" +
    "</div>";

  result.appendChild(card);

  try {

    const response =
      await fetch(
        "/api/market",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              make:
                v.make,

              model:
                v.model,

              year:
                v.year,

              mileage_km:
                v.mileage_km,

              price_eur:
                v.price_eur
            })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Erreur marché."
      );
    }

    renderMarket(
      card,
      data
    );

  } catch (error) {

    card.innerHTML =
      "<h2>Est-ce que ça vaut le coup ?</h2>" +
      "<div class='error'>" +
      escapeHtml(
        error.message
      ) +
      "</div>";

  }
}

/* =========================================================
   AFFICHAGE MARCHÉ
========================================================= */

function renderMarket(
  card,
  data
) {

  let html =
    "<h2>Est-ce que ça vaut le coup ?</h2>";

  html +=
    "<div class='market'>";

  html +=
    "<div><strong>" +
    escapeHtml(
      data.market_status ||
      ""
    ) +
    "</strong></div>";

  html +=
    "<div style='margin-top:12px'>" +
    "Confiance marché : <strong>" +
    Number(
      data.market_confidence || 0
    ) +
    "/100</strong>" +
    "</div>";

  html +=
    "<div style='margin-top:16px'>";

  html +=
    "<div class='label'>Prix demandé</div>";

  html +=
    "<div class='market-main'>" +
    formatEuro(
      data.asking_price_eur
    ) +
    "</div>";

  html +=
    "</div>";

  if (
    data.market_median_eur !==
    null
  ) {

    html +=
      "<div class='market-range'>" +
      "Marché estimé : <strong>" +
      formatEuro(
        data.market_median_eur
      ) +
      "</strong><br>" +
      "Fourchette indicative : " +
      formatEuro(
        data.low_eur
      ) +
      " – " +
      formatEuro(
        data.high_eur
      ) +
      "</div>";

    if (
      data.gap_eur !== null
    ) {

      const sign =
        data.gap_eur >= 0
          ? "sous"
          : "au-dessus";

      html +=
        "<div style='margin-top:12px'>" +
        "Le prix demandé est " +
        "<strong>" +
        Math.abs(
          data.gap_pct || 0
        ) +
        "% " +
        sign +
        "</strong> du prix médian." +
        "</div>";

    }

    if (
      data.deal_score !== null
    ) {

      html +=
        "<div style='margin-top:16px'>" +
        "<div class='label'>" +
        "Score bonne affaire" +
        "</div>" +
        "<div class='score'>" +
        data.deal_score +
        "/100" +
        "</div>" +
        "</div>";

    } else {

      html +=
        "<div class='warning' style='margin-top:16px'>" +
        "⚠️ Pas assez de comparables " +
        "pour attribuer un score fiable." +
        "</div>";

    }

  }

  html +=
    "<div style='margin-top:14px'>" +
    "<strong>" +
    data.comparables +
    "</strong> véhicule(s) comparable(s) trouvé(s)." +
    "</div>";

  /* =====================================================
     COMPARABLES
  ===================================================== */

  if (
    Array.isArray(data.sample) &&
    data.sample.length
  ) {

    html +=
      "<h3 style='margin-top:20px'>" +
      "Comparables utilisés" +
      "</h3>";

    data.sample.forEach(
      function (x) {

        html +=
          "<div class='comparable'>";

        html +=
          "<strong>" +
          formatEuro(x.price) +
          "</strong>";

        if (x.year) {

          html +=
            " · " +
            escapeHtml(
              x.year
            );

        }

        if (x.mileage) {

          html +=
            " · " +
            formatKm(
              x.mileage
            );

        }

        if (x.energy) {

          html +=
            " · " +
            escapeHtml(
              x.energy
            );

        }

        if (x.version) {

          html +=
            "<br>" +
            escapeHtml(
              x.version
            );

        }

        if (x.source) {

          html +=
            "<br>" +
            "<span class='label'>" +
            escapeHtml(
              x.source
            ) +
            "</span>";

        }

        if (x.source_url) {

          html +=
            "<br>" +
            "<a href='" +
            escapeHtml(
              x.source_url
            ) +
            "' target='_blank' rel='noopener'>" +
            "Voir l'annonce" +
            "</a>";

        }

        html +=
          "</div>";

      }
    );

  }

  html +=
    "</div>";

  card.innerHTML =
    html;
}

/* =========================================================
   FIN
========================================================= */

</script>

</body>

</html>
`;

app.listen(PORT, () => {
  console.log(
    "Vaut le Coup ? démarré sur le port " +
    PORT
  );
});
