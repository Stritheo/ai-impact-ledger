'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {significant} = require('../src/core/settings');
const {formatAnalogy} = require('../src/core/estimate');
const {reportHtml, statusSummary} = require('../src/core/report');

test('energy, water and carbon figures are shown to two significant figures at every magnitude', () => {
  const cases = [[143000, '140,000'], [13.73117, '14'], [9.96, '10'], [2.44372, '2.4'], [1, '1.0'],
    [0.1234, '0.12'], [0.004943, '0.0049'], [0.0000123, '0.000012'], [0, '0'], [undefined, '0']];
  for (const [value, expected] of cases) assert.equal(significant(value), expected, String(value));
});

// Energy, water and carbon became derived ranges on 17 September 2026, so the
// fixtures carry a low and a high and the report shows the range itself.
function summary(energy, water, carbon) {
  const mid = (range) => (range[0] + range[1]) / 2;
  return {
    day: '2026-09-17', start: '2026-09-17', end: '2026-09-17', period: 'today', timeZone: 'UTC',
    lastScanAt: '2026-09-17T02:00:00Z', calls: 2, tokens: 103203,
    providers: {anthropic: {calls: 1, tokens: 1, energyWh: mid(energy) / 2, costUsd: 0.1, unpricedCalls: 0},
      openai: {calls: 1, tokens: 1, energyWh: mid(energy) / 2, costUsd: 0.1, unpricedCalls: 0}},
    models: {anthropic: [], openai: []},
    total: {cost: {central: 0.232315}, hasUnknownCost: false, hasPartialCost: false,
      energyWh: {low: energy[0], mid: mid(energy), high: energy[1]},
      water: {low: water[0], mid: mid(water), high: water[1]},
      carbonGrams: {low: carbon[0], mid: mid(carbon), high: carbon[1]}},
    analogy: formatAnalogy({energyWh: {mid: mid(energy)}, water: {mid: mid(water)}}, require('../src/data/impact-registry.v1.json')),
    settings: {period: 'today'}
  };
}

test('the report shows ranges to two significant figures and never exponent notation', () => {
  const small = reportHtml(summary([4.577, 41.19], [0, 0.019772], [0.4119, 28.67]));
  assert.match(small, />4\.6–41 Wh</);
  assert.match(small, />0–0\.020 L</);
  assert.match(small, />0\.41–29 g CO₂</);
  assert.match(small, /roughly 0\.23 hours of television at 100 watts, and on-site cooling water is roughly 0\.040 glasses of 250 mL/);
  assert.doesNotMatch(small, /22\.88|4\.577|41\.19/);

  const large = reportHtml(summary([47666.7, 429000], [0, 205.92], [4290, 298000]));
  assert.match(large, />48–430 kWh</);
  assert.match(large, />0–210 L</);
  assert.match(large, />4\.3–300 kg CO₂</);
  assert.match(large, /2,400 hours of television/);
  assert.match(large, /410 glasses of 250 mL/);
  assert.doesNotMatch(large, /e\+\d/);
  assert.match(large, /US\$0\.23/, 'cost keeps two decimal places');
});

test('the status bar uses the same precision', () => {
  const small = statusSummary(summary([4.577, 41.19], [0, 0.019772], [0.4119, 28.67]));
  assert.equal(small.energy, '4.6–41 Wh');
  assert.equal(small.energyRange, '4.6–41 Wh');
  const large = statusSummary(summary([47666.7, 429000], [0, 205.92], [4290, 298000]));
  assert.equal(large.energy, '48–430 kWh');
  const none = statusSummary(summary([0, 0], [0, 0], [0, 0]));
  assert.equal(none.energy, '0–0 Wh');
});
