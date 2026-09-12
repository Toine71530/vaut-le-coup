import express from 'express';
import './bootstrap.js';

const bootstrapJson = express.response.json;

express.response.json = function marketPolicyJson(payload) {
  try {
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
    console.error('Market sample policy error', error?.message || error);
  }
  return bootstrapJson.call(this, payload);
};
