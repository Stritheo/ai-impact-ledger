'use strict';

const fx = require('../data/fx-registry.v1.json');

const DEFAULTS = Object.freeze({
  currency: 'USD', waterUnits: 'metric', period: 'today', showAnalogy: true,
  analogyFamily: 'television', statusBarMeasure: 'cost', contributionMeasure: 'energy'
});

function choice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normaliseSettings(value = {}) {
  return {
    currency: choice(value.currency, ['USD', 'AUD', 'GBP', 'EUR'], DEFAULTS.currency),
    waterUnits: choice(value.waterUnits, ['metric', 'us', 'uk'], DEFAULTS.waterUnits),
    period: choice(value.period, ['today', '7d', '30d', '90d', 'cumulative'], DEFAULTS.period),
    showAnalogy: typeof value.showAnalogy === 'boolean' ? value.showAnalogy : DEFAULTS.showAnalogy,
    // "e-bike" was withdrawn with its unsourced 10 Wh per kilometre figure and
    // falls back to the sourced comparison.
    analogyFamily: choice(value.analogyFamily, ['television', 'none'], DEFAULTS.analogyFamily),
    statusBarMeasure: choice(value.statusBarMeasure, ['cost', 'energy'], DEFAULTS.statusBarMeasure),
    contributionMeasure: choice(value.contributionMeasure, ['energy', 'cost', 'tokens', 'calls'], DEFAULTS.contributionMeasure)
  };
}

function convertCost(usd, currency) {
  const selected = choice(currency, ['USD', 'AUD', 'GBP', 'EUR'], 'USD');
  return {value: usd * fx.eurBase[selected] / fx.eurBase.USD, currency: selected, sourceDate: fx.sourceDate};
}

function convertWater(litres, units) {
  const selected = choice(units, ['metric', 'us', 'uk'], 'metric');
  if (selected === 'us') return {value: litres / 3.785411784, unit: 'US gal'};
  if (selected === 'uk') return {value: litres / 4.54609, unit: 'UK gal'};
  return {value: litres, unit: 'L'};
}

// Environmental figures are wide derived ranges, so they are shown to two
// significant figures. Intl never falls back to exponent notation.
const TWO_FIGURES = new Intl.NumberFormat('en-AU', {minimumSignificantDigits: 2, maximumSignificantDigits: 2});

function significant(value) {
  const number = Number(value);
  return Number.isFinite(number) && number !== 0 ? TWO_FIGURES.format(number) : '0';
}

module.exports = {DEFAULTS, normaliseSettings, convertCost, convertWater, significant, fx};
