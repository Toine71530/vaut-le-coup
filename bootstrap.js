// Couche de fiabilisation de Vaut le Coup ?
import express from 'express';

const nativeFetch = globalThis.fetch.bind(globalThis);
const originalJson = express.response.json;
const originalSend = express.response.send;

function stripAccents(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function norm(value) {
  return stripAccents(value).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

globalThis.fetch = async function patchedFetch(input, init) {
  let url;
  try { url = new URL(typeof input === 'string' ? input : input.url); }
  catch { return nativeFetch(input, init); }

  if (url.hostname === 'api-pro.carhunt.fr' && url.pathname === '/v1/listings/search') {
    const make = url.searchParams.get('make');
    const model = url.searchParams.get('model');
    if (make) url.searchParams.set('make', norm(make));
    if (model) url.searchParams.set('model', norm(model));
    const pageSize = Number(url.searchParams.get('page_size'));
    if (!Number.isFinite(pageSize) || pageSize > 50) url.searchParams.set('page_size', '50');
    if (!url.searchParams.has('page')) url.searchParams.set('page', '1');

    const first = await nativeFetch(url, init);
    if (!first.ok) return first;

    try {
      const firstData = await first.clone().json();
      const firstListings = Array.isArray(firstData?.listings) ? firstData.listings : [];
      const total = Number(firstData?.total || 0);
      const pages = Math.min(4, Math.max(1, Math.ceil(total / 50)));
      if (pages <= 1 || firstListings.length >= total) return first;

      const all = [...firstListings];
      const seen = new Set(firstListings.map(x => x?.id || x?.source_url).filter(Boolean));
      for (let page = 2; page <= pages; page++) {
        const nextUrl = new URL(url);
        nextUrl.searchParams.set('page', String(page));
        nextUrl.searchParams.set('page_size', '50');
        const next = await nativeFetch(nextUrl, init);
        if (!next.ok) break;
        const nextData = await next.json().catch(() => null);
        const rows = Array.isArray(nextData?.listings) ? nextData.listings : [];
        for (const row of rows) {
          const key = row?.id || row?.source_url || JSON.stringify(row);
          if (!seen.has(key)) { seen.add(key); all.push(row); }
        }
        if (rows.length < 50) break;
      }

      const merged = { ...firstData, listings: all, page: 1, page_size: 50, pages_fetched: pages };
      return new Response(JSON.stringify(merged), {
        status: first.status,
        statusText: first.statusText,
        headers: first.headers
      });
    } catch (error) {
      console.error('CarHunt pagination enrichment error', error?.message || error);
      return first;
    }
  }

  if (url.hostname === 'generativelanguage.googleapis.com' && url.pathname.includes('/models/') && url.pathname.endsWith(':generateContent') && init?.body) {
    try {
      const body = JSON.parse(init.body);
      const today = new Date().toISOString().slice(0, 10);
      const first = body?.contents?.[0]?.parts?.[0];
      if (first && typeof first.text === 'string' && !first.text.includes('DATE DE REFERENCE')) {
        first.text += `\nDATE DE REFERENCE: ${today}. Ne signale une contradiction temporelle que si une date visible est réellement postérieure à cette date. Une révision en juin 2026 est normale si la date actuelle est septembre 2026.`;
      }
      return nativeFetch(input, { ...init, body: JSON.stringify(body) });
    } catch { return nativeFetch(input, init); }
  }

  return nativeFetch(input, init);
};

// Une voiture déjà très sous le marché ne doit pas être artificiellement tirée
// encore 5 à 10 % plus bas : l'axe doit rester une négociation réaliste.
function buildNegotiation(vehicle, market) {
  const asking = Number(vehicle?.price_eur ?? market?.asking);
  const median = Number(market?.median);
  if (!Number.isFinite(asking) || !Number.isFinite(median) || asking <= 0 || median <= 0) {
    return { available: false, reason: 'Données de marché insuffisantes pour établir un axe de négociation fiable.' };
  }
  const warnings = Array.isArray(vehicle?.warnings) ? vehicle.warnings : [];
  const uncertain = Array.isArray(vehicle?.uncertain_fields) ? vehicle.uncertain_fields : [];
  const comparables = Number(market?.comparables || 0);
  const gapPct = Number.isFinite(Number(market?.gap_pct)) ? Number(market.gap_pct) : ((median - asking) / median) * 100;
  const seller = vehicle?.seller_type;
  const round50 = n => Math.round(n / 50) * 50;

  const risk = Math.min(0.025,
    Math.min(warnings.length, 2) * 0.005 +
    Math.min(uncertain.length, 2) * 0.0025
  );

  let opening, target, ceiling, position, negotiationMode;
  if (gapPct >= 20) {
    position = 'tres_sous_le_marche';
    negotiationMode = 'prix_deja_tres_attractif';
    target = asking * (1 - Math.min(risk, 0.01));
    opening = asking * (1 - Math.min(0.01 + risk, 0.02));
    ceiling = asking;
  } else if (gapPct >= 7) {
    position = 'sous_le_marche';
    negotiationMode = 'petit_geste';
    target = asking * (1 - Math.min(0.01 + risk, 0.02));
    opening = asking * (1 - Math.min(0.02 + risk, 0.03));
    ceiling = asking;
  } else if (gapPct > -7) {
    position = 'dans_le_marche';
    negotiationMode = 'negociation_normale';
    target = Math.min(asking * (1 - Math.min(0.015 + risk, 0.03)), median);
    opening = target * (seller === 'private' ? 0.985 : 0.99);
    ceiling = Math.min(asking, median);
  } else {
    position = 'au_dessus_du_marche';
    negotiationMode = 'negociation_ferme';
    target = Math.min(median * (1 + Math.min(risk, 0.02)), asking * (1 - Math.min(0.025 + risk, 0.05)));
    opening = target * (seller === 'private' ? 0.975 : 0.985);
    ceiling = Math.min(asking, median * 1.02);
  }

  target = Math.max(0, round50(target));
  opening = Math.max(0, Math.min(target, round50(opening)));
  ceiling = Math.max(opening, round50(ceiling));

  const args = [];
  if (gapPct >= 20) {
    args.push(`Le prix demandé est déjà environ ${Math.abs(gapPct).toFixed(1).replace('.', ',')} % sous la médiane des comparables : éviter une négociation agressive.`);
  } else if (gapPct >= 7) {
    args.push(`Le prix demandé est environ ${Math.abs(gapPct).toFixed(1).replace('.', ',')} % sous la médiane : demander seulement un petit geste si la visite confirme l'état annoncé.`);
  } else if (gapPct > -7) {
    args.push('Le prix est proche du marché : négocier surtout sur les éléments concrets vérifiés lors de la visite.');
  } else {
    args.push(`Le prix demandé est environ ${Math.abs(gapPct).toFixed(1).replace('.', ',')} % au-dessus de la médiane : une négociation plus ferme est justifiée.`);
  }
  if (warnings.length) args.push(`${warnings.length} point(s) de vigilance peuvent servir d'argument uniquement s'ils sont vérifiés lors de la visite.`);
  if (uncertain.length) args.push(`${uncertain.length} information(s) restent incertaines : demander les justificatifs avant de négocier sur ce point.`);
  if (comparables) args.push(`La comparaison repose sur ${comparables} annonce(s) retenue(s) comme comparable(s).`);
  if (seller === 'private') args.push('Particulier : proposer un montant simple et cohérent, sans inventer de défaut.');
  if (seller === 'professional') args.push('Professionnel : négocier aussi, si nécessaire, une prestation ou une garantie plutôt qu’une forte remise injustifiée.');

  let phrase;
  if (gapPct >= 20) {
    phrase = `« Le prix est déjà très bien placé par rapport au marché. Si tout est conforme lors de la visite, je peux vous proposer ${opening.toLocaleString('fr-FR')} € pour conclure rapidement. »`;
  } else if (opening < asking) {
    phrase = `« Le véhicule m'intéresse. Au vu du marché et des points à vérifier, je peux vous proposer ${opening.toLocaleString('fr-FR')} € si tout est conforme lors de la visite. »`;
  } else {
    phrase = `« Le prix me paraît cohérent. Si tout est conforme lors de la visite, pouvez-vous faire un petit geste pour arriver à ${target.toLocaleString('fr-FR')} € ? »`;
  }

  return {
    available: true, position, negotiation_mode: negotiationMode,
    asking: round50(asking), opening_offer: opening,
    target_price: target, ceiling_price: ceiling,
    potential_saving: Math.max(0, round50(asking - target)),
    market_gap_pct: Math.round(gapPct * 10) / 10,
    risk_discount_pct: Math.round(risk * 1000) / 10,
    arguments: args.slice(0, 8), suggested_phrase: phrase,
    rule: 'Repères de négociation, pas garantie du prix obtenu. Plus le prix est déjà sous le marché, plus la négociation doit rester légère. Ne jamais négocier un défaut non vérifié.'
  };
}

express.response.json = function patchedJson(payload) {
  try {
    if (this.req?.path === '/api/market' && payload?.ok) {
      payload = { ...payload, negotiation: buildNegotiation(this.req.body || {}, payload) };
    }
  } catch (error) { console.error('Negotiation enrichment error', error?.message || error); }
  return originalJson.call(this, payload);
};

express.response.send = function patchedSend(body) {
  if (typeof body === 'string' && body.includes('</body>') && body.includes('Vaut le Coup ?')) {
    const injection = `<section id="negotiation" class="card" hidden></section>
<style>.neg-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.neg-box{background:#f6f7f8;border-radius:14px;padding:13px}.neg-box strong{font-size:22px}.neg-main{background:#eef2f5;border-radius:18px;padding:16px}.neg-arg{padding:9px 0;border-bottom:1px solid #e1e5e8}.neg-quote{background:#fff8e7;border-left:4px solid #17212b;border-radius:10px;padding:13px;margin-top:12px}@media(max-width:520px){.neg-grid{grid-template-columns:1fr 1fr}}</style>
<script>
(function(){
  var originalFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    var response=await originalFetch(input,init);
    try{
      var url=typeof input==='string'?input:input.url;
      if(url && url.includes('/api/market')){
        var data=await response.clone().json();
        window.__vlcNegotiation=data.negotiation||null;
        var n=window.__vlcNegotiation, section=document.getElementById('negotiation');
        if(n && n.available && section){
          function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c];});}
          function euro(v){return Number(v).toLocaleString('fr-FR')+' €';}
          var h='<h2>🎯 Axe de négociation</h2><div class="neg-main"><div class="neg-grid">';
          h+='<div class="neg-box"><b>Offre de départ</b><br><strong>'+esc(euro(n.opening_offer))+'</strong></div>';
          h+='<div class="neg-box"><b>Prix cible</b><br><strong>'+esc(euro(n.target_price))+'</strong></div>';
          h+='<div class="neg-box"><b>Plafond conseillé</b><br><strong>'+esc(euro(n.ceiling_price))+'</strong></div>';
          h+='<div class="neg-box"><b>Économie visée</b><br><strong>'+esc(euro(n.potential_saving))+'</strong></div></div>';
          h+='<p class="muted">'+esc(n.rule)+'</p></div>';
          if(Array.isArray(n.arguments)&&n.arguments.length){h+='<h3>Arguments à utiliser</h3>';n.arguments.forEach(function(x){h+='<div class="neg-arg">✓ '+esc(x)+'</div>';});}
          if(n.suggested_phrase)h+='<div class="neg-quote"><b>Phrase proposée</b><br>'+esc(n.suggested_phrase)+'</div>';
          section.innerHTML=h;section.hidden=false;
        }
      }
    }catch(e){console.error('Negotiation UI error',e);}
    return response;
  };
})();
</script>`;
    body = body.replace('</body>', injection + '</body>');
  }
  return originalSend.call(this, body);
};

await import('./app.js');
