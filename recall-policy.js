import express from 'express';

// Couche non destructive : interroge la base officielle RappelConso pour les
// véhicules identifiés, puis expose uniquement les rappels pertinents.
const previousJson = express.response.json;
const previousSend = express.response.send;
const nativeFetch = globalThis.fetch.bind(globalThis);

function norm(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function tokens(value) {
  return norm(value).split(/\s+/).filter(x => x.length >= 2);
}
function relevantCategory(value) {
  const x = norm(value);
  return x.includes('automobile') || x.includes('moto') || x.includes('scooter') || x.includes('pneu') || x.includes('vehicule');
}
function compactText(value, max = 420) {
  const x = String(value ?? '').replace(/\s+/g, ' ').trim();
  return x.length > max ? x.slice(0, max - 1) + '…' : x;
}

async function fetchRecalls(vehicle) {
  const make = String(vehicle?.make || '').trim();
  const model = String(vehicle?.model || '').trim();
  if (!make || !model) return { available: false, source: 'RappelConso', recalls: [] };

  const q = encodeURIComponent(`${make} ${model}`);
  const url = `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/rappelconso-v2-gtin-espaces/records?limit=50&q=${q}`;
  try {
    const response = await nativeFetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const data = await response.json();
    const rows = Array.isArray(data?.results) ? data.results : [];
    const makeN = norm(make);
    const modelTokens = tokens(model);
    const year = Number(vehicle?.year);
    const versionText = norm(`${vehicle?.version || ''} ${vehicle?.title || ''}`);

    const recalls = rows
      .filter(row => relevantCategory(row?.categorie_produit))
      .map(row => {
        const text = norm(`${row?.marque_produit || ''} ${row?.modeles_ou_references || ''} ${row?.libelle || ''}`);
        const makeMatch = text.includes(makeN);
        const modelMatch = modelTokens.length ? modelTokens.some(t => text.includes(t)) : false;
        const versionMatch = versionText && tokens(versionText).some(t => t.length >= 3 && text.includes(t));
        let score = (makeMatch ? 50 : 0) + (modelMatch ? 40 : 0) + (versionMatch ? 10 : 0);
        if (!makeMatch || !modelMatch) score = 0;
        return { row, score };
      })
      .filter(x => x.score >= 90)
      .sort((a, b) => b.score - a.score || String(b.row.date_publication || '').localeCompare(String(a.row.date_publication || '')))
      .slice(0, 8)
      .map(({ row }) => ({
        id: row?.id ?? null,
        title: compactText(row?.libelle || row?.modeles_ou_references || `${make} ${model}`),
        make: row?.marque_produit || make,
        model: row?.modeles_ou_references || '',
        published_at: row?.date_publication || null,
        risk: compactText(row?.risques_encourus, 260),
        reason: compactText(row?.motif_rappel, 500),
        action: compactText(row?.conduites_a_tenir_par_le_consommateur, 300),
        procedure_end: row?.date_de_fin_de_la_procedure_de_rappel || null,
        sheet_url: row?.lien_vers_la_fiche_rappel || null,
        source: 'RappelConso'
      }));

    return { available: true, source: 'RappelConso', source_url: 'https://rappel.conso.gouv.fr/', vehicle: { make, model, year: Number.isFinite(year) ? year : null }, recalls };
  } catch (error) {
    console.error('RappelConso lookup error', error?.message || error);
    return { available: false, source: 'RappelConso', recalls: [], error: 'Base RappelConso momentanément inaccessible.' };
  }
}

express.response.json = function recallJson(payload) {
  if (this.req?.path === '/api/analyze' && payload?.ok) {
    const response = this;
    const vehicle = payload.vehicle || payload.analysis || payload;
    fetchRecalls(vehicle).then(recalls => previousJson.call(response, { ...payload, recalls }))
      .catch(() => previousJson.call(response, { ...payload, recalls: { available: false, source: 'RappelConso', recalls: [] } }));
    return response;
  }
  return previousJson.call(this, payload);
};

express.response.send = function recallSend(body) {
  if (typeof body === 'string' && body.includes('</body>') && body.includes('Vaut le Coup ?')) {
    const injection = `<section id="recalls" class="card" hidden></section><style>.recall-item{padding:12px 0;border-bottom:1px solid #e1e5e8}.recall-item:last-child{border-bottom:0}.recall-risk{display:inline-block;background:#ffe2e2;border-radius:999px;padding:4px 8px;font-size:12px;font-weight:800}.recall-meta{font-size:12px;color:#68737d;margin-top:5px}.recall-link{display:inline-block;margin-top:8px;color:#174c7a;font-weight:800;text-decoration:none}</style><script>(function(){var originalFetch=window.fetch.bind(window);window.fetch=async function(input,init){var r=await originalFetch(input,init);try{var url=typeof input==='string'?input:input.url;if(String(url).includes('/api/analyze')){var clone=r.clone();var data=await clone.json();var box=document.getElementById('recalls');var info=data&&data.recalls;if(box&&info&&info.available&&Array.isArray(info.recalls)&&info.recalls.length){box.hidden=false;box.innerHTML='<h2>🚨 Rappels officiels</h2><p class="muted">Correspondances trouvées dans RappelConso. Cela ne confirme pas que ce véhicule précis est concerné : vérifier le VIN et les conditions du rappel.</p>'+info.recalls.map(function(x){return '<div class="recall-item"><strong>'+escR(x.title)+'</strong>'+(x.risk?'<div class="recall-risk">'+escR(x.risk)+'</div>':'')+(x.reason?'<div>'+escR(x.reason)+'</div>':'')+(x.published_at?'<div class="recall-meta">Publié le '+escR(String(x.published_at).slice(0,10))+'</div>':'')+(x.sheet_url?'<a class="recall-link" href="'+escR(x.sheet_url)+'" target="_blank" rel="noopener">Voir la fiche officielle RappelConso →</a>':'')+'</div>';}).join('');}}}catch(e){}return r;};function escR(v){return String(v??'').replace(/[&<>\"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[c]);});}})();</script>`;
    body = body.replace('</body>', injection + '</body>');
  }
  return previousSend.call(this, body);
};
