'use strict';

const {normaliseGeo} = require('./security');
const {significant} = require('./settings');

function findModel(modelId, provider, registry) {
  const id = String(modelId || '').toLowerCase();
  return registry.models.find((model) => model.provider === provider && (id === model.id
    || (id.startsWith(`${model.id}-`) && /^\d{8}$/.test(id.slice(model.id.length + 1))))) || null;
}

// Reference rates cover a call only at its standard tier and, where the
// provider sets one, up to its standard prompt size. OpenAI prices a prompt
// above that size higher for the whole request.
function pricedAtStandardRates(event, registry, options = {}) {
  if (event.nonStandardTier === true) return false;
  // A daily total is many prompts added together, so its size says nothing
  // about any one prompt. Only the caller building a total may say so, never a
  // field on the event, which a log could otherwise carry.
  if (options.aggregate === true) return true;
  const limit = findModel(event.model, event.provider, registry)?.standardPriceMaxInputTokens;
  const prompt = (event.tokens?.input || 0) + (event.tokens?.cachedInput || 0) + (event.tokens?.cacheWrite || 0);
  return !(Number.isSafeInteger(limit) && prompt > limit);
}

function round(value, digits = 6) {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

function estimateEvent(event, registry, locationContext = 'unknown', options = {}) {
  const model = findModel(event.model, event.provider, registry);
  const multiplier = model?.energyMultiplier || registry.energy.unknownModelMultiplier;
  // No reviewed source supports a central energy figure for these models, so
  // each token class carries a derived low and high and the estimate is a
  // range. The midpoint exists only for shares and everyday comparisons.
  let lowWh = 0;
  let highWh = 0;
  for (const tokenField of ['input', 'cachedInput', 'cacheWrite', 'output']) {
    const perThousand = registry.energy.whPerThousandTokens[tokenField];
    const thousands = (event.tokens[tokenField] || 0) / 1000;
    lowWh += thousands * perThousand.low * multiplier;
    highWh += thousands * perThousand.high * multiplier;
  }
  const midWh = (lowWh + highWh) / 2;

  let cost = null;
  const split = (event.tokens.cacheWrite5m || 0) + (event.tokens.cacheWrite1h || 0);
  // A per-call record whose cache-write duration cannot be reconstructed stays
  // unpriced. A daily aggregate can instead declare how many of its cache-write
  // tokens lack a duration, so the remainder of the day is still priced and the
  // excluded tokens are disclosed.
  const declaredUnclassified = event.tokens.cacheWriteUnclassified;
  const unclassifiedTokens = declaredUnclassified === undefined
    ? Math.max(0, (event.tokens.cacheWrite || 0) - split) : declaredUnclassified;
  const unclassifiedClaudeWrite = event.provider === 'anthropic' && declaredUnclassified === undefined
    && (event.tokens.cacheWrite || 0) !== split;
  const partialCost = event.provider === 'anthropic' && declaredUnclassified !== undefined && declaredUnclassified > 0;
  const nonStandardTier = !pricedAtStandardRates(event, registry, options);
  if (model?.priceUsdPerMillion && !unclassifiedClaudeWrite && !nonStandardTier) {
    const price = model.priceUsdPerMillion;
    cost = ((event.tokens.input || 0) * price.input
      + (event.tokens.cachedInput || 0) * price.cachedInput
      + (event.provider === 'anthropic'
        ? (event.tokens.cacheWrite5m || 0) * price.cacheWrite + (event.tokens.cacheWrite1h || 0) * price.cacheWrite1h
        : (event.tokens.cacheWrite || 0) * price.cacheWrite)
      + (event.tokens.output || 0) * price.output) / 1_000_000;
  }

  const water = registry.water.litresPerKwh;
  const carbon = registry.carbon.gramsCo2PerKwh || registry.carbon.gramsCo2ePerKwh;
  // Cooling water is published per kWh of IT-equipment electricity, so the
  // facility figure is divided by the overhead multiplier before it is
  // applied. Grid carbon applies to everything the facility draws.
  const pue = registry.energy.overhead.pue;
  const midPue = (pue.low + pue.high) / 2;
  const confirmedGeo = normaliseGeo(event.inferenceGeo);
  const configuredGeo = normaliseGeo(event.configuredGeo);
  const processingLocation = confirmedGeo ? {state: 'confirmed', region: confirmedGeo}
    : configuredGeo ? {state: 'configured-not-verified', region: configuredGeo}
      : {state: 'unknown', region: null};
  const context = 'unknown';
  return {
    registryVersion: registry.version,
    boundary: registry.boundary,
    confidence: 'low',
    processingLocation,
    cost: {currency: 'USD', central: cost === null ? null : round(cost), label: 'API-equivalent estimate',
      partial: cost === null ? false : partialCost,
      unclassifiedCacheWriteTokens: cost === null ? 0 : partialCost ? unclassifiedTokens : 0,
      reason: nonStandardTier ? 'non-standard-tier'
        : unclassifiedClaudeWrite ? 'cache-duration-unavailable'
        : !model?.priceUsdPerMillion ? 'model-price-unavailable' : partialCost ? 'partial-cache-duration' : null},
    energyWh: {low: round(lowWh), mid: round(midWh), high: round(highWh)},
    water: {
      unit: 'litres',
      // Each energy bound already carries an overhead multiplier: the low
      // bound was derived at the low PUE and the high bound at the high PUE.
      // Dividing by the other one would invent a wider range than the
      // derivation supports.
      low: round(lowWh / pue.low / 1000 * water.low),
      mid: round(midWh / midPue / 1000 * water.central),
      high: round(highWh / pue.high / 1000 * water.high),
      context,
      interpretation: registry.water.contexts[context] || registry.water.contexts.unknown
    },
    carbonGrams: {
      low: round(lowWh / 1000 * carbon.low),
      mid: round(midWh / 1000 * carbon.central),
      high: round(highWh / 1000 * carbon.high)
    }
  };
}

function addEstimates(estimates) {
  const total = {
    cost: {currency: 'USD', central: 0, label: 'API-equivalent estimate'},
    energyWh: {low: 0, mid: 0, high: 0},
    water: {unit: 'litres', low: 0, mid: 0, high: 0, context: 'mixed-or-unknown'},
    carbonGrams: {low: 0, mid: 0, high: 0},
    hasUnknownCost: false,
    hasPartialCost: false,
    unclassifiedCacheWriteTokens: 0
  };
  for (const estimate of estimates) {
    if (estimate.cost.central === null) total.hasUnknownCost = true;
    else {
      total.cost.central += estimate.cost.central;
      if (estimate.cost.partial) {
        total.hasPartialCost = true;
        total.unclassifiedCacheWriteTokens += estimate.cost.unclassifiedCacheWriteTokens || 0;
      }
    }
    for (const group of ['energyWh', 'water', 'carbonGrams']) {
      for (const level of ['low', 'mid', 'high']) total[group][level] += estimate[group][level];
    }
  }
  return total;
}

// The television figure is measured, from the same source as the overhead
// multipliers. The 250 mL glass is a stated unit, named in the text so the
// convention is visible rather than implied.
function formatAnalogy(estimate, registry) {
  const watts = registry?.analogies?.televisionWatts;
  const glassMillilitres = registry?.analogies?.waterGlassMillilitres;
  if (!watts || !glassMillilitres) return 'Everyday comparisons are unavailable: their factors are not in the registry.';
  const hours = estimate.energyWh.mid / watts;
  const glasses = estimate.water.mid * 1000 / glassMillilitres;
  return `At the midpoint of the range, operational energy is roughly ${significant(hours)} hours of television at ${significant(watts)} watts, and on-site cooling water is roughly ${significant(glasses)} glasses of ${significant(glassMillilitres)} mL.`;
}

module.exports = { estimateEvent, addEstimates, formatAnalogy, pricedAtStandardRates };
