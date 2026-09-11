import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 10000;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 3,
    fileSize: 12 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    cb(
      null,
      /^image\/(jpeg|png|webp|jpg)$/i.test(file.mimetype)
    );
  }
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* =========================================================
   OUTILS
========================================================= */

const numberOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const formatEuro = (value) => {
  if (value == null) return "Non déterminé";

  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0
  }).format(value);
};

const formatKm = (value) => {
  if (value == null) return "Non déterminé";

  return (
    new Intl.NumberFormat("fr-FR").format(value) +
    " km"
  );
};

const cleanJson = (text) => {
  const s = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("Réponse IA JSON invalide.");
  }

  return JSON.parse(s.slice(start, end + 1));
};

const cleanModel = (value) =>
  String(value || "")
    .toUpperCase()
    .replace(/\s+(?:[IVX]+|\d+)$/i, "")
    .trim();

/* =========================================================
   PAGE
========================================================= */

const HTML = `<!doctype html>
<html lang="fr">

<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1">

<title>Vaut le Coup ?</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f4f6f8;
  color: #18212b;
  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

main {
  max-width: 720px;
  margin: auto;
  padding: 28px 16px 60px;
}

h1 {
  font-size: 42px;
  line-height: 1;
  margin: 0 0 8px;
}

h2 {
  font-size: 30px;
  margin: 0 0 22px;
}

h3 {
  margin-top: 28px;
}

p {
  font-size: 18px;
  line-height: 1.45;
}

.sub {
  color: #66717d;
  font-size: 21px;
  margin-bottom: 34px;
}

.card {
  background: white;
  border: 1px solid #dfe3e7;
  border-radius: 28px;
  padding: 28px;
  margin: 18px 0;
  box-shadow: 0 2px 10px #00000008;
}

.drop {
  display: block;
  border: 3px dashed #c7cdd3;
  border-radius: 24px;
  padding: 35px 18px;
  text-align: center;
  cursor: pointer;
  font-size: 20px;
}

.drop strong {
  font-size: 24px;
}

.small {
  display: block;
  color: #7a838d;
  margin-top: 14px;
}

#file {
  display: none;
}

.previews {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.thumb {
  position: relative;
  width: 112px;
  height: 112px;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 18px;
  border: 1px solid #ddd;
}

.remove {
  position: absolute;
  right: -5px;
  top: -5px;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: #17212b;
  color: white;
  font-size: 20px;
}

.btn {
  width: 100%;
  border: 0;
  border-radius: 18px;
  padding: 18px;
  background: #17212b;
  color: white;
  font-size: 20px;
  font-weight: 800;
  cursor: pointer;
  margin-top: 18px;
}

.btn:disabled {
  opacity: .5;
}

.status,
.result {
  background: #f7f8fa;
  border-radius: 22px;
  padding: 22px;
  margin-top: 18px;
}

.warn {
  background: #fff1d6;
  border-radius: 18px;
  padding: 18px;
  margin: 12px 0;
}

.error {
  background: #ffe1e1;
  color: #a32626;
  border-radius: 18px;
  padding: 18px;
  margin-top: 18px;
}

.price {
  font-size: 46px;
  font-weight: 900;
}

.muted {
  color: #68727d;
}

.score {
  font-size: 25px;
  font-weight: 800;
}

.comp {
  padding: 16px 0;
  border-bottom: 1px solid #ddd;
}

.comp:last-child {
  border: 0;
}

.link {
  color: #17212b;
  font-weight: 700;
}

.tag {
  display: inline-block;
  background: #e9edf1;
  border-radius: 99px;
  padding: 5px 10px;
  margin: 3px 4px 3px 0;
}

</style>
</head>

<body>

<main>

<h1>Vaut le Coup ? ✓</h1>

<div class="sub">
Avant d’acheter. Demande à l’IA.
</div>

<section class="card">

<h2>Analyse une annonce</h2>

<p>
Ajoute jusqu’à 3 photos de l’annonce ou du véhicule.
</p>

<label class="drop" for="file">

📸<br>

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
  accept="image/jpeg,image/png,image/webp"
  multiple
>

<div id="previews" class="previews"></div>

<div id="error"></div>

<button id="go" class="btn" disabled>
Analyser l’annonce
</button>

</section>

<section
  id="analysis"
  class="card"
  hidden>
</section>

<section
  id="market"
  class="card"
  hidden>
</section>

</main>

<script>

const fileInput =
  document.getElementById("file");

const previews =
  document.getElementById("previews");

const go =
  document.getElementById("go");

const errorBox =
  document.getElementById("error");

const analysis =
  document.getElementById("analysis");

const market =
  document.getElementById("market");

let files = [];

/* =========================================================
   PROTECTION HTML CÔTÉ NAVIGATEUR
========================================================= */

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[c])
  );

/* =========================================================
   PHOTOS
========================================================= */

function renderFiles() {

  previews.innerHTML = "";

  files.forEach((file, index) => {

    const wrapper =
      document.createElement("div");

    wrapper.className = "thumb";

    const image =
      document.createElement("img");

    image.src =
      URL.createObjectURL(file);

    const button =
      document.createElement("button");

    button.type = "button";
    button.className = "remove";
    button.textContent = "×";

    button.onclick = () => {

      files.splice(index, 1);

      renderFiles();
    };

    wrapper.appendChild(image);
    wrapper.appendChild(button);

    previews.appendChild(wrapper);
  });

  go.disabled = files.length === 0;
}

fileInput.onchange = () => {

  files = [
    ...files,
    ...Array.from(fileInput.files)
  ].slice(0, 3);

  fileInput.value = "";

  renderFiles();
};

/* =========================================================
   ERREUR
========================================================= */

function showError(message) {

  errorBox.innerHTML =
    '<div class="error">❌ ' +
    escapeHtml(message) +
    "</div>";
}

/* =========================================================
   AFFICHAGE ANALYSE
========================================================= */

function showAnalysis(vehicle) {

  const fields = [

    ["Marque", vehicle.make],

    ["Modèle", vehicle.model],

    ["Version", vehicle.version],

    ["Année", vehicle.year],

    [
      "Kilométrage",
      vehicle.mileage_km != null
        ? Number(vehicle.mileage_km)
            .toLocaleString("fr-FR") +
          " km"
        : null
    ],

    [
      "Prix",
      vehicle.price_eur != null
        ? Number(vehicle.price_eur)
            .toLocaleString("fr-FR") +
          " €"
        : null
    ],

    ["Énergie", vehicle.energy],

    ["Boîte", vehicle.gearbox],

    [
      "Puissance",
      vehicle.power_hp != null
        ? vehicle.power_hp + " ch"
        : null
    ],

    [
      "Vendeur",
      vehicle.seller_type === "professional"
        ? "Professionnel"
        : vehicle.seller_type === "private"
          ? "Particulier"
          : null
    ],

    ["Lieu", vehicle.location]

  ];

  analysis.hidden = false;

  analysis.innerHTML =
    "<h2>Ce que l’IA a lu</h2>" +

    fields
      .filter(
        (field) =>
          field[1] != null &&
          field[1] !== ""
      )
      .map(
        (field) =>
          "<div><b>" +
          escapeHtml(field[0]) +
          "</b> : " +
          escapeHtml(field[1]) +
          "</div>"
      )
      .join("") +

    '<p class="score">' +
    "Confiance de lecture : " +
    escapeHtml(vehicle.confidence ?? 0) +
    "/100</p>" +

    (
      vehicle.uncertain_fields?.length
        ? '<div class="warn">⚠️ À préciser : ' +
          vehicle.uncertain_fields
            .map(escapeHtml)
            .join(", ") +
          "</div>"
        : ""
    ) +

    (
      vehicle.visible_claims?.length
        ? "<p><b>Affirmations visibles :</b><br>" +
          vehicle.visible_claims
            .map(
              (x) =>
                '<span class="tag">' +
                escapeHtml(x) +
                "</span>"
            )
            .join("") +
          "</p>"
        : ""
    ) +

    (
      vehicle.warnings?.length
        ? vehicle.warnings
            .map(
              (x) =>
                '<div class="warn">⚠️ ' +
                escapeHtml(x) +
                "</div>"
            )
            .join("")
        : ""
    );
}

/* =========================================================
   AFFICHAGE MARCHÉ
========================================================= */

function showMarket(marketData) {

  market.hidden = false;

  if (marketData.error) {

    market.innerHTML =
      "<h2>Est-ce que ça vaut le coup ?</h2>" +
      '<div class="warn">⚠️ ' +
      escapeHtml(marketData.error) +
      "</div>";

    return;
  }

  const comparables =
    marketData.comparables || [];

  market.innerHTML =

    "<h2>Est-ce que ça vaut le coup ?</h2>" +

    '<div class="status">' +

    "<b>" +
    escapeHtml(marketData.label) +
    "</b>" +

    "<p>" +
    "Confiance marché : <b>" +
    escapeHtml(marketData.confidence) +
    "/100</b>" +
    "</p>" +

    '<div class="muted">Prix demandé</div>' +

    '<div class="price">' +
    escapeHtml(marketData.asking_display) +
    "</div>" +

    "<p>" +

    "Marché estimé : <b>" +
    escapeHtml(marketData.median_display) +
    "</b><br>" +

    "Fourchette indicative : " +
    escapeHtml(marketData.low_display) +
    " – " +
    escapeHtml(marketData.high_display) +

    "</p>" +

    "<p>" +
    escapeHtml(marketData.gap_text) +
    "</p>" +

    (
      marketData.warning
        ? '<div class="warn">⚠️ ' +
          escapeHtml(marketData.warning) +
          "</div>"
        : ""
    ) +

    "<p>" +
    comparables.length +
    " véhicule(s) comparable(s) trouvé(s)." +
    "</p>" +

    "<h3>Comparables utilisés</h3>" +

    comparables
      .map(
        (c) =>
          '<div class="comp">' +

          "<b>" +
          escapeHtml(c.price_display) +
          "</b> · " +

          escapeHtml(c.year ?? "") +
          " · " +

          escapeHtml(c.mileage_display ?? "") +
          " · " +

          escapeHtml(c.energy ?? "") +

          "<br>" +

          escapeHtml(
            c.version ??
            c.finition ??
            ""
          ) +

          "<br>" +

          '<span class="muted">' +
          escapeHtml(c.source ?? "") +
          "</span>" +

          (
            c.url
              ? '<br><a class="link" target="_blank" rel="noopener" href="' +
                escapeHtml(c.url) +
                '">Voir l’annonce</a>'
              : ""
          ) +

          "</div>"
      )
      .join("") +

    "</div>";
}

/* =========================================================
   LANCEMENT ANALYSE
========================================================= */

go.onclick = async () => {

  if (!files.length) return;

  go.disabled = true;

  errorBox.innerHTML = "";

  analysis.hidden = true;

  market.hidden = false;

  market.innerHTML =
    "<h2>Est-ce que ça vaut le coup ?</h2>" +
    '<div class="status">Analyse des photos…</div>';

  try {

    /* -----------------------------------------------------
       IA
    ----------------------------------------------------- */

    const formData =
      new FormData();

    files.forEach(
      (file) =>
        formData.append("images", file)
    );

    const analysisResponse =
      await fetch(
        "/api/analyze",
        {
          method: "POST",
          body: formData
        }
      );

    const analysisJson =
      await analysisResponse.json();

    if (!analysisResponse.ok) {

      throw new Error(
        analysisJson.error ||
        "Erreur pendant l’analyse IA."
      );
    }

    showAnalysis(
      analysisJson.vehicle
    );

    /* -----------------------------------------------------
       MARCHÉ
    ----------------------------------------------------- */

    market.innerHTML =
      "<h2>Est-ce que ça vaut le coup ?</h2>" +
      '<div class="status">Recherche des comparables…</div>';

    const marketResponse =
      await fetch(
        "/api/market",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify(
            analysisJson.vehicle
          )
        }
      );

    const marketJson =
      await marketResponse.json();

    if (!marketResponse.ok) {

      throw new Error(
        marketJson.error ||
        "Erreur pendant la recherche marché."
      );
    }

    showMarket(marketJson);

  } catch (error) {

    console.error(error);

    showError(
      error.message ||
      "Erreur inattendue."
    );

    market.hidden = true;

  } finally {

    go.disabled = false;
  }
};

</script>

</body>
</html>`;

