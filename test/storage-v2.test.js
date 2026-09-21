'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {PartitionedStore, needsCapacityWarning} = require('../src/core/storage');

function sample(id, timestamp) {
  return {id, provider: 'openai', model: 'gpt-5.6-terra', timestamp,
    tokens: {input: 1, cachedInput: 0, cacheWrite: 0, output: 1, reasoningOutput: 0}, inferenceGeo: null};
}

test('v2 migration preserves the private v1 file and both days of detail', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const store = new PartitionedStore(root);
  const legacy = {detail: [sample('a', '2026-09-11T01:00:00Z'), sample('b', '2026-09-12T01:00:00Z')], daily: {}, checkpoints: {}};
  fs.writeFileSync(path.join(root, 'ledger.v1.json'), JSON.stringify(legacy), {mode: 0o600});
  assert.deepEqual((await store.read()).detail, legacy.detail);
  await store.update((current) => current);
  assert.equal(fs.existsSync(path.join(root, 'ledger.v1.json')), true);
  assert.deepEqual((await store.read()).detail, legacy.detail);
  assert.equal(fs.existsSync(path.join(root, 'ledger.v2', '2026-09-11.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'ledger.v2', '2026-09-12.json')), true);
});

test('v2 migration corrects Codex cached input counted twice in v1', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const store = new PartitionedStore(root);
  const legacy = {detail: [{...sample('a', '2026-09-12T01:00:00Z'), tokens: {
    input: 100, cachedInput: 40, cacheWrite: 0, output: 1, reasoningOutput: 0
  }}], daily: {'2026-09-12|openai|gpt-5.6-terra': {
    date: '2026-09-12', provider: 'openai', model: 'gpt-5.6-terra', calls: 1,
    input: 100, cachedInput: 40, cacheWrite: 0, output: 1, reasoningOutput: 0
  }}, checkpoints: {}};
  fs.writeFileSync(path.join(root, 'ledger.v1.json'), JSON.stringify(legacy), {mode: 0o600});
  await store.update((current) => current);
  assert.equal((await store.read()).detail[0].tokens.input, 60);
  assert.equal((await store.read()).detail[0].tokens.cachedInput, 40);
  assert.equal((await store.read()).daily['2026-09-12|openai|gpt-5.6-terra'].input, 60);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'ledger.v1.json'), 'utf8')).detail[0].tokens.input, 100);
});

test('an unchanged refresh writes no v2 ledger data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const store = new PartitionedStore(root);
  await store.update(() => ({detail: [sample('a', '2026-09-12T01:00:00Z')], daily: {}, checkpoints: {}}));
  const day = path.join(root, 'ledger.v2', '2026-09-12.json');
  const state = path.join(root, 'ledger.v2', 'state.json');
  const before = [fs.statSync(day).mtimeMs, fs.statSync(state).mtimeMs];
  await store.update((current) => current);
  assert.deepEqual([fs.statSync(day).mtimeMs, fs.statSync(state).mtimeMs], before);
});

test('a new day does not rewrite an unchanged older partition', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const store = new PartitionedStore(root);
  await store.update(() => ({detail: [sample('a', '2026-09-11T01:00:00Z')], daily: {}, checkpoints: {}}));
  const oldDay = path.join(root, 'ledger.v2', '2026-09-11.json');
  const before = fs.statSync(oldDay).mtimeMs;
  await store.update((current) => ({...current, detail: [...current.detail, sample('b', '2026-09-12T01:00:00Z')]}));
  assert.equal(fs.statSync(oldDay).mtimeMs, before);
  assert.equal((await store.read()).detail.length, 2);
});

test('oversized legacy state fails closed without overwriting user data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const store = new PartitionedStore(root);
  const legacy = path.join(root, 'ledger.v1.json');
  fs.writeFileSync(legacy, '{}', {mode: 0o600});
  fs.truncateSync(legacy, 64 * 1024 * 1024 + 1);
  await assert.rejects(store.update((current) => current));
  assert.equal(fs.statSync(legacy).size, 64 * 1024 * 1024 + 1);
  assert.equal(fs.existsSync(path.join(root, 'ledger.v2')), false);
});

