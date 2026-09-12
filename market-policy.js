import express from 'express';
import './bootstrap.js';

const bootstrapJson = express.response.json;

express.response.json = function marketPolicyJson(payload) {
  try {
    if (this.req?.path === '/api/market' && payload?.ok) {
      const comparables = Number(payload.comparables || 0);
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
          negotiation: { available: false, reason: 'Pas assez d’annonces comparables pour établir un axe de négociation fiable.' }
        };
      }
    }
  } catch (error) {
    console.error('Market sample policy error', error?.message || error);
  }
  return bootstrapJson.call(this, payload);
};
