import express from 'express';
import issueLibrary from './vehicle-issues.json' with { type: 'json' };

const previousJson = express.response.json;

function norm(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ' ').replace(/[^a-z0-9.,+]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function vehicleText(vehicle) {
  return [
    vehicle?.make, vehicle?.model, vehicle?.version, vehicle?.trim, vehicle?.finish,
    ...(Array.isArray(vehicle?.visible_claims) ? vehicle.visible_claims : [])
  ].map(norm).join(' ');
}

function matches(entry, vehicle) {
  const make = norm(vehicle?.make);
  const model = norm(vehicle?.model);
  if (!make || !model || !make.includes(norm(entry.make))) return false;
  if (entry.model !== '*' && !model.includes(norm(entry.model))) return false;

  const year = Number(vehicle?.year);
  if (Number.isFinite(year)) {
    if (entry.year_min != null && year < entry.year_min) return false;
    if (entry.year_max != null && year > entry.year_max) return false;
  }

  const text = vehicleText(vehicle);
  if (Array.isArray(entry.engine_keywords) && entry.engine_keywords.length) {
    if (!entry.engine_keywords.some(keyword => text.includes(norm(keyword)))) return false;
  }
  return true;
}

function addUnique(arr, value) {
  const out = Array.isArray(arr) ? arr : [];
  if (!out.some(x => String(x).toLowerCase() === String(value).toLowerCase())) out.push(value);
  return out;
}

function enrichAnalysis(payload) {
  if (!payload?.ok) return payload;
  const vehicle = payload.vehicle || payload.analysis || payload;
  const matchesFound = issueLibrary.entries.filter(entry => matches(entry, vehicle));
  if (!matchesFound.length) {
    vehicle.known_issues = [];
    vehicle.issue_library = { version: issueLibrary.version, matched: 0 };
    return payload;
  }

  vehicle.known_issues = matchesFound.map(entry => ({
    id: entry.id,
    type: entry.type,
    title: entry.title,
    severity: entry.severity,
    description: entry.description,
    checks: entry.checks,
    negotiation_reserve_eur: entry.negotiation_reserve_eur ?? null,
    source: entry.source,
    source_url: entry.source_url,
    source_type: entry.source_type,
    last_verified: entry.last_verified
  }));
  vehicle.issue_library = { version: issueLibrary.version, matched: matchesFound.length };

  for (const entry of matchesFound) {
    const message = `⚠️ Défaillance connue — ${entry.title} : contrôle ciblé recommandé avant achat.`;
    vehicle.warnings = addUnique(vehicle.warnings, message);
    vehicle.vigilance = addUnique(vehicle.vigilance, message);
    vehicle.points_of_attention = addUnique(vehicle.points_of_attention, message);
  }

  return payload;
}

express.response.json = function vehicleIssuesPolicyJson(payload) {
  try {
    if (this.req?.path === '/api/analyze') payload = enrichAnalysis(payload);
  } catch (error) {
    console.error('Vehicle issues policy error', error?.message || error);
  }
  return previousJson.call(this, payload);
};
