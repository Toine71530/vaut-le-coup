import express from 'express';

// Complément non destructif : le risque connu du 1.2 PureTech doit influencer
// le prix final conseillé, sans remplacer le verdict marché existant.
const previousJson = express.response.json;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function textOf(vehicle) {
  return [
    vehicle?.make,
    vehicle?.model,
    vehicle?.version,
    vehicle?.trim,
    vehicle?.finish,
    vehicle?.title,
    ...(Array.isArray(vehicle?.visible_claims) ? vehicle.visible_claims : []),
    ...(Array.isArray(vehicle?.warnings) ? vehicle.warnings : []),
    ...(Array.isArray(vehicle?.vigilance) ? vehicle.vigilance : []),
    ...(Array.isArray(vehicle?.points_of_attention) ? vehicle.points_of_attention : [])
  ].map(x => String(x ?? '').toLowerCase()).join(' ');
}

function isPureTech12(vehicle) {
  const text = textOf(vehicle);
  return /peugeot/.test(text) && /\b1[.,]2\s*puretech\b/i.test(text);
}

function applyPureTechNegotiation(payload, vehicle) {
  if (!payload?.ok || !payload.negotiation?.available || !isPureTech12(vehicle)) return payload;

  const n = { ...payload.negotiation };
  const asking = num(n.asking ?? vehicle?.price_eur);
  if (asking == null || asking <= 0) return payload;

  // Réserve de négociation prudente, et non coût de réparation garanti :
  // elle reste applicable tant que la distribution / l'historique PureTech
  // n'est pas suffisamment justifié par des documents visibles ou fournis.
  const reserve = 500;
  const round50 = value => Math.round(value / 50) * 50;
  const baseTarget = num(n.target_price);
  const baseOpening = num(n.opening_offer);
  const baseCeiling = num(n.ceiling_price);
  if (baseTarget == null || baseOpening == null || baseCeiling == null) return payload;

  const target = Math.max(0, round50(baseTarget - reserve));
  const opening = Math.max(0, Math.min(target, round50(baseOpening - reserve)));
  const ceiling = Math.max(opening, round50(baseCeiling - reserve));

  const args = Array.isArray(n.arguments) ? [...n.arguments] : [];
  args.unshift('⚠️ 1.2 PureTech : appliquer une réserve de 500 € tant que la distribution et l’historique d’entretien ne sont pas justifiés par des documents vérifiables.');
  args.unshift(`Le risque PureTech doit être intégré au prix final : réserve de ${reserve.toLocaleString('fr-FR')} € avant validation des justificatifs.`);

  const phrase = `« Le véhicule m'intéresse. Le 1.2 PureTech me conduit à prévoir une réserve de ${reserve.toLocaleString('fr-FR')} € tant que la distribution et l'historique d'entretien ne sont pas justifiés. Si tout est conforme avec justificatifs, je peux aller jusqu'à ${ceiling.toLocaleString('fr-FR')} €. Pour conclure aujourd'hui, je vous propose ${opening.toLocaleString('fr-FR')} €. »`;

  return {
    ...payload,
    negotiation: {
      ...n,
      opening_offer: opening,
      target_price: target,
      ceiling_price: ceiling,
      potential_saving: Math.max(0, round50(asking - target)),
      puretech_reserve_eur: reserve,
      risk_discount_pct: Math.round(((asking - target) / asking) * 1000) / 10,
      arguments: args.slice(0, 8),
      suggested_phrase: phrase,
      rule: `${n.rule || ''} Risque PureTech : la réserve de ${reserve.toLocaleString('fr-FR')} € est un repère de négociation tant que les justificatifs ne lèvent pas le doute ; elle ne constitue pas un coût de réparation garanti.`.trim()
    }
  };
}

express.response.json = function pureTechPolicyJson(payload) {
  try {
    if (this.req?.path === '/api/market' && payload?.ok) {
      payload = applyPureTechNegotiation(payload, this.req.body || {});
    }
  } catch (error) {
    console.error('PureTech negotiation policy error', error?.message || error);
  }
  return previousJson.call(this, payload);
};
