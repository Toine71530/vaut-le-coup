import express from 'express';

// Complément non destructif : le risque connu du 1.2 PureTech doit influencer
// le prix final conseillé, sans remplacer le verdict marché existant.
const previousSend = express.response.send;

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

function applyPureTechNegotiation(data, vehicle) {
  if (!data?.ok || !data.negotiation?.available || !isPureTech12(vehicle)) return data;

  const n = { ...data.negotiation };
  const asking = num(n.asking ?? vehicle?.price_eur);
  if (asking == null || asking <= 0) return data;

  // Réserve de négociation prudente : ce n'est pas un coût de réparation
  // garanti. Elle reste applicable tant que la distribution/courroie et
  // l'historique d'entretien ne sont pas suffisamment justifiés.
  const reserve = 500;
  const round50 = value => Math.round(value / 50) * 50;
  const baseTarget = num(n.target_price);
  const baseOpening = num(n.opening_offer);
  const baseCeiling = num(n.ceiling_price);
  if (baseTarget == null || baseOpening == null || baseCeiling == null) return data;

  const target = Math.max(0, round50(baseTarget - reserve));
  const opening = Math.max(0, Math.min(target, round50(baseOpening - reserve)));
  const ceiling = Math.max(opening, round50(baseCeiling - reserve));

  const args = Array.isArray(n.arguments) ? [...n.arguments] : [];
  args.unshift(`Le risque PureTech doit être intégré au prix final : réserve de ${reserve.toLocaleString('fr-FR')} € tant que les justificatifs ne sont pas validés.`);
  args.unshift(`⚠️ 1.2 PureTech : sans justificatif crédible de distribution/courroie, conserver une réserve de ${reserve.toLocaleString('fr-FR')} € dans le prix final.`);

  const phrase = `« Le véhicule m'intéresse. Le 1.2 PureTech me conduit à prévoir une réserve de ${reserve.toLocaleString('fr-FR')} € tant que la distribution et l'historique d'entretien ne sont pas justifiés. Si tout est conforme avec justificatifs, je peux aller jusqu'à ${ceiling.toLocaleString('fr-FR')} €. Pour conclure aujourd'hui, je vous propose ${opening.toLocaleString('fr-FR')} €. »`;

  data.negotiation = {
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
  };
  return data;
}

express.response.send = function pureTechSend(body) {
  try {
    if (this.req?.path === '/api/market' && typeof body === 'string') {
      const data = JSON.parse(body);
      const vehicle = this.req.body || {};
      applyPureTechNegotiation(data, vehicle);
      body = JSON.stringify(data);
    }
  } catch (error) {
    // Une réponse non JSON (ou une erreur d'analyse) continue son chemin normal.
  }
  return previousSend.call(this, body);
};
