// Bootstrap de fiabilisation de Vaut le Coup ?
// - normalise les critères CarHunt et fournit des replis robustes
// - renforce l'extraction Gemini avec la date réelle et un schéma JSON
// - corrige les alertes temporelles manifestement fausses

const nativeFetch = globalThis.fetch.bind(globalThis);

function stripAccents(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function norm(value) {
  return stripAccents(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function cloneUrl(url) {
  return new URL(url.toString());
}

const VEHICLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    make: { type: ['string', 'null'] },
    model: { type: ['string', 'null'] },
    version: { type: ['string', 'null'] },
    year: { type: ['integer', 'null'] },
    mileage_km: { type: ['integer', 'null'] },
    price_eur: { type: ['number', 'null'] },
    energy: { type: ['string', 'null'] },
    gearbox: { type: ['string', 'null'] },
    power_hp: { type: ['integer', 'null'] },
    seller_type: { type: ['string', 'null'], enum: ['professional', 'private', null] },
    location: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    uncertain_fields: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    visible_claims: { type: 'array', items: { type: 'string' }, maxItems: 30 },
    warnings: { type: 'array', items: { type: 'string' }, maxItems: 20 }
  },
  required: ['make','model','version','year','mileage_km','price_eur','energy','gearbox','power_hp','seller_type','location','title','confidence','uncertain_fields','visible_claims','warnings']
};

function patchGeminiRequest(body) {
  if (!body || !Array.isArray(body.contents)) return body;
  const today = new Date().toISOString().slice(0, 10);
  const dateRule = `\nDATE DE REFERENCE: ${today}. Ne signale une contradiction temporelle que si une date visible est réellement postérieure à cette date. Une révision en juin 2026 est cohérente si la date de référence est en septembre 2026. Ne transforme jamais une date future par rapport à l'année du véhicule en anomalie : seule la date actuelle compte.`;
  const first = body.contents?.[0]?.parts?.[0];
  if (first && typeof first.text === 'string' && !first.text.includes('DATE DE REFERENCE:')) first.text += dateRule;
  body.generationConfig = {
    ...(body.generationConfig || {}),
    responseMimeType: 'application/json',
    responseSchema: VEHICLE_SCHEMA,
    temperature: 0,
    maxOutputTokens: Math.max(1800, Number(body.generationConfig?.maxOutputTokens || 0))
  };
  return body;
}

function cleanGeminiResponse(raw) {
  try {
    const data = JSON.parse(raw);
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text) return raw;
    const vehicle = JSON.parse(text);
    const warnings = Array.isArray(vehicle.warnings) ? vehicle.warnings : [];
    vehicle.warnings = warnings.filter(w => {
      const s = String(w).toLowerCase();
      return !(s.includes('année actuelle est antérieure') || s.includes('annee actuelle est anterieure'));
    });
    data.candidates[0].content.parts = [{ text: JSON.stringify(vehicle) }];
    return JSON.stringify(data);
  } catch {
    return raw;
  }
}

async function carHuntFetch(input, init) {
  const original = new URL(typeof input === 'string' ? input : input.url);
  const base = cloneUrl(original);
  const make = base.searchParams.get('make');
  const model = base.searchParams.get('model');
  if (make) base.searchParams.set('make', norm(make));
  if (model) base.searchParams.set('model', norm(model));

  const candidates = [base];
  if (base.pathname === '/v1/listings/search' && model) {
    const makeOnly = cloneUrl(base);
    makeOnly.searchParams.delete('model');
    candidates.push(makeOnly);
    const smallPage = cloneUrl(makeOnly);
    smallPage.searchParams.set('page_size', '50');
    candidates.push(smallPage);
  }

  let lastResponse;
  for (const candidate of candidates) {
    const response = await nativeFetch(candidate, init);
    lastResponse = response;
    if (response.ok || response.status !== 422) return response;
    const raw = await response.text();
    console.error('CarHunt HTTP 422', raw.slice(0, 800));
  }
  return lastResponse;
}

globalThis.fetch = async function patchedFetch(input, init) {
  let url;
  try { url = new URL(typeof input === 'string' ? input : input.url); }
  catch { return nativeFetch(input, init); }

  if (url.hostname === 'api-pro.carhunt.fr' && url.pathname === '/v1/listings/search') return carHuntFetch(input, init);

  if (url.hostname === 'generativelanguage.googleapis.com' && url.pathname.includes('/models/') && url.pathname.endsWith(':generateContent') && init?.body) {
    try {
      const body = patchGeminiRequest(JSON.parse(init.body));
      const response = await nativeFetch(input, { ...init, body: JSON.stringify(body) });
      if (!response.ok) return response;
      const raw = await response.text();
      return new Response(cleanGeminiResponse(raw), { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch {
      return nativeFetch(input, init);
    }
  }

  return nativeFetch(input, init);
};

await import('./app.js');
