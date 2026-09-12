import express from 'express';
import './bootstrap.js';

const bootstrapJson = express.response.json;

function cleanAnalysisPayload(payload) {
  if (!payload || !payload.ok) return payload;

  const vehicle = payload.vehicle || payload.analysis || payload;
  const make = String(vehicle?.make || '').toLowerCase();
  const model = String(vehicle?.model || '').toLowerCase();
  const version = String(vehicle?.version || vehicle?.trim || vehicle?.finish || '').toLowerCase();
  const energy = String(vehicle?.energy || '').toLowerCase();
  const power = Number(vehicle?.power_hp ?? vehicle?.power ?? 0);

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

express.response.json = function marketPolicyJson(payload) {
  try {
    if (this.req?.path === '/api/analyze') {
      payload = cleanAnalysisPayload(payload);
    }

    if (this.req?.path === '/api/market' && payload?.ok) {
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

      // 5–7 annonces : les chiffres restent utiles, mais le verdict doit rester
      // indicatif et ne doit pas déclencher une stratégie de négociation automatique.
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
    }
  } catch (error) {
    console.error('Market policy error', error?.message || error);
  }
  return bootstrapJson.call(this, payload);
};
