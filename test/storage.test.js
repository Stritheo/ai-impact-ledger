'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {LocalStore} = require('../src/core/storage');

test('local store writes only to its fixed private file and round-trips valid data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-store-'));
  const store = new LocalStore(root);
  const value = {detail: [], daily: {}, checkpoints: {openai: {['a'.repeat(64)]: '1:2'}}};

  await store.write(value);

  assert.deepEqual(await store.read(), value);
  assert.equal(fs.statSync(path.join(root, 'ledger.v1.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(root), ['ledger.v1.json']);
});

test('local store rejects malformed persisted shapes without executing or trusting them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-store-'));
  fs.mkdirSync(root, {recursive: true});
  fs.writeFileSync(path.join(root, 'ledger.v1.json'), JSON.stringify({detail: 'not-an-array'}));

  const store = new LocalStore(root);
  assert.deepEqual(await store.read(), {detail: [], daily: {}, checkpoints: {}});
});

test('local store strips unexpected content from otherwise valid persisted records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-store-'));
  const store = new LocalStore(root);
  await store.write({
    detail: [{id: 'abc', provider: 'openai', model: 'terra', timestamp: '2026-09-12T00:00:00Z', tokens: {input: 2}, prompt: 'do not retain me'}],
    daily: {'../../escape': {date: 'bad', prompt: 'secret'}},
    checkpoints: {openai: {'../../private': 'payload'}}
  });

  const saved = await store.read();
  assert.equal('prompt' in saved.detail[0], false);
  assert.deepEqual(saved.daily, {});
  assert.deepEqual(saved.checkpoints, {openai: {}});
});

test('local store never follows a symbolic link presented as its data file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-store-'));
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'impact-store-outside-')), 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({detail: [{prompt: 'secret'}], daily: {}, checkpoints: {}}));
  fs.symlinkSync(outside, path.join(root, 'ledger.v1.json'));

  const store = new LocalStore(root);
  assert.deepEqual(await store.read(), {detail: [], daily: {}, checkpoints: {}});
});

test('simultaneous window updates do not overwrite one another', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-store-'));
  const stores = Array.from({length: 12}, () => new LocalStore(root));

  await Promise.all(stores.map((store, index) => store.update((current) => ({
    ...current,
    daily: {...current.daily, [`2026-09-${String(index + 1).padStart(2, '0')}|openai|terra`]: {
      date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      provider: 'openai', model: 'terra', calls: 1, input: 1, cachedInput: 0, cacheWrite: 0, output: 1, reasoningOutput: 0
    }}
  }))));

  assert.equal(Object.keys((await stores[0].read()).daily).length, 12);
});
