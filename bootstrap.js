// Bootstrap de compatibilité pour les API externes.
// On normalise les valeurs constructeur envoyées à CarHunt avant de charger l'application.
const nativeFetch = globalThis.fetch.bind(globalThis);

function stripAccents(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

globalThis.fetch = async function patchedFetch(input, init) {
  let url;
  try { url = new URL(typeof input === 'string' ? input : input.url); }
  catch { return nativeFetch(input, init); }

  if (url.hostname === 'api-pro.carhunt.fr' && url.pathname === '/v1/listings/search') {
    const make = url.searchParams.get('make');
    if (make) url.searchParams.set('make', stripAccents(make).toUpperCase());
    const model = url.searchParams.get('model');
    if (model) url.searchParams.set('model', stripAccents(model).toUpperCase());
    return nativeFetch(url, init);
  }

  return nativeFetch(input, init);
};

await import('./app.js');
