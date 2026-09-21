'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/data/impact-registry.v1.json');
const {parseClaudeLines, parseCodexLines} = require('../src/core/parsers');
const {estimateEvent} = require('../src/core/estimate');
const {buildSummary, reportHtml} = require('../src/core/report');
const {normaliseModel} = require('../src/core/security');

test('Claude preserves cache duration and prices each write separately', () => {
  const line = JSON.stringify({type: 'assistant', requestId: 'req-1', timestamp: '2026-09-15T00:00:00Z',
    message: {model: 'claude-opus-5', usage: {input_tokens: 1, output_tokens: 1,
      cache_creation_input_tokens: 200,
      cache_creation: {ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 100}}}});
  const events = parseClaudeLines([line, line], 'fixture.jsonl');
  assert.equal(events.length, 1);
  assert.equal(events[0].tokens.cacheWrite5m, 100);
  assert.equal(events[0].tokens.cacheWrite1h, 100);
  assert.equal(events[0].tokens.cacheWrite, 200);
  const estimate = estimateEvent(events[0], registry);
  assert.equal(estimate.cost.central, 0.001655);
});

test('exact published Claude identities are priced, internal Codex model is not', () => {
  for (const model of ['claude-fable-5-1', 'claude-opus-4-8', 'claude-haiku-4-5-20251001']) {
    assert.notEqual(estimateEvent({provider: 'anthropic', model, timestamp: '2026-09-15T00:00:00Z',
      tokens: {input: 1000, cachedInput: 0, cacheWrite: 0, output: 0}}, registry).cost.central, null, model);
  }
  assert.equal(estimateEvent({provider: 'openai', model: 'codex-auto-review', tokens: {input: 1000}}, registry).cost.central, null);
  assert.equal(normaliseModel('openai', 'codex-auto-review'), 'codex-auto-review');
});

test('one request written in both Codex schemas is counted once, not twice', () => {
  const context = {type: 'turn_context', timestamp: '2026-09-15T00:00:00Z', payload: {turn_id: 't1', model: 'gpt-5.6-sol'}};
  const old = {type: 'event_msg', timestamp: '2026-09-15T00:00:01Z', payload: {type: 'token_count', info: {
    last_token_usage: {input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5},
    total_token_usage: {input_tokens: 100, output_tokens: 20}}}};
  const newer = {type: 'token_usage_record', timestamp: '2026-09-15T00:00:02Z', payload: {
    turn_id: 't1', response_id: 'resp_1',
    usage: {input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5}}};
  const events = parseCodexLines([context, old, newer].map(JSON.stringify), 'rollout.jsonl');
  assert.equal(events.length, 1);
  assert.equal(events[0].tokens.input, 60);
  assert.equal(events[0].tokens.output, 20);
  assert.deepEqual(parseCodexLines([context, newer].map(JSON.stringify), 'new-only.jsonl')[0].tokens,
    events[0].tokens);
});

test('report labels IEA electricity emissions CO2 and uses CSP-safe colour bar', () => {
  const events = [{id: 'a', provider: 'anthropic', model: 'claude-opus-5', timestamp: '2026-09-15T00:00:00Z',
    tokens: {input: 100, cachedInput: 0, cacheWrite: 0, output: 0}, inferenceGeo: null}];
  const html = reportHtml(buildSummary(events, registry, 'unknown', {period: 'today',
    now: new Date('2026-09-15T00:05:00Z'), timeZone: 'Australia/Sydney'}));
  assert.match(html, /How to read this report<\/a>/);
  assert.match(html, /g CO₂|kg CO₂/);
  assert.doesNotMatch(html, /CO₂e/);
  assert.doesNotMatch(html, /style="width:/);
});

test('processing-region evidence never implies a facility or water source', () => {
  const tokens = {input: 1000, cachedInput: 0, cacheWrite: 0, output: 0};
  const unknown = estimateEvent({provider: 'anthropic', model: 'claude-opus-5', tokens, inferenceGeo: null}, registry);
  const confirmed = estimateEvent({provider: 'anthropic', model: 'claude-opus-5', tokens, inferenceGeo: 'US'}, registry);
  const configured = estimateEvent({provider: 'anthropic', model: 'claude-opus-5', tokens,
    inferenceGeo: null, configuredGeo: 'US'}, registry);
  assert.deepEqual(unknown.processingLocation, {state: 'unknown', region: null});
  assert.deepEqual(confirmed.processingLocation, {state: 'confirmed', region: 'US'});
  assert.deepEqual(configured.processingLocation, {state: 'configured-not-verified', region: 'US'});
  assert.equal(confirmed.water.context, 'unknown');
});

test('legacy collapsed Claude cache writes cannot be assigned a fabricated cost', () => {
  const result = estimateEvent({provider: 'anthropic', model: 'claude-opus-5',
    tokens: {input: 100, cachedInput: 0, cacheWrite: 200, output: 1}}, registry);
  assert.equal(result.cost.central, null);
});

test('energy does not pretend to know a provider-specific model multiplier', () => {
  assert.ok(registry.models.every((model) => model.energyMultiplier === 1));
});

test('a malformed token counter cannot produce a partial usage record', () => {
  const malformedClaude = {type: 'assistant', requestId: 'bad', timestamp: '2026-09-15T00:00:00Z',
    message: {model: 'claude-opus-5', usage: {input_tokens: 'oops', output_tokens: 100}}};
  const malformedCodex = {type: 'token_usage_record', timestamp: '2026-09-15T00:00:00Z',
    payload: {turn_id: 't1', usage: {input_tokens: 100, cached_input_tokens: 150, output_tokens: 1}}};
  const context = {type: 'turn_context', timestamp: '2026-09-15T00:00:00Z',
    payload: {turn_id: 't1', model: 'gpt-5.6-sol'}};
  assert.equal(parseClaudeLines([JSON.stringify(malformedClaude)], 'bad.jsonl').length, 0);
  assert.equal(parseCodexLines([context, malformedCodex].map(JSON.stringify), 'bad.jsonl').length, 0);
});
