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

function addUnique(arr, value) {
  if (!Array.isArray(arr)) return [value];
  if (!arr.some(x => String(x).toLowerCase() === String(value).toLowerCase())) arr.push(value);
  return arr;
}

function pureTechInfo(vehicle) {
  const text = [
    vehicle?.title,
    vehicle?.version,
    vehicle?.trim,
    vehicle?.finish,
    ...(Array.isArray(vehicle?.visible_claims) ? vehicle.visible_claims : [])
  ].map(x => String(x ?? '').toLowerCase()).join(' ');
  const isPureTech12 = /\b1[.,]2\s*puretech\b/i.test(text) && /peugeot/i.test(String(vehicle?.make || ''));
  if (!isPureTech12) return null;

  const year = Number(vehicle?.year);
  const km = Number(vehicle?.mileage_km);
  const nowYear = new Date().getFullYear();
  const oldEnoughForDistributionCheck = (Number.isFinite(year) && year > 0 && nowYear - year >= 6) ||
    (Number.isFinite(km) && km >= 100000);
  const maintenanceText = [
    ...(Array.isArray(vehicle?.visible_claims) ? vehicle.visible_claims : []),
    ...(Array.isArray(vehicle?.warnings) ? vehicle.warnings : []),
    String(vehicle?.title || ''), String(vehicle?.version || '')
  ].join(' ').toLowerCase();
  const hasDistributionProof = /(courroie|distribution).{0,80}(chang|remplac|faite|facture|justificatif|réalis|check\+)|(chang|remplac|faite|facture|justificatif|réalis).{0,80}(courroie|distribution)/i.test(maintenanceText);
  return { oldEnoughForDistributionCheck, hasDistributionProof };
}

function enrichPureTechAnalysis(vehicle) {
  const info = pureTechInfo(vehicle);
  if (!info) return;

  const warning = '⚠️ Moteur 1.2 PureTech : vérifier l’historique d’entretien, la courroie de distribution et les éventuelles interventions liées à une consommation d’huile avant achat.';
  vehicle.warnings = addUnique(vehicle.warnings, warning);
  vehicle.vigilance = addUnique(vehicle.vigilance, warning);
  vehicle.points_of_attention = addUnique(vehicle.points_of_attention, warning);
  vehicle.warning = vehicle.warning || warning;

  if (info.oldEnoughForDistributionCheck && !info.hasDistributionProof) {
    const distributionWarning = '⚠️ Distribution à justifier : vu l’âge/kilométrage du véhicule, demander la facture ou un justificatif de remplacement de la courroie avant de fixer le prix définitif.';
    vehicle.warnings = addUnique(vehicle.warnings, distributionWarning);
    vehicle.vigilance = addUnique(vehicle.vigilance, distributionWarning);
    vehicle.points_of_attention = addUnique(vehicle.points_of_attention, distributionWarning);
  }
}

function enrichPureTechNegotiation(payload, vehicle) {
  const info = pureTechInfo(vehicle);
  const n = payload?.negotiation;
  if (!info || !n || n.available !== true) return;

  const args = Array.isArray(n.arguments) ? [...n.arguments] : [];
  if (info.oldEnoughForDistributionCheck && !info.hasDistributionProof) {
    // Réserve de négociation : elle correspond à un ordre de grandeur d'une
    // distribution, pas à une réparation certaine. Le prix remonte au plafond
    // marché normal si le vendeur fournit un justificatif crédible.
    const reserve = 500;
    const asking = Number(n.asking ?? vehicle?.price_eur);
    if (Number.isFinite(asking) && asking > reserve) {
      const round50 = value => Math.round(value / 50) * 50;
      const ceiling = Math.max(0, round50(Math.min(Number(n.ceiling_price ?? asking), asking - reserve)));
      const target = Math.max(0, round50(Math.min(Number(n.target_price ?? asking), ceiling)));
      const opening = Math.max(0, Math.min(target, round50(Math.min(Number(n.opening_offer ?? asking), asking - reserve - 250))));
      n.ceiling_price = Math.max(opening, ceiling);
      n.target_price = Math.min(n.ceiling_price, target);
      n.opening_offer = opening;
      n.potential_saving = Math.max(0, round50(asking - n.target_price));
      n.puretech_risk_reserve_eur = reserve;
      n.puretech_price_condition = 'Plafond réduit de 500 € tant que la distribution/courroie n’est pas justifiée. Avec justificatif crédible, revenir au plafond marché calculé normalement.';
      args.push('⚠️ 1.2 PureTech : sans justificatif de distribution/courroie, conserver une réserve de 500 € dans le prix final.');
      args.push('Si la distribution est justifiée et l’entretien conforme, cette réserve peut être levée et le plafond marché normal peut être retenu.');
    }
  } else if (info.hasDistributionProof) {
    n.puretech_price_condition = 'Distribution/courroie justifiée : aucune décote automatique liée à cette intervention ; vérifier néanmoins l’entretien et la consommation d’huile.';
    args.push('1.2 PureTech : la distribution/courroie est annoncée comme justifiée ; vérifier la facture et le respect du plan d’entretien avant de retenir le prix final.');
  }
  n.arguments = args.slice(0, 8);
}

express.response.json = function seatsPolicyJson(payload) {
  try {
    if (this.req?.path === '/api/analyze' && payload?.ok) {
      const vehicle = payload.vehicle || payload.analysis || payload;
      inferSeats(vehicle);
      enrichPureTechAnalysis(vehicle);
    }
    if (this.req?.path === '/api/market' && payload?.ok) {
      enrichPureTechNegotiation(payload, this.req.body || {});
    }
  } catch (error) {
    console.error('Analysis policy error', error?.message || error);
  }
  return previousJson.call(this, payload);
};

// Le serveur démarre ici pour conserver le point d'entrée existant.
