'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const {PartitionedStore} = require('../src/core/storage');
const {scanRoot} = require('../src/core/scanner');
const {hashEventId} = require('../src/core/security');

function homeWithOneClaudeCall() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-secret-'));
  const project = path.join(home, '.claude', 'projects', 'project');
  fs.mkdirSync(project, {recursive: true});
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), {recursive: true});
  fs.writeFileSync(path.join(project, 'session.jsonl'), `${JSON.stringify({
    type: 'assistant', requestId: 'req_race', timestamp: new Date(Date.now() - 60_000).toISOString(),
    message: {model: 'claude-opus-5', usage: {input_tokens: 3, output_tokens: 5}}
  })}\n`);
  return {home, storage: path.join(home, 'extension-storage')};
}

function windowState(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); }
  };
}

// Each VS Code window keeps its own in-memory copy of global state, so two
// windows starting together do not see each other's writes.
async function activateWindows(home, storage, states) {
  const originalHome = os.homedir;
  const originalLoad = Module._load;
  const statuses = states.map(() => ({show() {}, dispose() {}, text: '', tooltip: ''}));
  let index = 0;
  const vscode = {
    StatusBarAlignment: {Right: 2},
    ViewColumn: {Beside: 2},
    workspace: {getConfiguration: () => ({get: (_key, fallback) => fallback})},
    commands: {registerCommand: () => ({dispose() {}}), executeCommand: async () => {}},
    window: {
      createStatusBarItem: () => statuses[index++],
      createWebviewPanel: () => ({webview: {html: ''}}),
      showWarningMessage: async () => undefined,
      showInformationMessage: () => {}
    }
  };
  os.homedir = () => home;
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../src/extension')];
    const extension = require('../src/extension');
    const contexts = states.map((globalState) => ({subscriptions: [], globalStorageUri: {fsPath: storage}, globalState}));
    await Promise.all(contexts.map((context) => extension.activate(context)));
    for (const context of contexts) for (const item of context.subscriptions) item.dispose?.();
    extension.deactivate();
  } finally {
    Module._load = originalLoad;
    os.homedir = originalHome;
  }
  return statuses;
}

test('two windows activating together record one call once', async () => {
  const {home, storage} = homeWithOneClaudeCall();
  // An installed ledger on the current basis. Without it both windows take the
  // rebuild path, where the last writer replaces the store and hides the race.
  await new PartitionedStore(storage).update(() => ({detail: [], daily: {}, checkpoints: {}, basisVersion: 2}));
  const first = windowState();
  const second = windowState();
  await activateWindows(home, storage, [first, second]);
  const {detail} = await new PartitionedStore(storage).read();
  assert.equal(detail.length, 1, 'both windows must hash the same call to the same identifier');
  const secretFile = path.join(storage, 'hash-secret');
  assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
  const secret = fs.readFileSync(secretFile, 'utf8');
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.equal(first.values.get('localHashSecret.v1'), secret);
  assert.equal(second.values.get('localHashSecret.v1'), secret);
});

test('an existing install keeps its hashing secret, so upgrading does not double count', async () => {
  const {home, storage} = homeWithOneClaudeCall();
  const existing = crypto.randomBytes(32).toString('hex');
  // The ledger as the previous version left it: the call hashed with the
  // secret held in global state.
  const scanned = await scanRoot(path.join(home, '.claude', 'projects'), 'anthropic', {}, existing);
  assert.equal(scanned.events.length, 1);
  const event = {...scanned.events[0], id: hashEventId(scanned.events[0].id, existing)};
  await new PartitionedStore(storage).update(() => ({detail: [event], daily: {}, checkpoints: {}, basisVersion: 2}));

  // Windows load global state from the same persisted store, so on upgrade
  // every window starts with the existing secret.
  const upgraded = windowState({'localHashSecret.v1': existing});
  const other = windowState({'localHashSecret.v1': existing});
  await activateWindows(home, storage, [upgraded, other]);
  assert.equal(fs.readFileSync(path.join(storage, 'hash-secret'), 'utf8'), existing);
  const {detail} = await new PartitionedStore(storage).read();
  assert.equal(detail.length, 1);
  assert.equal(detail[0].id, event.id);
});

test('a hashing secret that is a link or malformed is refused rather than replaced', async () => {
  for (const plant of [
    (file) => { const target = `${file}.target`; fs.writeFileSync(target, 'a'.repeat(64)); fs.symlinkSync(target, file); },
    (file) => fs.writeFileSync(file, 'not-a-secret', {mode: 0o600})
  ]) {
    const {home, storage} = homeWithOneClaudeCall();
    fs.mkdirSync(storage, {recursive: true});
    const file = path.join(storage, 'hash-secret');
    plant(file);
    const [status] = await activateWindows(home, storage, [windowState()]);
    assert.match(status.text, /Impact unavailable/);
    assert.equal(fs.existsSync(path.join(storage, 'ledger.v2')), false, 'nothing is recorded under an unverified secret');
  }
});
