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

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* =========================================================
   PAGE
========================================================= */

app.get("/", (_req, res) => {
  res.type("html").send(HTML);
});

/* =========================================================
   ANALYSE IA
   1 À 3 PHOTOS
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

Tu analyses une annonce automobile à partir de 1 à 3 photos.

=========================================================
RÈGLES ABSOLUES
=========================================================

1. Analyse uniquement ce qui est réellement visible.

2. Croise les informations présentes sur TOUTES les photos.

3. Les photos peuvent avoir des rôles totalement différents :
   - capture de l'annonce
   - caractéristiques techniques
   - photo extérieure
   - photo intérieure
   - entretien
   - garantie
   - informations administratives
   - financement
   - autre

4. Ne force jamais un rôle particulier à une photo.

5. N'invente aucune information.

6. Si une information est absente, illisible ou ambiguë :
   retourne null.

7. Ne déduis jamais une finition uniquement parce qu'elle
   semble probable.

8. Ne déduis jamais une puissance uniquement parce qu'elle
   semble probable.

9. Signale les contradictions entre les photos.

10. Observe les défauts visibles :
    carrosserie, jantes, pneus, vitres, intérieur, etc.

11. Ne prétends jamais avoir vérifié l'historique réel.

12. Ne prétends jamais avoir vérifié le kilométrage réel.

13. Ne prétends jamais avoir vérifié le marché automobile.

14. Les mentions telles que :
    "1ère main",
    "entretien constructeur",
    "batterie 100 %",
    "garantie",
    "jamais accidentée",
    "révision faite",
    etc.
    sont des AFFIRMATIONS visibles dans l'annonce.
    Elles ne sont PAS considérées comme vérifiées.

15. Si une information apparaît sur une seule photo mais
    qu'elle est parfaitement lisible, utilise-la.

16. Si deux photos donnent des informations différentes,
    conserve l'information la plus lisible ET ajoute une
    alerte dans warnings.

17. Ne transforme pas une absence d'information en défaut.

18. Les défauts réellement visibles doivent être distingués
    des simples éléments impossibles à vérifier.

19. La confiance concerne UNIQUEMENT la qualité de lecture
    des photos, pas la qualité du prix.

=========================================================
FORMAT DE SORTIE
=========================================================

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
- confiance dans la lecture des informations visibles.

uncertain_fields :
- informations absentes
- informations ambiguës
- informations difficiles à lire.

visible_claims :
- affirmations réellement visibles dans l'annonce.

warnings :
- contradictions entre photos
- défauts réellement visibles
- incohérences
- éléments importants à vérifier avant achat.

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
   MARCHÉ — CARHUNT
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
      On retire seulement une génération finale.

      Prius 5 -> PRIUS
      Golf VIII -> GOLF
      208 II -> 208

      Le filtrage année/génération est ensuite effectué
      localement avec les données réellement retournées.
    */

    const model = String(v.model)
      .toUpperCase()
      .replace(/\s+(?:[IVX]+|\d+)$/i, "")
      .trim();

    const targetYear = numberOrNull(v.year);
    const targetMileage = numberOrNull(v.mileage_km);
    const asking = numberOrNull(v.price_eur);

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
        targetYear !== null
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
       FILTRAGE
    ===================================================== */

    function filterListings(
      listings,
      options = {}
    ) {
      const {
        yearTolerance = 1,
        mileageTolerance = 30000,
        requireYear = false,
        requireMileage = false
      } = options;

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

        /*
          Année
        */

        if (
          targetYear !== null &&
          Number.isFinite(year)
        ) {
          if (
            Math.abs(year - targetYear) >
            yearTolerance
          ) {
            return false;
          }
        } else if (requireYear) {
          return false;
        }

        /*
          Kilométrage
        */

        if (
          targetMileage !== null &&
          Number.isFinite(mileage)
        ) {
          if (
            Math.abs(
              mileage - targetMileage
            ) > mileageTolerance
          ) {
            return false;
          }
        } else if (requireMileage) {
          return false;
        }

        /*
          Exclusion de l'annonce analysée.
        */

        if (
          asking !== null &&
          targetYear !== null &&
          targetMileage !== null &&
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
       RECHERCHE PROGRESSIVE
    ===================================================== */

    let rawWithYear =
      await searchCarHunt(true);

    let listings =
      filterListings(
        rawWithYear,
        {
          yearTolerance: 1,
          mileageTolerance: 30000
        }
      );

    let searchLevel = 1;

    /*
      NIVEAU 2 :
      même génération / année ±1,
      mais kilométrage ±60 000.
    */

    if (listings.length < 5) {
      listings =
        filterListings(
          rawWithYear,
          {
            yearTolerance: 1,
            mileageTolerance: 60000
          }
        );

      searchLevel = 2;
    }

    /*
      NIVEAU 3 :
      année ±1 mais sans contrainte kilométrique.

      Cela reste préférable à mélanger plusieurs générations.
    */

    if (listings.length < 5) {
      listings =
        filterListings(
          rawWithYear,
          {
            yearTolerance: 1,
            mileageTolerance: Infinity
          }
        );

      searchLevel = 3;
    }

    /*
      NIVEAU 4 :
      recherche sans année.
      On garde cependant un kilométrage raisonnablement proche.
    */

    if (listings.length < 5) {
      const rawWide =
        await searchCarHunt(false);

      const wide =
        filterListings(
          rawWide,
          {
            yearTolerance: Infinity,
            mileageTolerance: 60000
          }
        );

      const combined = [
        ...listings,
        ...wide
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

      searchLevel = 4;
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
        targetYear !== null &&
        Number.isFinite(yearA)
          ? Math.abs(
              yearA - targetYear
            )
          : 0;

      const yearDistanceB =
        targetYear !== null &&
        Number.isFinite(yearB)
          ? Math.abs(
              yearB - targetYear
            )
          : 0;

      const mileageDistanceA =
        targetMileage !== null &&
        Number.isFinite(mileageA)
          ? Math.abs(
              mileageA - targetMileage
            )
          : 0;

      const mileageDistanceB =
        targetMileage !== null &&
        Number.isFinite(mileageB)
          ? Math.abs(
              mileageB - targetMileage
            )
          : 0;

      return (
        yearDistanceA * 100000 +
        mileageDistanceA -
        yearDistanceB * 100000 -
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

    /*
      On pénalise la confiance lorsque la recherche
      a dû être élargie.
    */

    if (searchLevel === 2) {
      marketConfidence =
        Math.max(
          0,
          marketConfidence - 5
        );
    }

    if (searchLevel === 3) {
      marketConfidence =
        Math.max(
          0,
          marketConfidence - 15
        );
    }

    if (searchLevel === 4) {
      marketConfidence =
        Math.max(
          0,
          marketConfidence - 25
        );
    }

    /* =====================================================
       PAS ASSEZ DE DONNÉES
    ===================================================== */

    if (prices.length < 3) {
      return res.json({
        ok: true,

        comparables:
          prices.length,

        market_confidence:
          marketConfidence,

        market_status:
          "Pas assez de données comparables pour conclure de manière fiable.",

        market_median_eur: null,
        low_eur: null,
        high_eur: null,

        asking_price_eur:
          asking,

        gap_eur: null,
        gap_pct: null,

        deal_score: null,

        search_level:
          searchLevel,

        sample:
          listings
            .slice(0, 8)
            .map(formatComparable)
      });
    }

    /* =====================================================
       MÉDIANE
    ===================================================== */

    function medianOf(values) {
      const sorted = [...values].sort(
        (a, b) => a - b
      );

      const middle =
        Math.floor(
          sorted.length / 2
        );

      if (
        sorted.length % 2 === 0
      ) {
        return (
          sorted[middle - 1] +
          sorted[middle]
        ) / 2;
      }

      return sorted[middle];
    }

    const median =
      medianOf(prices);

    /* =====================================================
       PERCENTILES
    ===================================================== */

    function percentile(values, p) {
      if (!values.length) {
        return null;
      }

      const sorted = [...values].sort(
        (a, b) => a - b
      );

      const index =
        (sorted.length - 1) * p;

      const lower =
        Math.floor(index);

      const upper =
        Math.ceil(index);

      if (lower === upper) {
        return sorted[lower];
      }

      return (
        sorted[lower] +
        (sorted[upper] -
          sorted[lower]) *
          (index - lower)
      );
    }

    const low =
      percentile(prices, 0.15);

    const high =
      percentile(prices, 0.85);

    /* =====================================================
       ÉCART AU MARCHÉ
    ===================================================== */

    const gapPct =
      asking !== null &&
      asking > 0 &&
      median > 0
        ? ((median - asking) /
            median) *
          100
        : null;

    const gapEur =
      asking !== null
        ? Math.round(
            median - asking
          )
        : null;

    /* =====================================================
       SCORE
       UNIQUEMENT À PARTIR DE 5 COMPARABLES.
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
    } else if (searchLevel >= 3) {
      marketStatus =
        "Comparaison indicative : recherche élargie nécessaire.";
    } else if (prices.length < 8) {
      marketStatus =
        "Comparaison exploitable, mais échantillon limité.";
    } else {
      marketStatus =
        "Comparaison marché suffisamment documentée.";
    }

    /* =====================================================
       FORMAT COMPARABLE
    ===================================================== */

    function formatComparable(x) {
      return {
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
      };
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
        asking,

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

      search_level:
        searchLevel,

      sample:
        listings
          .slice(0, 8)
          .map(formatComparable)
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

/* =========================================================
   OUTILS
========================================================= */

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
    new Intl.NumberFormat("fr-FR")
      .format(Number(value)) +
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
   APERÇU
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

      remove.setAttribute(
        "aria-label",
        "Supprimer cette photo"
      );

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
   AFFICHAGE DU VÉHICULE
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

  /* =======================================================
     ÉLÉMENTS VISIBLES
  ======================================================= */

  if (
    Array.isArray(v.visible_claims) &&
    v.visible_claims.length
  ) {

    const h =
      document.createElement("h3");

    h.textContent =
      "Éléments visibles dans l'annonce";

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

  /* =======================================================
     ALERTES
  ======================================================= */

  const warnings = [];

  if (
    Array.isArray(v.uncertain_fields)
  ) {

    v
