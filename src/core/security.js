'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normaliseModel(provider, value) {
  if (typeof value !== 'string' || value.length > 80) return 'unknown';
  if (provider === 'openai' && value === 'codex-auto-review') return value;
  if (provider === 'anthropic' && /^claude-(fable|opus|sonnet|haiku)-[0-9]+(?:[-._][0-9]+){0,5}$/.test(value)) return value;
  if (provider === 'openai' && /^gpt-[0-9]+(?:\.[0-9]+)?-(astra|sol|terra|luna)(?:-[0-9]{8})?$/.test(value)) return value;
  return 'unknown';
}

function normaliseGeo(value) {
  const allowed = new Set(['US', 'CA', 'GB', 'AU', 'IE', 'DE', 'FR', 'NL', 'SE', 'NO', 'FI', 'JP', 'SG', 'IN']);
  const code = typeof value === 'string' ? value.toUpperCase() : '';
  return allowed.has(code) ? code : null;
}

function sanitiseEvent(event) {
  return {
    id: typeof event.id === 'string' ? event.id.slice(0, 500) : 'unknown',
    provider: typeof event.provider === 'string' ? event.provider.slice(0, 30) : 'unknown',
    model: normaliseModel(event.provider, event.model),
    timestamp: Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : new Date(0).toISOString(),
    tokens: {
      input: safeInteger(event.tokens?.input),
      cachedInput: safeInteger(event.tokens?.cachedInput),
      cacheWrite: safeInteger(event.tokens?.cacheWrite),
      ...(event.tokens?.cacheWrite5m !== undefined ? {cacheWrite5m: safeInteger(event.tokens.cacheWrite5m)} : {}),
      ...(event.tokens?.cacheWrite1h !== undefined ? {cacheWrite1h: safeInteger(event.tokens.cacheWrite1h)} : {}),
      output: safeInteger(event.tokens?.output),
      reasoningOutput: safeInteger(event.tokens?.reasoningOutput)
    },
    inferenceGeo: normaliseGeo(event.inferenceGeo),
    ...(event.nonStandardTier === true ? {nonStandardTier: true} : {}),
    ...(event.configuredGeo !== undefined ? {configuredGeo: normaliseGeo(event.configuredGeo)} : {})
  };
}

function hashEventId(id, secret) {
  return crypto.createHmac('sha256', secret).update(id).digest('hex');
}

// A consumer must be able to find its own project without being told a secret,
// so the key is a plain hash of the folder. It keeps folder names out of the
// export; it does not hide a folder from someone who can already guess it.
function projectKey(folder) {
  if (typeof folder !== 'string' || folder.length > 4096 || !path.isAbsolute(folder)) return null;
  return crypto.createHash('sha256').update(`ai-impact-ledger/project/v1:${path.resolve(folder)}`).digest('hex');
}

module.exports = { sanitiseEvent, hashEventId, normaliseModel, normaliseGeo, projectKey };
