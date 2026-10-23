'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../src/data/impact-registry.v1.json');
const {estimateEvent, contextReadUnits} = require('../src/core/estimate');
const {aggregateByDay, updateDaily, reconcileDailyFloor} = require('../src/core/ledger');
const {PartitionedStore} = require('../src/core/storage');

// Owner's ruling of 23 October 2026, route a1: the extra decode energy of
// attending over a longer context is measured only between 512 and 4,096
// prompt tokens (ML.ENERGY Benchmark, Table 4), so it is counted for that
// span of each call's prompt and no further.
function call(id, prompt, output, timestamp = '2026-10-23T01:00:00.000Z') {
  return {id, provider: 'anthropic', model: 'claude-opus-5-5', timestamp, inferenceGeo: null,
    tokens: {input: 0, cachedInput: prompt, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output, reasoningOutput: 0}};
}

test('the registry carries the measured context-reading range and its limits', () => {
  const reading = registry.energy.contextReading;
  assert.deepEqual(reading.whPerMillionOutputContextTokens, {low: 0.0145, high: 0.189});
  assert.equal(reading.baselineContextTokens, 512);
  assert.equal(reading.maxContextTokens, 4096);
  assert.ok(registry.evidence[reading.evidenceRef], 'the range cites its source');
  assert.match(registry.energy.excludes.join(' '), /beyond 4,096 tokens/);
});

test('context is counted per output token, only between 512 and 4,096 prompt tokens', () => {
  assert.equal(contextReadUnits(call('a', 300, 10).tokens, registry), 0, 'a prompt under the baseline adds nothing');
  assert.equal(contextReadUnits(call('b', 2000, 10).tokens, registry), 10 * 1488);
  assert.equal(contextReadUnits(call('c', 118_000, 10).tokens, registry), 10 * 3584, 'context beyond 4,096 is not extrapolated');
  assert.equal(contextReadUnits(call('d', 118_000, 0).tokens, registry), 0, 'no output, no decode');
  const mixed = {input: 1000, cachedInput: 2000, cacheWrite: 500, output: 4};
  assert.equal(contextReadUnits(mixed, registry), 4 * (3500 - 512), 'the prompt is fresh, cached and written input together');
});

test('an estimate adds the context-reading range to each bound', () => {
  const zeroed = {...registry, energy: {...registry.energy,
    contextReading: {...registry.energy.contextReading, whPerMillionOutputContextTokens: {low: 0, high: 0}}}};
  const event = call('e', 50_000, 1000);
  const withReading = estimateEvent(event, registry).energyWh;
  const without = estimateEvent(event, zeroed).energyWh;
  // 1,000 output tokens x 3,584 context tokens = 3.584 million pairs.
  assert.equal(Math.round((withReading.low - without.low) * 1e6) / 1e6, Math.round(3.584 * 0.0145 * 1e6) / 1e6);
  assert.equal(Math.round((withReading.high - without.high) * 1e6) / 1e6, Math.round(3.584 * 0.189 * 1e6) / 1e6);
});

test('a daily total carries its calls\' context pairs, and an older total without them adds none', () => {
  const day = Object.values(aggregateByDay([call('f', 50_000, 1000), call('g', 1000, 100)]))[0];
  assert.equal(day.contextReadUnits, 1000 * 3584 + 100 * 488);
  const aggregate = {provider: 'anthropic', model: 'claude-opus-5-5', inferenceGeo: null,
    tokens: {input: 0, cachedInput: 51_000, cacheWrite: 0, cacheWriteUnclassified: 0, output: 1100}};
  const fromStored = estimateEvent({...aggregate, tokens: {...aggregate.tokens, contextReadUnits: day.contextReadUnits}},
    registry, 'unknown', {aggregate: true});
  const perCall = [call('f', 50_000, 1000), call('g', 1000, 100)].map((item) => estimateEvent(item, registry).energyWh.high);
  assert.equal(Math.round(fromStored.energyWh.high * 1e5), Math.round((perCall[0] + perCall[1]) * 1e5));
  // Summed tokens cannot rebuild per-call context, so a row recorded before
  // this field existed is estimated as it was, never re-derived from totals.
  const older = estimateEvent(aggregate, registry, 'unknown', {aggregate: true});
  assert.ok(older.energyWh.high < fromStored.energyWh.high);
});

test('replacing a recorded call moves its context pairs with it', () => {
  const first = call('h', 50_000, 1000);
  const daily = updateDaily({}, [], [first]);
  const revised = updateDaily(daily, [first], [{...first, tokens: {...first.tokens, output: 10}}]);
  assert.equal(Object.values(revised)[0].contextReadUnits, 10 * 3584);
});

test('reconciling an older total with retained detail restores its context pairs', () => {
  const detail = [call('j', 50_000, 1000)];
  const [key, row] = Object.entries(aggregateByDay(detail))[0];
  const {contextReadUnits: dropped, ...older} = row;
  assert.equal(reconcileDailyFloor({[key]: older}, detail)[key].contextReadUnits, dropped);
});

test('stored daily totals keep their context pairs and reject a malformed value', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-context-'));
  const store = new PartitionedStore(root);
  const daily = aggregateByDay([call('i', 50_000, 1000)]);
  await store.update(() => ({detail: [], daily, checkpoints: {}}));
  assert.equal(Object.values((await store.read()).daily)[0].contextReadUnits, 1000 * 3584);
  const [key, row] = Object.entries(daily)[0];
  await store.update(() => ({detail: [], daily: {[key]: {...row, contextReadUnits: -5}}, checkpoints: {}}));
  assert.equal(Object.values((await store.read()).daily)[0].contextReadUnits, 0, 'a malformed value is not stored');
});

// Runs the security gate against a copy whose registry has been altered, so
// the gate's own rule is what is tested.
function gateWith(alter) {
  const {spawnSync} = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-context-gate-'));
  for (const item of ['src', 'scripts', 'package.json']) fs.cpSync(item, path.join(root, item), {recursive: true});
  const file = path.join(root, 'src', 'data', 'impact-registry.v1.json');
  const copy = JSON.parse(fs.readFileSync(file, 'utf8'));
  alter(copy);
  fs.writeFileSync(file, JSON.stringify(copy));
  return spawnSync(process.execPath, ['scripts/security-audit.mjs'], {cwd: root, encoding: 'utf8'});
}

test('the security gate rejects a context-reading range that is missing, inverted or unsourced', () => {
  assert.equal(gateWith(() => {}).status, 0);
  for (const [label, alter] of [
    ['missing', (copy) => { delete copy.energy.contextReading; }],
    ['inverted', (copy) => { copy.energy.contextReading.whPerMillionOutputContextTokens = {low: 0.2, high: 0.1}; }],
    ['span reversed', (copy) => { copy.energy.contextReading.maxContextTokens = 256; }],
    ['unsourced', (copy) => { copy.energy.contextReading.evidenceRef = 'nowhere'; }]
  ]) {
    const result = gateWith(alter);
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, /context reading/, label);
  }
});
