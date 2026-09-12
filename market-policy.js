import express from 'express';
import './bootstrap.js';

const bootstrapJson = express.response.json;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function cleanAnalysisPayload(payload) {
  if (!payload || !payload.ok) return payload;

  const vehicle = payload.vehicle || payload.analysis || payload;
  const make = String(vehicle?.make || '').toLowerCase();
  const model = String(vehicle?.model || '').toLowerCase();
  const version = String(vehicle?.version || vehicle?.trim || vehicle?.finish || '').toLowerCase();
  const energy = String(vehicle?.energy || '').toLowerCase();
  const power = num(vehicle?.power_hp ?? vehicle?.power);

  // Certaines fiches n'affichent pas explicitement la puissance dans la capture,
  // mais la combinaison modèle + année + motorisation permet une identification
  // déterministe de la puissance système. On ne l'applique qu'à des cas précis.
  if (make.includes('toyota') && model === 'prius' &&
      Number(vehicle?.year) === 2023 &&
      (energy.includes('rechargeable') || version.includes('phev')) &&
      power == null) {
    vehicle.power_hp = 223;
    if (Array.isArray(vehicle.visible_claims) && !vehicle.visible_claims.some(x => String(x).toLowerCase().includes('223 ch'))) {
      vehicle.visible_claims.push('Toyota Prius PHEV 2023 : puissance système 223 ch déduite de la motorisation/année identifiées.');
    }
  }

  // Même logique pour la Corolla 122h : 122 ch est la puissance système,
  // sans confondre avec les 98 ch DIN du moteur thermique.
  if (make.includes('toyota') && model.includes('corolla') &&
      energy.includes('hybrid') && version.includes('122h') && power == null) {
    vehicle.power_hp = 122;
    if (Array.isArray(vehicle.visible_claims) && !vehicle.visible_claims.some(x => String(x).toLowerCase().includes('122 ch'))) {
      vehicle.visible_claims.push('Toyota Corolla 122h : puissance système 122 ch identifiée par la version 122h.');
    }
  }

  // Toyota Corolla 1.8 Hybrid 122h : 122 ch correspond à la puissance système,
  // tandis que 98 ch DIN correspond à la puissance du moteur thermique.
  // Ce n'est donc pas une contradiction à signaler.
  const isCorolla122h = make.includes('toyota') && model.includes('corolla') &&
    energy.includes('hybrid') && (version.includes('122h') || power === 122);

  if (isCorolla122h) {
    const contradictionPatterns = [
      /puissance\s+din.*98\s*ch.*contradictoire.*122h/i,
      /98\s*ch.*contradictoire.*122h/i,
      /122h.*contradictoire.*98\s*ch/i,
      /98\s*ch.*122h.*contradiction/i,
      /122h.*98\s*ch.*contradiction/i
    ];

    for (const key of ['warnings', 'points_of_attention', 'vigilance']) {
      if (Array.isArray(payload[key])) {
        payload[key] = payload[key].filter(item => {
          const text = typeof item === 'string' ? item : JSON.stringify(item);
          return !contradictionPatterns.some(re => re.test(text));
        });
      }
    }
  }

  return payload;
}

function sameVehicle(comp, vehicle) {
  if (!comp || !vehicle) return false;
  const norm = value => String(value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const makeA = norm(comp.make || comp.brand);
  const makeB = norm(vehicle.make);
  const modelA = norm(comp.model);
  const modelB = norm(vehicle.model);
  if (!makeA || !makeB || !makeA.includes(makeB) && !makeB.includes(makeA)) return false;
  if (!modelA || !modelB || !modelA.includes(modelB) && !modelB.includes(modelA)) return false;

  const yearA = num(comp.year);
  const yearB = num(vehicle.year);
  const kmA = num(comp.mileage ?? comp.mileage_km);
  const kmB = num(vehicle.mileage_km);
  const priceA = num(comp.price ?? comp.price_eur);
  const priceB = num(vehicle.price_eur);

  return yearA != null && yearB != null && yearA === yearB &&
    kmA != null && kmB != null && Math.abs(kmA - kmB) <= 100 &&
    priceA != null && priceB != null && Math.abs(priceA - priceB) < 1;
}

function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
}

function percentile(values, p) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.max(0, Math.min(a.length - 1, Math.round((a.length - 1) * p)))];
}