test('unsafe v2 partition links fail closed without reading their target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const store = new PartitionedStore(root);
  await store.update(() => ({detail: [], daily: {}, checkpoints: {}}));
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'impact-outside-')), 'secret.json');
  fs.writeFileSync(outside, JSON.stringify([sample('secret', '2026-09-12T01:00:00Z')]));
  fs.symlinkSync(outside, path.join(root, 'ledger.v2', '2026-09-12.json'));
  await assert.rejects(store.read(), /unsafe/);
});

test('corrupt v2 state fails closed while preserving the v1 rollback copy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const store = new PartitionedStore(root);
  const legacy = {detail: [sample('a', '2026-09-12T01:00:00Z')], daily: {}, checkpoints: {}};
  fs.writeFileSync(path.join(root, 'ledger.v1.json'), JSON.stringify(legacy), {mode: 0o600});
  await store.update((current) => current);
  fs.writeFileSync(path.join(root, 'ledger.v2', 'state.json'), 'not-json');
  await assert.rejects(store.read());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'ledger.v1.json'), 'utf8')), legacy);
});

test('malformed v2 event is never silently dropped and rewritten', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const store = new PartitionedStore(root);
  await store.update(() => ({detail: [sample('a', '2026-09-12T01:00:00Z')], daily: {}, checkpoints: {}}));
  const part = path.join(root, 'ledger.v2', '2026-09-12.json');
  fs.writeFileSync(part, JSON.stringify([null]));
  await assert.rejects(store.update((current) => current), /invalid ledger record/);
  assert.deepEqual(JSON.parse(fs.readFileSync(part, 'utf8')), [null]);
});

test('corrupt v2 purge watermark fails closed rather than allowing old logs back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const store = new PartitionedStore(root);
  await store.update(() => ({detail: [], daily: {}, checkpoints: {}, purgedBefore: '2026-09-12T02:00:00Z'}));
  const state = path.join(root, 'ledger.v2', 'state.json');
  const corrupt = JSON.parse(fs.readFileSync(state, 'utf8'));
  corrupt.purgedBefore = 'not-a-date';
  fs.writeFileSync(state, JSON.stringify(corrupt));
  await assert.rejects(store.update((current) => current), /invalid ledger state/);
  assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).purgedBefore, 'not-a-date');
});

test('concurrent v2 writers preserve separate new events', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const stores = Array.from({length: 8}, () => new PartitionedStore(root));
  await Promise.all(stores.map((store, index) => store.update((current) => ({
    ...current, detail: [...current.detail, sample(String(index), '2026-09-12T01:00:00Z')]
  }))));
  assert.equal((await stores[0].read()).detail.length, 8);
});

test('warm unchanged update reads each partition only once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const store = new PartitionedStore(root);
  await store.update(() => ({detail: [sample('a', '2026-09-12T01:00:00Z')], daily: {}, checkpoints: {}}));
  const original = fs.promises.readFile;
  let partitionReads = 0;
  fs.promises.readFile = async (...args) => {
    if (String(args[0]).endsWith('2026-09-12.json')) partitionReads += 1;
    return original.apply(fs.promises, args);
  };
  try { await store.update((current) => current); }
  finally { fs.promises.readFile = original; }
  assert.equal(partitionReads, 1);
});

test('purge watermark survives restart and rejects a stale scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const first = new PartitionedStore(root);
  await first.update(() => ({detail: [sample('a', '2026-09-12T01:00:00Z')], daily: {}, checkpoints: {}}));
  await first.update((current) => ({...current, detail: [], purgedBefore: '2026-09-12T02:00:00Z'}));
  const restarted = new PartitionedStore(root);
  const {afterTimestamp} = require('../src/core/ledger');
  await restarted.update((current) => ({...current, detail: [...current.detail, ...afterTimestamp([
    sample('a', '2026-09-12T01:00:00Z'), sample('b', '2026-09-12T03:00:00Z')
  ], current.purgedBefore)]}));
  assert.deepEqual((await restarted.read()).detail.map((event) => event.id), ['b']);
  assert.equal((await restarted.read()).purgedBefore, '2026-09-12T02:00:00.000Z');
});

