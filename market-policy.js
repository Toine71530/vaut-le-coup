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

  if (make.includes('toyota') && model === 'prius' && Number(vehicle?.year) === 2023 &&
      (energy.includes('rechargeable') || version.includes('phev')) && power == null) {
    vehicle.power_hp = 223;
    if (Array.isArray(vehicle.visible_claims) && !vehicle.visible_claims.some(x => String(x).toLowerCase().includes('223 ch'))) {
      vehicle.visible_claims.push('Toyota Prius PHEV 2023 : puissance système 223 ch déduite de la motorisation/année identifiées.');
    }
  }

  if (make.includes('toyota') && model.includes('corolla') && energy.includes('hybrid') && version.includes('122h') && power == null) {
    vehicle.power_hp = 122;
    if (Array.isArray(vehicle.visible_claims) && !vehicle.visible_claims.some(x => String(x).toLowerCase().includes('122 ch'))) {
      vehicle.visible_claims.push('Toyota Corolla 122h : puissance système 122 ch identifiée par la version 122h.');
    }
  }

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
      if (Array.isArray(vehicle[key])) {
        vehicle[key] = vehicle[key].filter(item => {
          const text = typeof item === 'string' ? item : JSON.stringify(item);
          return !contradictionPatterns.some(re => re.test(text));
        });
      }
    }
  }

  // Un CT réalisé pendant une année donnée peut rester valable jusqu'à deux ans plus tard.
  // Ne supprimer que le faux conflit connu où Gemini oppose simplement "CT réalisé en AAAA"
  // à "fin de validité CT AAAA+2". Les autres contradictions restent affichées.
  const isFalseCtContradiction = item => {
    const text = typeof item === 'string' ? item : JSON.stringify(item);
    const normalized = text.toLowerCase();
    if (!/(contradiction|incoh[ée]rence|incompatible|conflit)/i.test(normalized) ||
        !/(contr[oô]le technique|\bct\b)/i.test(normalized) ||
        !/(validit|valable|expiration|expire)/i.test(normalized) ||
        !/(r[eé]alis|effectu|pass[eé])/i.test(normalized)) return false;
    const years = [...normalized.matchAll(/(?:20)\d{2}/g)].map(m => Number(m[0]));
    if (years.length < 2) return false;
    return Math.max(...years) - Math.min(...years) === 2;
  };

  for (const key of ['warnings', 'points_of_attention', 'vigilance']) {
    if (Array.isArray(payload[key])) payload[key] = payload[key].filter(item => !isFalseCtContradiction(item));
    if (Array.isArray(vehicle[key])) vehicle[key] = vehicle[key].filter(item => !isFalseCtContradiction(item));
  }
  if (isFalseCtContradiction(vehicle.warning)) vehicle.warning = null;
  if (isFalseCtContradiction(payload.warning)) payload.warning = null;

  // Vigilance spécifique aux anciennes générations 1.2 PureTech : ne pas diagnostiquer
  // une panne, mais inviter à vérifier entretien, courroie et éventuelles interventions.
  const vehicleText = [
    vehicle?.title,
    vehicle?.version,
    vehicle?.trim,
    vehicle?.finish,
    ...(Array.isArray(vehicle?.visible_claims) ? vehicle.visible_claims : [])
  ].map(x => String(x ?? '').toLowerCase()).join(' ');
  const isPureTech12 = make.includes('peugeot') && /\b1[.,]2\s*puretech\b/i.test(vehicleText);
  const hasPureTechWarning = ['warnings', 'points_of_attention', 'vigilance']
    .some(key => Array.isArray(vehicle[key]) && vehicle[key].some(item => /puretech|courroie|consommation d['’]huile/i.test(String(item))));

  if (isPureTech12 && !hasPureTechWarning) {
    const warning = '⚠️ Moteur 1.2 PureTech : vérifier l’historique d’entretien, la courroie de distribution et les éventuelles interventions liées à une consommation d’huile avant achat.';
    if (Array.isArray(vehicle.warnings)) vehicle.warnings.push(warning);
    else vehicle.warnings = [warning];
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
  return yearA != null && yearB != null && yearA === yearB && kmA != null && kmB != null &&
    Math.abs(kmA - kmB) <= 100 && priceA != null && priceB != null && Math.abs(priceA - priceB) < 1;
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
  const prices = filtered.map(x => num(x.price)).filter(x => x > 0);
  const med = median(prices);
  const asking = num(vehicle?.price_eur ?? payload.asking);
  if (!prices.length || med == null) {
    return { ...payload, comparables: Math.max(0, Number(payload.comparables || 0) - removed), median: null, low: null, high: null, score: null,
      label: 'Marché insuffisant', gap_pct: null, gap_eur: null,
      warning: 'Annonce cible exclue : échantillon distinct insuffisant pour produire un verdict fiable.', sample: filtered };
  }
  const gap = asking > 0 ? ((med - asking) / med) * 100 : null;
  const score = gap == null ? null : Math.max(0, Math.min(100, Math.round(50 + gap * 2.5)));
  const label = score == null ? 'Marché comparable' : score >= 80 ? '🔥 Très bonne affaire' : score >= 65 ? '👍 Prix très intéressant' : score >= 55 ? '🟢 Plutôt intéressant' : score >= 45 ? '🟡 Dans le marché' : score >= 35 ? '🟠 Plutôt cher' : '🔴 Cher';
  return { ...payload, comparables: Math.max(0, Number(payload.comparables || 0) - removed), median: Math.round(med),
    low: Math.round(percentile(prices, .15)), high: Math.round(percentile(prices, .85)), score, label,
    gap_pct: gap == null ? null : Math.round(gap * 10) / 10, gap_eur: gap == null ? null : Math.round(med - asking),
    warning: prices.length < 8 ? `Échantillon limité (${prices.length} comparables distincts) : les repères de prix sont indicatifs.` : payload.warning,
    sample: filtered };
}

function allVehicleText(vehicle) {
  const arrays = ['visible_claims', 'warnings', 'uncertain_fields'];
  return [vehicle?.title, vehicle?.version, vehicle?.energy, ...arrays.flatMap(k => Array.isArray(vehicle?.[k]) ? vehicle[k] : [])]
    .map(x => String(x ?? '').toLowerCase()).join(' ');
}

function hasPlaceContradiction(vehicle) {
  const text = allVehicleText(vehicle);
  const hasTwo = /\b2\s*places?\b/.test(text);
  const hasFive = /\b5\s*places?\b/.test(text);
  return hasTwo && hasFive;
}

function isVaspTwoSeat(vehicle) {
  const places = num(vehicle?.places ?? vehicle?.seats ?? vehicle?.number_of_seats);
  const text = allVehicleText(vehicle);
  return /\bvasp\b/.test(text) && /\butilitaire\b/.test(text) && /\b2\s*places?\b/.test(text) ||
    places === 2 && /\b(?:vasp|utilitaire)\b/.test(text);
}

function blockMarket(payload, reason, label = 'Marché non fiable') {
  return { ...payload, median: null, low: null, high: null, score: null, label, gap_pct: null, gap_eur: null,
    warning: reason, market_safety: { level: 'unknown', suspicious: false },
    negotiation: { available: false, reason: 'Pas de négociation chiffrée tant que la configuration du véhicule n’est pas suffisamment fiable.' } };
}

express.response.json = function marketPolicyJson(payload) {
  try {
    if (this.req?.path === '/api/analyze') payload = cleanAnalysisPayload(payload);

    if (this.req?.path === '/api/market' && payload?.ok) {
      const vehicle = this.req.body || {};
      payload = applyTargetExclusion(payload, vehicle);
      const comparables = Number(payload.comparables || 0);

      // Une contradiction de configuration invalide toute comparaison : il faut
      // d'abord vérifier la carte grise et la configuration réelle.
      if (hasPlaceContradiction(vehicle)) {
        payload = blockMarket(payload,
          'Comparaison bloquée : l’annonce contient une contradiction sur le nombre de places (2 et 5). Vérifier la carte grise et la configuration réelle avant toute comparaison de prix.');
      // Un VASP/utilitaire 2 places ne doit jamais être comparé à une Corolla
      // particulière/familiale 5 places. CarHunt ne fournit pas ici un filtre
      // suffisamment fiable sur la carrosserie VASP et le nombre de places.
      } else if (isVaspTwoSeat(vehicle)) {
        payload = blockMarket(payload,
          'Comparaison bloquée : véhicule VASP/utilitaire 2 places. Les annonces 5 places ne sont pas des comparables fiables. Aucun verdict de prix n’est donné sans échantillon VASP 2 places réellement comparable.',
          'Marché 2 places non comparable');
      } else if (comparables < 5) {
        payload = blockMarket(payload,
          'Échantillon trop limité : aucun verdict de prix fiable ne doit être donné.', 'Marché insuffisant');
      }

      const finalComparables = Number(payload.comparables || 0);
      if (finalComparables >= 5 && finalComparables < 8 && payload.label !== 'Marché 2 places non comparable' && payload.label !== 'Marché non fiable') {
        const originalScore = Number(payload.score);
        payload = { ...payload, score: Number.isFinite(originalScore) ? Math.min(originalScore, 65) : originalScore,
          label: '🟡 Marché indicatif — échantillon limité',
          warning: `Échantillon limité (${finalComparables} comparables) : les repères de prix sont indicatifs. Un verdict ferme nécessite au moins 8 comparables réellement pertinents.`,
          market_safety: { ...(payload.market_safety || {}), level: 'indicative', suspicious: false },
          negotiation: { available: false, reason: 'Échantillon encore trop limité pour fixer une offre cible fiable. Utiliser la médiane comme simple repère et vérifier le véhicule.' } };
      }

      if (Number(payload.comparables || 0) < 8) {
        payload.negotiation = { available: false, reason: 'Axe de négociation masqué : moins de 8 annonces comparables distinctes après exclusion de l’annonce cible.' };
      }
    }
  } catch (error) {
    console.error('Market policy error', error?.message || error);
  }
  return bootstrapJson.call(this, payload);
};