function applyTargetExclusion(payload, vehicle) {
  if (!Array.isArray(payload?.sample) || !payload.sample.length) return payload;

  const filtered = payload.sample.filter(comp => !sameVehicle(comp, vehicle));
  const removed = payload.sample.length - filtered.length;
  if (!removed) return payload;

  // Le serveur CarHunt ne nous expose ici qu'un échantillon. Si la cible est
  // présente dans cet échantillon, on recalcule les indicateurs sur les annonces
  // réellement distinctes plutôt que de laisser la cible gonfler le résultat.
  const prices = filtered.map(x => num(x.price)).filter(x => x > 0);
  const med = median(prices);
  const asking = num(vehicle?.price_eur ?? payload.asking);

  if (!prices.length || med == null) {
    return {
      ...payload,
      comparables: Math.max(0, Number(payload.comparables || 0) - removed),
      median: null,
      low: null,
      high: null,
      score: null,
      label: 'Marché insuffisant',
      gap_pct: null,
      gap_eur: null,
      warning: 'Annonce cible exclue : échantillon distinct insuffisant pour produire un verdict fiable.',
      sample: filtered
    };
  }

  const gap = asking > 0 ? ((med - asking) / med) * 100 : null;
  const score = gap == null ? null : Math.max(0, Math.min(100, Math.round(50 + gap * 2.5)));
  const label = score == null ? 'Marché comparable' : score >= 80 ? '🔥 Très bonne affaire' : score >= 65 ? '👍 Prix très intéressant' : score >= 55 ? '🟢 Plutôt intéressant' : score >= 45 ? '🟡 Dans le marché' : score >= 35 ? '🟠 Plutôt cher' : '🔴 Cher';

  return {
    ...payload,
    comparables: Math.max(0, Number(payload.comparables || 0) - removed),
    median: Math.round(med),
    low: Math.round(percentile(prices, .15)),
    high: Math.round(percentile(prices, .85)),
    score,
    label,
    gap_pct: gap == null ? null : Math.round(gap * 10) / 10,
    gap_eur: gap == null ? null : Math.round(med - asking),
    warning: prices.length < 8 ? `Échantillon limité (${prices.length} comparables distincts) : les repères de prix sont indicatifs.` : payload.warning,
    sample: filtered
  };
}

express.response.json = function marketPolicyJson(payload) {
  try {
    if (this.req?.path === '/api/analyze') {
      payload = cleanAnalysisPayload(payload);
    }

    if (this.req?.path === '/api/market' && payload?.ok) {
      const vehicle = this.req.body || {};
      payload = applyTargetExclusion(payload, vehicle);
      const comparables = Number(payload.comparables || 0);

      // 0–4 annonces : impossible de produire un verdict de prix sérieux.
      if (Number.isFinite(comparables) && comparables < 5) {
        payload = {
          ...payload,
          median: null,
          low: null,
          high: null,
          score: null,
          label: 'Marché insuffisant',
          gap_pct: null,
          gap_eur: null,
          warning: 'Échantillon trop limité : aucun verdict de prix fiable ne doit être donné.',
          market_safety: { level: 'unknown', suspicious: false },
          negotiation: {
            available: false,
            reason: 'Pas assez d’annonces comparables pour établir un axe de négociation fiable.'
          }
        };
      }

      // 5–7 annonces : chiffres utiles comme repères, mais aucun axe de
      // négociation chiffré. Cette règle est appliquée ici en dernier recours
      // afin qu'aucune couche antérieure ne puisse réactiver la négociation.
      if (Number.isFinite(comparables) && comparables >= 5 && comparables < 8) {
        const originalScore = Number(payload.score);
        payload = {
          ...payload,
          score: Number.isFinite(originalScore) ? Math.min(originalScore, 65) : originalScore,
          label: '🟡 Marché indicatif — échantillon limité',
          warning: `Échantillon limité (${comparables} comparables) : les repères de prix sont indicatifs. Un verdict ferme nécessite au moins 8 comparables réellement pertinents.`,
          market_safety: {
            ...(payload.market_safety || {}),
            level: 'indicative',
            suspicious: false
          },
          negotiation: {
            available: false,
            reason: 'Échantillon encore trop limité pour fixer une offre cible fiable. Utiliser la médiane comme simple repère et vérifier le véhicule.'
          }
        };
      }

      // Sécurité supplémentaire : aucun axe de négociation si l'échantillon
      // final reste inférieur à 8 annonces distinctes.
      if (Number(payload.comparables || 0) < 8) {
        payload.negotiation = {
          available: false,
          reason: 'Axe de négociation masqué : moins de 8 annonces comparables distinctes après exclusion de l’annonce cible.'
        };
      }
    }
  } catch (error) {
    console.error('Market policy error', error?.message || error);
  }
  return bootstrapJson.call(this, payload);
};