test('warm metadata read obtains checkpoints without opening detailed partitions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const store = new PartitionedStore(root);
  await store.update(() => ({detail: [sample('a', '2026-09-12T01:00:00Z')], daily: {}, checkpoints: {openai: {}}}));
  const original = fs.promises.readFile;
  let dayReads = 0;
  fs.promises.readFile = async (...args) => {
    if (String(args[0]).endsWith('2026-09-12.json')) dayReads += 1;
    return original.apply(fs.promises, args);
  };
  let metadata;
  try { metadata = await store.readMetadata(); }
  finally { fs.promises.readFile = original; }
  assert.equal(dayReads, 0);
  assert.equal(typeof metadata.revision, 'string');
  assert.deepEqual(metadata.checkpoints, {openai: {}});
  assert.ok(metadata.storageBytes > 0);
  assert.equal(metadata.limitBytes, 64 * 1024 * 1024);
});

// Changed for F-25 (release sprint plan, 17 September 2026). This test used to
// assert that any write over the cap failed, which stopped recording for good;
// detail over the cap is now trimmed (test/storage-capacity.test.js). A write
// still fails closed when the daily totals alone would exceed the cap, because
// there is no detail left to trim.
test('capacity pressure that trimming cannot relieve fails closed without changing retained records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const store = new PartitionedStore(root, 700);
  await store.update(() => ({detail: [sample('a', '2026-09-12T01:00:00Z')], daily: {}, checkpoints: {}}));
  const daily = Object.fromEntries(Array.from({length: 10}, (_, index) => {
    const date = `2026-08-${String(index + 10).padStart(2, '0')}`;
    return [`${date}|openai|gpt-5.6-terra`, {date, provider: 'openai', model: 'gpt-5.6-terra', calls: 1, input: 1,
      cachedInput: 0, cacheWrite: 0, output: 1, reasoningOutput: 0}];
  }));
  await assert.rejects(store.update((current) => ({...current, daily})), /capacity/);
  assert.deepEqual((await store.read()).detail.map((item) => item.id), ['a']);
  assert.deepEqual((await store.read()).daily, {});
});

test('capacity warning begins before the hard limit', () => {
  assert.equal(needsCapacityWarning(79, 100), false);
  assert.equal(needsCapacityWarning(80, 100), true);
});

test('interrupted state-file commit preserves recoverable detail and daily totals', async () => {
  const {mergeEvents, updateDaily, reconcileDailyFloor} = require('../src/core/ledger');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-v2-'));
  const store = new PartitionedStore(root);
  const first = sample('a', '2026-09-12T01:00:00Z');
  const second = sample('b', '2026-09-12T02:00:00Z');
  await store.update(() => ({detail: [first], daily: updateDaily({}, [], [first]), checkpoints: {}}));
  const originalRename = fs.promises.rename;
  let interrupted = false;
  fs.promises.rename = async (...args) => {
    if (!interrupted && String(args[1]).endsWith('state.json')) {
      interrupted = true;
      throw new Error('simulated interrupted state commit');
    }
    return originalRename.apply(fs.promises, args);
  };
  try {
    await assert.rejects(store.update((current) => ({...current,
      detail: mergeEvents(current.detail, [second]),
      daily: updateDaily(current.daily, current.detail, [second])
    })), /simulated/);
  } finally { fs.promises.rename = originalRename; }
  assert.equal((await store.read()).detail.length, 2);
  await store.update((current) => {
    const detail = mergeEvents(current.detail, [second]);
    return {...current, detail, daily: reconcileDailyFloor(updateDaily(current.daily, current.detail, [second]), detail)};
  });
  assert.equal((await store.read()).daily['2026-09-12|openai|gpt-5.6-terra'].calls, 2);
});
