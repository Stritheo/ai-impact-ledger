'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {PartitionedStore, LocalStore} = require('../src/core/storage');

function storeWithLock(contents, ageMs, Store = PartitionedStore) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-lock-'));
  const store = new Store(root, undefined, {lockRetries: 5, lockWaitMs: 5});
  if (contents !== null) {
    fs.writeFileSync(store.lock, contents, {mode: 0o600});
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(store.lock, when, when);
  }
  return store;
}

function exitedPid() {
  const child = spawnSync(process.execPath, ['-e', ''], {stdio: 'ignore'});
  return child.pid;
}

const keep = (current) => current;
const holder = (token, pid) => JSON.stringify({token, pid});

test('a busy lock is never taken from a running holder, however old it is', async () => {
  const store = storeWithLock(holder('other-window', process.pid), 31_000);
  await assert.rejects(store.update(keep), /busy/);
  assert.equal(JSON.parse(fs.readFileSync(store.lock, 'utf8')).token, 'other-window');
});

test('a lock left by a holder that has exited is taken over once it is stale', async () => {
  const store = storeWithLock(holder('crashed-window', exitedPid()), 31_000);
  await store.update(keep);
  assert.equal(fs.existsSync(store.lock), false);
});

test('a recent lock is respected even when its holder has exited', async () => {
  const store = storeWithLock(holder('just-exited', exitedPid()), 1_000);
  await assert.rejects(store.update(keep), /busy/);
});

test('a stale lock left by an earlier version, with no holder recorded, is taken over', async () => {
  for (const contents of ['', 'not json']) {
    const store = storeWithLock(contents, 31_000);
    await store.update(keep);
    assert.equal(fs.existsSync(store.lock), false);
  }
  const young = storeWithLock('', 1_000);
  await assert.rejects(young.update(keep), /busy/);
});

test('release never removes another holder\'s lock', async () => {
  for (const Store of [PartitionedStore, LocalStore]) {
    const store = storeWithLock(null, 0, Store);
    await store.update(async (current) => {
      const own = JSON.parse(fs.readFileSync(store.lock, 'utf8'));
      assert.equal(own.pid, process.pid);
      assert.match(own.token, /^[a-f0-9-]{36}$/);
      // Another holder has replaced the lock while this update runs.
      fs.writeFileSync(store.lock, holder('intruder', process.pid));
      return current;
    });
    assert.equal(JSON.parse(fs.readFileSync(store.lock, 'utf8')).token, 'intruder');
  }
});

test('concurrent writers in one process still serialise through the lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-lock-many-'));
  const store = new PartitionedStore(root);
  let inside = 0;
  let overlapped = false;
  await Promise.all(Array.from({length: 10}, () => store.update(async (current) => {
    inside += 1;
    if (inside > 1) overlapped = true;
    await new Promise((resolve) => setTimeout(resolve, 2));
    inside -= 1;
    return current;
  })));
  assert.equal(overlapped, false);
  assert.equal(fs.existsSync(store.lock), false);
});

test('a lock is given up eventually, even if its recorded process id is reused', async () => {
  // A pid can be recycled by an unrelated process, which would otherwise hold
  // the ledger shut for good.
  const store = storeWithLock(holder('recycled-pid', process.pid), 11 * 60_000);
  await store.update(keep);
  assert.equal(fs.existsSync(store.lock), false);
  // Below the ceiling a live holder is still respected.
  const busy = storeWithLock(holder('live', process.pid), 9 * 60_000);
  await assert.rejects(busy.update(keep), /busy/);
});
