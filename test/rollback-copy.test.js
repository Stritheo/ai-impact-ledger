'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {PartitionedStore} = require('../src/core/storage');

const DAY_MS = 86_400_000;
const T0 = new Date('2026-09-10T00:00:00Z');

function legacyInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-rollback-'));
  const legacy = path.join(root, 'ledger.v1.json');
  fs.writeFileSync(legacy, JSON.stringify({
    detail: [{id: 'a'.repeat(64), provider: 'anthropic', model: 'claude-opus-5', timestamp: '2026-09-09T10:00:00.000Z',
      tokens: {input: 1, cachedInput: 0, cacheWrite: 0, output: 1, reasoningOutput: 0}, inferenceGeo: null}],
    daily: {}, checkpoints: {}
  }), {mode: 0o600});
  return {root, legacy, store: new PartitionedStore(root)};
}

const keep = (current) => current;
const stateOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'ledger.v2', 'state.json'), 'utf8'));

test('the rollback copy is kept for 14 days after the new store is confirmed readable, then deleted', async () => {
  const {root, legacy, store} = legacyInstall();
  // First activation after upgrade: the new store is created in this very update.
  await store.update(keep, {now: T0});
  assert.equal(stateOf(root).rollbackConfirmedAt, T0.toISOString());
  assert.equal(fs.existsSync(legacy), true, 'the copy must survive the upgrade itself');
  // A later update must not move the confirmation date forward.
  await store.update(keep, {now: new Date(T0.getTime() + 5 * DAY_MS)});
  assert.equal(stateOf(root).rollbackConfirmedAt, T0.toISOString());
  await store.update(keep, {now: new Date(T0.getTime() + 14 * DAY_MS - 3_600_000)});
  assert.equal(fs.existsSync(legacy), true, 'one hour short of 14 days the copy remains');
  await store.update(keep, {now: new Date(T0.getTime() + 14 * DAY_MS)});
  assert.equal(fs.existsSync(legacy), false, 'at 14 days the copy is deleted');
  const detail = (await store.read()).detail;
  assert.equal(detail.length, 1, 'the migrated record is still held in the new store');
});

test('the rollback copy is never deleted, or its clock started, when the new store cannot be read back', async () => {
  const {root, legacy, store} = legacyInstall();
  const originalRead = store.read.bind(store);
  let reads = 0;
  // The write succeeds, but reading the new store back fails.
  store.read = async () => {
    reads += 1;
    if (reads > 1) throw new Error('invalid ledger record');
    return originalRead();
  };
  await assert.rejects(store.update(keep, {now: T0}));
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(stateOf(root).rollbackConfirmedAt ?? null, null, 'confirmation must follow a read-back, not a write');
  store.read = originalRead;

  // A corrupt new store is never grounds for deleting the only other copy.
  const {root: corruptRoot, legacy: corruptLegacy, store: corrupt} = legacyInstall();
  await corrupt.update(keep, {now: T0});
  fs.writeFileSync(path.join(corruptRoot, 'ledger.v2', '2026-09-09.json'), '[{"broken":true}]', {mode: 0o600});
  await assert.rejects(corrupt.update(keep, {now: new Date(T0.getTime() + 30 * DAY_MS)}));
  await assert.rejects(corrupt.update(keep, {now: new Date(T0.getTime() + 30 * DAY_MS), purgeRollback: true}));
  assert.equal(fs.existsSync(corruptLegacy), true);
});

test('a purge deletes the rollback copy at once, even before the new store existed', async () => {
  const {root, legacy, store} = legacyInstall();
  assert.equal(fs.existsSync(path.join(root, 'ledger.v2')), false);
  await store.update((current) => ({...current, detail: [], purgedBefore: T0.toISOString()}), {now: T0, purgeRollback: true});
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.existsSync(path.join(root, 'ledger.v2', 'state.json')), true);
  assert.equal((await store.read()).detail.length, 0);
});

test('a purge whose read-back fails keeps the rollback copy', async () => {
  const {legacy, store} = legacyInstall();
  const originalRead = store.read.bind(store);
  let reads = 0;
  store.read = async () => {
    reads += 1;
    if (reads > 1) throw new Error('invalid ledger state');
    return originalRead();
  };
  await assert.rejects(store.update((current) => ({...current, detail: []}), {now: T0, purgeRollback: true}));
  assert.equal(fs.existsSync(legacy), true);
});

test('an update cannot forge or clear the rollback confirmation date', async () => {
  const {root, store} = legacyInstall();
  await store.update(keep, {now: T0});
  await store.update((current) => ({...current, rollbackConfirmedAt: '2000-01-01T00:00:00.000Z'}), {now: T0});
  assert.equal(stateOf(root).rollbackConfirmedAt, T0.toISOString());
  await store.update((current) => ({...current, rollbackConfirmedAt: null}), {now: T0});
  assert.equal(stateOf(root).rollbackConfirmedAt, T0.toISOString());
});

test('an install with no rollback copy needs no confirmation date', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-rollback-fresh-'));
  const store = new PartitionedStore(root);
  await store.update(keep, {now: T0});
  assert.equal(stateOf(root).rollbackConfirmedAt ?? null, null);
});

test('a linked rollback copy is skipped, never followed and never deleted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-rollback-link-'));
  const legacy = path.join(root, 'ledger.v1.json');
  const target = path.join(root, 'outside.json');
  fs.writeFileSync(target, JSON.stringify({detail: [], daily: {}, checkpoints: {}}));
  fs.symlinkSync(target, legacy);
  const store = new PartitionedStore(root);
  // The ledger still opens, rather than failing for good.
  assert.deepEqual((await store.read()).detail, []);
  await store.update((current) => ({...current, detail: []}), {now: T0});
  assert.equal(fs.existsSync(path.join(root, 'ledger.v2', 'state.json')), true);
  // Neither the link nor its target is ever removed, at any age.
  await store.update(keep, {now: new Date(T0.getTime() + 60 * DAY_MS)});
  assert.equal(fs.lstatSync(legacy).isSymbolicLink(), true);
  assert.equal(fs.existsSync(target), true);
});

test('a corrupt rollback copy fails closed rather than appearing to lose history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-rollback-corrupt-'));
  const legacy = path.join(root, 'ledger.v1.json');
  fs.writeFileSync(legacy, 'not json at all', {mode: 0o600});
  const store = new PartitionedStore(root);
  await assert.rejects(store.read());
  await assert.rejects(store.update(keep, {now: T0}));
  assert.equal(fs.existsSync(path.join(root, 'ledger.v2')), false, 'no empty store is written over it');
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'not json at all');
});
