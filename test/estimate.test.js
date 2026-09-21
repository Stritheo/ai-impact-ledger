'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/data/impact-registry.v1.json');
const { estimateEvent, formatAnalogy } = require('../src/core/estimate');

// Changed 17 September 2026: the fixture was a one-million-token prompt, which
// OpenAI prices at 2x input and 1.5x output above 272K tokens, so 14 was never
// the published price. The prompt now stays within the standard size.
test('Terra cost uses published API-equivalent prices', () => {
  const result = estimateEvent({provider: 'openai', model: 'gpt-5.6-terra', tokens: {input: 200_000, cachedInput: 0, cacheWrite: 0, output: 200_000, reasoningOutput: 0}, inferenceGeo: null}, registry);
  assert.equal(result.cost.currency, 'USD');
  assert.equal(result.cost.central, 2.8, '200K input at US$2 and 200K output at US$12 per million');
  assert.equal(result.cost.label, 'API-equivalent estimate');
});

test('environmental estimates expose ranges, boundary and confidence', () => {
  const result = estimateEvent({provider: 'anthropic', model: 'claude-opus-5', tokens: {input: 1000, cachedInput: 0, cacheWrite: 0, output: 1000, reasoningOutput: 0}, inferenceGeo: null}, registry);
  // Energy is a derived range from 17 September 2026: the midpoint replaces
  // the central figure, which no reviewed source supports.
  assert.equal(result.energyWh.central, undefined);
  assert.ok(result.energyWh.low < result.energyWh.mid);
  assert.ok(result.energyWh.mid < result.energyWh.high);
  assert.equal(result.boundary, 'inference-operations-only');
  assert.equal(result.water.context, 'unknown');
  assert.match(formatAnalogy(result, registry), /hours of television/);
});

test('unknown models remain visible and conservative', () => {
  const result = estimateEvent({provider: 'unknown', model: 'new-model', tokens: {input: 1000, cachedInput: 0, cacheWrite: 0, output: 0, reasoningOutput: 0}, inferenceGeo: null}, registry);
  assert.equal(result.cost.central, null);
  assert.equal(result.confidence, 'low');
  assert.ok(result.energyWh.high > 0);
});

test('a model is priced only by its own provider and reviewed version family', () => {
  const tokens = {input: 1000, cachedInput: 0, cacheWrite: 0, output: 0, reasoningOutput: 0};
  assert.equal(estimateEvent({provider: 'anthropic', model: 'gpt-5.6-terra', tokens}, registry).cost.central, null);
  assert.notEqual(estimateEvent({provider: 'anthropic', model: 'claude-opus-4-8', tokens}, registry).cost.central, null);
  assert.equal(estimateEvent({provider: 'anthropic', model: 'claude-opus-5-1', tokens}, registry).cost.central, null);
  assert.notEqual(estimateEvent({provider: 'anthropic', model: 'claude-opus-5', tokens}, registry).cost.central, null);
});
