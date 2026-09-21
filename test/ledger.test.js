'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeEvents, applyRetention, afterTimestamp, aggregateByDay, updateDaily, reconcileDailyFloor } = require('../src/core/ledger');

const event = (id, provider, timestamp) => ({id, provider, model: 'model', timestamp, tokens: {input: 10, cachedInput: 0, cacheWrite: 0, output: 2, reasoningOutput: 0}});

test('repeated scans and nested harness records count each provider call once', () => {
  const claude = event('claude:req-1', 'anthropic', '2026-09-12T00:00:00Z');
  const codex = event('codex:file:turn-1', 'openai', '2026-09-12T00:00:01Z');
  const merged = mergeEvents([claude], [claude, codex, codex]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((item) => item.provider).sort(), ['anthropic', 'openai']);
});

test('retention removes detail while preserving daily aggregates', () => {
  const old = event('old', 'anthropic', '2026-01-01T00:00:00Z');
  const recent = event('recent', 'openai', '2026-09-12T00:00:00Z');
  const aggregates = aggregateByDay([old, recent]);
  const retained = applyRetention([old, recent], 90, new Date('2026-09-12T12:00:00Z'));
  assert.equal(retained.length, 1);
  assert.equal(Object.keys(aggregates).length, 2);
});

test('a privacy purge prevents old source logs from repopulating detail', () => {
  const old = event('old', 'anthropic', '2026-09-12T00:00:00Z');
  const newEvent = event('new', 'openai', '2026-09-12T00:02:00Z');
  assert.deepEqual(afterTimestamp([old, newEvent], '2026-09-12T00:01:00Z').map((item) => item.id), ['new']);
});

test('daily history is additive, deduplicated and does not shrink as detail expires', () => {
  const old = event('old', 'anthropic', '2026-01-01T00:00:00Z');
  const newer = event('new', 'anthropic', '2026-01-01T01:00:00Z');
  const first = updateDaily({}, [], [old]);
  const second = updateDaily(first, [old], [old, newer]);
  const unchanged = updateDaily(second, [newer], []);
  assert.equal(unchanged['2026-01-01|anthropic|model'].calls, 2);
  assert.equal(unchanged['2026-01-01|anthropic|model'].input, 20);
});

test('daily totals recover when a partition was committed before its state file', () => {
  const first = event('a', 'anthropic', '2026-09-12T00:00:00Z');
  const second = event('b', 'anthropic', '2026-09-12T01:00:00Z');
  const staleDaily = aggregateByDay([first]);
  const recovered = reconcileDailyFloor(staleDaily, [first, second]);
  assert.equal(recovered['2026-09-12|anthropic|model'].calls, 2);
  assert.equal(recovered['2026-09-12|anthropic|model'].input, 20);
  const stable = reconcileDailyFloor(recovered, [second]);
  assert.equal(stable['2026-09-12|anthropic|model'].calls, 2);
});
