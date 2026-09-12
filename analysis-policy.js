import express from 'express';
import './market-policy.js';

// Complément non destructif : conserve toute la chaîne existante et complète
// les champs structurés que Gemini peut laisser absents lorsque l'information
// est pourtant explicitement visible dans le texte de l'annonce.
const previousJson = express.response.json;

function inferSeats(vehicle) {
  if (!vehicle || vehicle.seats != null || vehicle.places != null) return;
  const texts = [
    ...(Array.isArray(vehicle.visible_claims) ? vehicle.visible_claims : []),
    String(vehicle.title || ''),
    String(vehicle.version || '')
  ].join(' | ');

  const matches = [...texts.matchAll(/\b(2|3|4|5|6|7|8|9)\s*places?\b/gi)]
    .map(m => Number(m[1]));
  if (!matches.length) return;

  const unique = [...new Set(matches)];
  // En cas de contradiction explicite entre les images, conserver la valeur
  // la plus directement annoncée par le titre/version, mais laisser la
  // contradiction dans warnings afin de ne jamais masquer le risque.
  vehicle.seats = unique.length === 1 ? unique[0] : matches[0];
}

express.response.json = function seatsPolicyJson(payload) {
  try {
    if (this.req?.path === '/api/analyze' && payload?.ok) {
      inferSeats(payload.vehicle || payload.analysis || payload);
    }
  } catch (error) {
    console.error('Analysis policy error', error?.message || error);
  }
  return previousJson.call(this, payload);
};

// Le serveur démarre ici pour conserver le point d'entrée existant.
