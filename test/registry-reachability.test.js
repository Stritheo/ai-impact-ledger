'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/data/impact-registry.v1.json');
const {estimateEvent} = require('../src/core/estimate');
const {normaliseModel} = require('../src/core/security');
const security = require('../src/core/security');

function resolvedEntry(provider, id) {
  const model = normaliseModel(provider, id);
  const estimate = estimateEvent({provider, model, tokens: {input: 1000, output: 1000}}, registry);
  return {model, estimate};
}

test('every registry model is reachable from a model name the parser accepts, and resolves to itself', () => {
  for (const entry of registry.models) {
    const {model, estimate} = resolvedEntry(entry.provider, entry.id);
    assert.equal(model, entry.id, `${entry.id} must survive model normalisation`);
    if (entry.priceUsdPerMillion) assert.ok(estimate.cost.central > 0, `${entry.id} must be priced`);
  }
});

test('a Claude model named without a generation is unpriced, with no dedicated registry entry', () => {
  // The removed "claude-haiku" entry could only be reached by a name such as
  // claude-haiku-20250101. Without it the call is still unpriced, and its
  // energy uses the same multiplier as before.
  assert.equal(registry.models.some((entry) => entry.id === 'claude-haiku'), false);
  const {model, estimate} = resolvedEntry('anthropic', 'claude-haiku-20250101');
  assert.equal(model, 'claude-haiku-20250101');
  assert.equal(estimate.cost.central, null);
  assert.equal(estimate.cost.reason, 'model-price-unavailable');
  const known = resolvedEntry('anthropic', 'claude-opus-5').estimate;
  assert.equal(estimate.energyWh.central, known.energyWh.central);
});

test('production code has no unused path-safety helper', () => {
  assert.equal('isSafeLogPath' in security, false);
});
