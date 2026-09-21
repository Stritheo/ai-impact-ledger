'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/data/impact-registry.v1.json');
const {estimateEvent, formatAnalogy} = require('../src/core/estimate');
const {buildSummary, reportHtml, statusSummary} = require('../src/core/report');

const TOKENS = {input: 1000, cachedInput: 10_000, cacheWrite: 2000, output: 500, reasoningOutput: 0};
const EVENT = {id: 'a', provider: 'anthropic', model: 'claude-opus-5', timestamp: '2026-09-17T03:00:00.000Z',
  tokens: TOKENS, inferenceGeo: null};

test('the registry holds a low and a high energy figure for each token class, and no central one', () => {
  const energy = registry.energy;
  assert.equal(energy.uncertaintyFactor, undefined, 'the threefold scenario factor is replaced by derived ranges');
  for (const field of ['freshInputWhPerThousand', 'cachedInputWhPerThousand', 'cacheWriteWhPerThousand', 'outputWhPerThousand']) {
    assert.equal(energy[field], undefined, `${field} was a single central figure`);
  }
  const classOf = (name) => energy.whPerThousandTokens[name];
  for (const [name, low, high] of [['input', 0.086, 0.117], ['cacheWrite', 0.086, 0.117], ['output', 0.2, 1.45]]) {
    assert.equal(classOf(name).low, low, name);
    assert.equal(classOf(name).high, high, name);
    assert.ok(registry.evidence[classOf(name).evidenceRef], `${name} cites its own source`);
  }
  assert.equal(classOf('cachedInput').low, 0);
  assert.equal(classOf('cachedInput').high, 0);
  // A zero class is excluded, not measured as zero, and the registry says so.
  assert.equal(classOf('cachedInput').upperBoundEstablished, false);
  assert.match(classOf('cachedInput').note, /not an upper bound/i);
  assert.deepEqual(energy.overhead.pue, {low: 1.09, high: 1.4});
  assert.match(energy.excludes.join(' '), /cached context/i);
  assert.ok(registry.evidence[energy.evidenceRef], 'the ranges cite evidence');
  assert.ok(registry.evidence[energy.overheadEvidenceRef], 'the overhead multiplier cites evidence');
});

test('an estimate is a range, and cached input adds nothing to it', () => {
  const estimate = estimateEvent(EVENT, registry);
  // low  = 1 x 0.086 + 10 x 0 + 2 x 0.086 + 0.5 x 0.20
  // high = 1 x 0.117 + 10 x 0    + 2 x 0.117 + 0.5 x 1.45
  assert.equal(estimate.energyWh.low, 0.358);
  assert.equal(estimate.energyWh.high, 1.076);
  assert.equal(estimate.energyWh.mid, 0.717, 'the midpoint is for shares and analogies only');
  assert.equal(estimate.energyWh.central, undefined, 'no central figure is published');

  const cachedOnly = estimateEvent({...EVENT, tokens: {...TOKENS, input: 0, cacheWrite: 0, output: 0}}, registry);
  assert.equal(cachedOnly.energyWh.high, 0, 'cached input has no measured energy');
});

test('water is measured against IT electricity and carbon against facility electricity', () => {
  const estimate = estimateEvent(EVENT, registry);
  // Each energy bound is divided by the overhead multiplier it was derived
  // with: high = 1.076 / 1.40 / 1000 x 1.15 L per kWh of IT load.
  assert.equal(estimate.water.high, 0.000884);
  assert.equal(estimate.water.low, 0, 'the lower water bound is not established');
  assert.equal(estimate.water.mid, 0.000207);
  // carbon = facility energy x grid intensity
  assert.equal(estimate.carbonGrams.low, 0.03222);
  assert.equal(estimate.carbonGrams.mid, 0.311895);
  assert.equal(estimate.carbonGrams.high, 0.74782);
  assert.equal(estimate.boundary, 'inference-operations-only');
});

test('the report shows ranges, no central figure, and says what is excluded', () => {
  const summary = buildSummary([EVENT], registry, 'unknown',
    {settings: {period: 'cumulative'}, now: new Date('2026-09-17T12:00:00Z'), timeZone: 'UTC'});
  const html = reportHtml(summary);
  assert.match(html, /0\.36–1\.1 Wh/, 'the energy card is a range');
  assert.doesNotMatch(html, /one-third and three times/, 'the threefold scenario wording is gone');
  assert.match(html, /re-reading cached context/i);
  assert.match(html, /0–0\.00088 L/);
  assert.match(html, /0\.032–0\.75 g CO₂/);
  assert.match(html, /midpoint/i, 'the analogy and share say they use a midpoint');
  assert.match(summary.analogy, /0\.0072 hours of television/, 'the analogy uses the midpoint');
  assert.match(formatAnalogy(estimateEvent(EVENT, registry), registry), /0\.00083 glasses of 250 mL/);
});

test('the status bar shows the range, not a single figure', () => {
  const summary = buildSummary([EVENT], registry, 'unknown',
    {settings: {period: 'cumulative'}, now: new Date('2026-09-17T12:00:00Z'), timeZone: 'UTC'});
  const figures = statusSummary(summary);
  assert.equal(figures.energy, '0.36–1.1 Wh');
  assert.equal(figures.energyRange, '0.36–1.1 Wh');
});

test('provider and model shares use the midpoint of the range', () => {
  const codex = {...EVENT, id: 'b', provider: 'openai', model: 'gpt-5.6-sol'};
  const summary = buildSummary([EVENT, codex], registry, 'unknown',
    {settings: {period: 'cumulative'}, now: new Date('2026-09-17T12:00:00Z'), timeZone: 'UTC'});
  assert.equal(summary.providers.anthropic.energyWh, 0.717);
  assert.equal(summary.providers.openai.energyWh, 0.717);
  assert.equal(summary.total.energyWh.mid, 1.434);
  assert.match(reportHtml(summary), /Claude 50\.0% · /);
});
