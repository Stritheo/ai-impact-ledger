'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/data/impact-registry.v1.json');
const {formatAnalogy} = require('../src/core/estimate');
const {normaliseSettings} = require('../src/core/settings');

test('the television figure cites evidence and the glass is declared a convention', () => {
  const analogies = registry.analogies;
  assert.equal(analogies.televisionWatts, 100);
  assert.equal(analogies.waterGlassMillilitres, 250);
  const evidence = registry.evidence[analogies.evidenceRef];
  assert.ok(evidence, 'the television figure cites evidence');
  assert.match(evidence.sourceUrl, /^https:\/\//);
  assert.match(evidence.derivation, /television/i);
  assert.match(analogies.waterGlassBasis, /stated unit|convention/i,
    'a 250 mL glass is a convention, so it must not look like a sourced measurement');
});

test('the comparison is stated from the midpoint, in television hours and 250 mL glasses', () => {
  // 500 Wh at 100 W is 5 hours; 2 L in 250 mL glasses is 8 glasses.
  const text = formatAnalogy({energyWh: {mid: 500}, water: {mid: 2}}, registry);
  assert.match(text, /midpoint/i);
  assert.match(text, /5\.0 hours of television at 100 watts/);
  assert.match(text, /8\.0 glasses of 250 mL/);
  assert.doesNotMatch(text, /e-bike/);
});

test('the analogy setting offers the sourced family, and an old value falls back to it', () => {
  assert.equal(normaliseSettings({analogyFamily: 'television'}).analogyFamily, 'television');
  assert.equal(normaliseSettings({analogyFamily: 'none'}).analogyFamily, 'none');
  assert.equal(normaliseSettings({analogyFamily: 'e-bike'}).analogyFamily, 'television',
    'the unsourced e-bike comparison was withdrawn');
  const manifest = require('../package.json');
  const setting = manifest.contributes.configuration.properties['aiImpactLedger.analogyFamily'];
  assert.deepEqual(setting.enum, ['television', 'none']);
  assert.equal(setting.default, 'television');
});