/* =========================================================
   ROUTES
========================================================= */

app.get("/", (_req, res) => {
  res.type("html").send(HTML);
});

app.get("/api/health", (_req, res) => {

  res.json({
    ok: true,
    vision: !!openai,
    market: !!process.env.CARHUNT_API_KEY,
    model: MODEL
  });

});

/* =========================================================
   ANALYSE IA
========================================================= */

app.post(
  "/api/analyze",
  upload.array("images", 3),
  async (req, res) => {

    try {

      if (!req.files?.length) {

        return res.status(400).json({
          error:
            "Ajoute au moins une photo."
        });
      }

      if (!openai) {

        return res.status(503).json({
          error:
            "OPENAI_API_KEY manquante."
        });
      }

      const images =
        req.files.map(
          (file) =>
            `data:${file.mimetype};base64,${file.buffer.toString("base64")}`
        );

      const prompt = `
Tu es le moteur de lecture de l'application
"Vaut le Coup ? — Avant d'acheter. Demande à l'IA."

Analyse de 1 à 3 photos d'une annonce automobile.

RÈGLES :

- Croise les informations de toutes les photos.
- Les photos peuvent montrer des éléments totalement différents.
- Ne force jamais un rôle à une photo.
- Utilise uniquement les informations réellement visibles.
- N'invente aucune information.
- Si une information est absente, illisible ou ambiguë : null.
- Ne déduis jamais une finition.
- Ne déduis jamais une puissance.
- Signale les contradictions entre les photos.
- Signale les défauts réellement visibles.
- Les mentions comme "1ère main", "garantie",
  "entretien constructeur", etc. sont des affirmations
  de l'annonce et ne sont PAS vérifiées.
- Ne prétends jamais avoir vérifié l'historique.
- Ne prétends jamais avoir vérifié le kilométrage.
- Ne prétends jamais avoir vérifié le marché.
- La confiance concerne uniquement la qualité de lecture.

Retourne UNIQUEMENT cet objet JSON :

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
`;

      const content = [
        {
          type: "input_text",
          text: prompt
        },

        ...images.map(
          (image_url) => ({
            type: "input_image",
            image_url,
            detail: "high"
          })
        )
      ];

      const response =
        await openai.responses.create({
          model: MODEL,

          input: [
            {
              role: "user",
              content
            }
          ]
        });

      const vehicle =
        cleanJson(
          response.output_text
        );

      res.json({
        ok: true,
        vehicle
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          error.message ||
          "Erreur pendant l'analyse."
      });
    }
  }
);

/* =========================================================
   CARHUNT
========================================================= */

app.post(
  "/api/market",
  async (req, res) => {

    try {

      const key =
        process.env.CARHUNT_API_KEY;

      if (!key) {

        return res.status(503).json({
          error:
            "CARHUNT_API_KEY manquante."
        });
      }

      const vehicle =
        req.body || {};

      const make =
        String(
          vehicle.make || ""
        )
          .toUpperCase()
          .trim();

      const model =
        cleanModel(
          vehicle.model
        );

      const targetYear =
        numberOrNull(
          vehicle.year
        );

      const targetMileage =
        numberOrNull(
          vehicle.mileage_km
        );

      const asking =
        numberOrNull(
          vehicle.price_eur
        );

      if (!make || !model) {

        return res.status(400).json({
          error:
            "Marque et modèle nécessaires."
        });
      }

      /* -----------------------------------------------------
         RECHERCHE CARHUNT
      ----------------------------------------------------- */

      async function searchCarHunt(
        withYear
      ) {

        const params =
          new URLSearchParams({
            make,
            model,
            page_size: "50"
          });

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

        const response =
          await fetch(
            url,
            {
              headers: {
                Authorization:
                  "Bearer " + key
              }
            }
          );

        if (!response.ok) {

          const text =
            await response.text();

          throw new Error(
            "CarHunt HTTP " +
            response.status +
            ": " +
            text
          );
        }

        const data =
          await response.json();

        return Array.isArray(
          data.listings
        )
          ? data.listings
          : [];
      }

      /* -----------------------------------------------------
         FILTRAGE
      ----------------------------------------------------- */

      function filterListings(
        listings,
        yearTolerance,
        mileageTolerance
      ) {

        return listings.filter(
          (listing) => {

            const price =
              numberOrNull(
                listing.price
              );

            const year =
              numberOrNull(
                listing.year
              );

            const mileage =
              numberOrNull(
                listing.mileage
              );

            if (
              price === null ||
              price <= 0
            ) {
              return false;
            }

            if (
              targetYear !== null &&
              year !== null &&
              Math.abs(
                year - targetYear
              ) > yearTolerance
            ) {
              return false;
            }

            if (
              targetMileage !== null &&
              mileage !== null &&
              Math.abs(
                mileage -
                targetMileage
              ) > mileageTolerance
            ) {
              return false;
            }

            /* Exclusion de l'annonce analysée */

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
          }
        );
      }

      /* -----------------------------------------------------
         RECHERCHE PROGRESSIVE
      ----------------------------------------------------- */

      let raw =
        await searchCarHunt(true);

      let listings =
        filterListings(
          raw,
          1,
          30000
        );

      let searchLevel = 1;

      /* Niveau 2 */

      if (listings.length < 5) {

        listings =
          filterListings(
            raw,
            1,
            60000
          );

        searchLevel = 2;
      }

      /* Niveau 3 */

      if (listings.length < 5) {

        listings =
          filterListings(
            raw,
            1,
            Infinity
          );

        searchLevel = 3;
      }

      /* Niveau 4 */

      if (listings.length < 5) {

        const wideRaw =
          await searchCarHunt(false);

        const wide =
          filterListings(
            wideRaw,
            Infinity,
            60000
          );

        const combined = [
          ...listings,
          ...wide
        ];

        const seen =
          new Set();

        listings =
          combined.filter(
            (listing) => {

              const id =
                listing.id ||
                [
                  listing.make,
                  listing.model,
                  listing.year,
                  listing.mileage,
                  listing.price,
                  listing.source_url
                ].join("|");

              if (seen.has(id)) {
                return false;
              }

              seen.add(id);

              return true;
            }
          );

        searchLevel = 4;
      }

      /* -----------------------------------------------------
         TRI PAR PROXIMITÉ
      ----------------------------------------------------- */

      listings.sort(
        (a, b) => {

          const yearA =
            numberOrNull(a.year);

          const yearB =
            numberOrNull(b.year);

          const mileageA =
            numberOrNull(a.mileage);

          const mileageB =
            numberOrNull(b.mileage);

          const yearDistanceA =
            targetYear !== null &&
            yearA !== null
              ? Math.abs(
                  yearA -
                  targetYear
                )
              : 0;

          const yearDistanceB =
            targetYear !== null &&
            yearB !== null
              ? Math.abs(
                  yearB -
                  targetYear
                )
              : 0;

          const mileageDistanceA =
            targetMileage !== null &&
            mileageA !== null
              ? Math.abs(
                  mileageA -
                  targetMileage
                )
              : 0;

          const mileageDistanceB =
            targetMileage !== null &&
            mileageB !== null
              ? Math.abs(
                  mileageB -
                  targetMileage
                )
              : 0;

          return (
            yearDistanceA * 100000 +
            mileageDistanceA -
            (
              yearDistanceB * 100000 +
              mileageDistanceB
            )
          );
        }
      );

      /* -----------------------------------------------------
         PRIX
      ----------------------------------------------------- */

      const prices =
        listings
          .map(
            (x) =>
              numberOrNull(
                x.price
              )
          )
          .filter(
            (x) => x !== null
          )
          .sort(
            (a, b) =>
              a - b
          );

      if (prices.length < 3) {

        return res.json({

          asking_display:
            formatEuro(asking),

          median_display:
            "Non déterminé",

          low_display:
            "Non déterminé",

          high_display:
            "Non déterminé",

          confidence: 20,

          label:
            "Marché peu documenté : estimation impossible.",

          gap_text:
            "Pas assez de comparables fiables.",

          warning:
            "Pas assez de comparables pour estimer correctement le marché.",

          comparables:
            listings
              .slice(0, 10)
              .map(formatComparable)

        });
      }

      /* -----------------------------------------------------
         QUANTILES
      ----------------------------------------------------- */

      const quantile =
        (percentile) => {

          const index =
            (prices.length - 1) *
            percentile;

          const lower =
            Math.floor(index);

          const upper =
            Math.ceil(index);

          if (
            lower === upper
          ) {
            return prices[lower];
          }

          return (
            prices[lower] +
            (
              prices[upper] -
              prices[lower]
            ) *
            (
              index -
              lower
            )
          );
        };

      const median =
        quantile(0.5);

      const low =
        quantile(0.15);

      const high =
        quantile(0.85);

      /* -----------------------------------------------------
         ÉCART DE PRIX
      ----------------------------------------------------- */

      const gap =
        asking !== null &&
        median
          ? (
              (
                asking -
                median
              ) /
              median
            ) * 100
          : null;

      let label;

      if (gap === null) {

        label =
          "Estimation indicative.";

      } else if (gap <= -10) {

        label =
          "Très intéressant";

      } else if (gap <= -3) {

        label =
          "Plutôt intéressant";

      } else if (gap <= 3) {

        label =
          "Dans le marché";

      } else if (gap <= 10) {

        label =
          "Plutôt cher";

      } else {

        label =
          "Cher";
      }

      const gapText =
        gap === null

          ? "Prix demandé non déterminé."

          : `Le prix demandé est ${
              Math.abs(
                Math.round(gap)
              )
            }% ${
              gap >= 0
                ? "au-dessus"
                : "en dessous"
            } du prix médian.`;

      /* -----------------------------------------------------
         CONFIANCE MARCHÉ
      ----------------------------------------------------- */

      const confidence =
        Math.min(
          95,

          Math.round(
            25 +
            Math.min(
              prices.length,
              20
            ) * 3 +

            (
              searchLevel === 1
                ? 15
                : searchLevel === 2
                  ? 8
                  : searchLevel === 3
                    ? 3
                    : 0
            )
          )
        );

      let warning = null;

      if (prices.length < 5) {

        warning =
          "Pas assez de comparables pour attribuer un score fiable.";

      } else if (
        searchLevel >= 3
      ) {

        warning =
          "Comparaison élargie : interpréter la fourchette avec prudence.";
      }

      return res.json({

        asking_display:
          formatEuro(asking),

        median_display:
          formatEuro(median),

        low_display:
          formatEuro(low),

        high_display:
          formatEuro(high),

        confidence,

        label,

        gap_text:
          gapText,

        warning,

        comparables:
          listings
            .slice(0, 10)
            .map(formatComparable)

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          error.message ||
          "Erreur pendant la recherche marché."
      });
    }
  }
);

/* =========================================================
   COMPARABLE
========================================================= */

function formatComparable(
  listing
) {

  const price =
    numberOrNull(
      listing.price
    );

  const mileage =
    numberOrNull(
      listing.mileage
    );

  return {

    price_display:
      formatEuro(price),

    year:
      listing.year ?? null,

    mileage_display:
      mileage !== null
        ? formatKm(mileage)
        : null,

    energy:
      listing.energy ?? null,

    version:
      listing.version ||
      listing.finition ||
      null,

    source:
      listing.source ??
      null,

    url:
      listing.source_url ||
      null
  };
}

/* =========================================================
   DÉMARRAGE
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Vaut le Coup ? écoute sur ${PORT}`
    );
  }
);
