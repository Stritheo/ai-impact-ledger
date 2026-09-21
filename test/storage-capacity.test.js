'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const storage = require('../src/core/storage');
const {updateDaily, aggregateByDay} = require('../src/core/ledger');

const {PartitionedStore} = storage;

function event(index, timestamp) {
  return {id: index.toString(16).padStart(64, '0'), provider: 'openai', model: 'gpt-5.6-terra', timestamp,
    tokens: {input: 100 + index, cachedInput: 0, cacheWrite: 0, output: 10, reasoningOutput: 0}, inferenceGeo: null};
}

function spread(count, days, from = Date.parse('2026-09-01T06:00:00Z')) {
  return Array.from({length: count}, (_, index) =>
    event(index, new Date(from + Math.floor(index * days / count) * 86_400_000 + index * 1000).toISOString()));
}

function bytesOnDisk(root) {
  const directory = path.join(root, 'ledger.v2');
  return fs.readdirSync(directory).reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0);
}

function sumCalls(daily) {
  return Object.values(daily).reduce((sum, row) => sum + row.calls, 0);
}

test('recording continues past the storage cap: the oldest detail is trimmed and its totals are kept', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-capacity-'));
  const cap = 8000;
  const store = new PartitionedStore(root, cap);
  const history = spread(12, 4);
  await store.update(() => ({detail: history, daily: updateDaily({}, [], history), checkpoints: {}, basisVersion: 2}));
  // A new day arrives whose daily totals the caller has not yet folded in:
  // the case in which trimming could silently lose calls.
  const arriving = spread(20, 1, Date.parse('2026-09-06T06:00:00Z')).map((item, index) => ({...item, id: `f${index.toString(16).padStart(63, '0')}`}));
  const saved = await store.update((current) => ({...current, detail: [...current.detail, ...arriving]}));

  assert.ok(bytesOnDisk(root) <= cap * 0.9, `stored ${bytesOnDisk(root)} bytes against a ${cap} byte cap`);
  assert.ok(saved.detail.length < history.length + arriving.length, 'some detail must have been trimmed');
  assert.ok(saved.trimmedBefore, 'the trim is recorded');
  const kept = new Set(saved.detail.map((item) => item.id));
  const dropped = [...history, ...arriving].filter((item) => !kept.has(item.id));
  for (const item of dropped) assert.ok(item.timestamp <= saved.trimmedBefore, 'only records at or before the cut-off are trimmed');
  for (const item of saved.detail) assert.ok(item.timestamp > saved.trimmedBefore, 'every retained record is after the cut-off');
  for (const [key, row] of Object.entries(aggregateByDay(dropped))) {
    assert.ok(saved.daily[key]?.calls >= row.calls, `daily totals for ${key} must cover the trimmed calls`);
    assert.ok(saved.daily[key]?.input >= row.input);
  }
  assert.equal(sumCalls(saved.daily), history.length + dropped.filter((item) => item.id.startsWith('f')).length);

  const reread = await store.read();
  assert.equal(reread.trimmedBefore, saved.trimmedBefore);
  // A later update cannot move the cut-off backwards.
  await store.update((current) => ({...current, trimmedBefore: null}));
  assert.equal((await store.read()).trimmedBefore, saved.trimmedBefore);
});

test('a store already over the cap on disk is still readable and is brought back under it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-capacity-over-'));
  const history = spread(40, 8);
  await new PartitionedStore(root).update(() => ({detail: history, daily: updateDaily({}, [], history), checkpoints: {}, basisVersion: 2}));
  const cap = Math.floor(bytesOnDisk(root) / 2);
  const small = new PartitionedStore(root, cap);
  const current = await small.read();
  assert.ok(current.detail.length > 0 && current.detail.length < history.length);
  assert.ok(current.trimmedBefore);
  const newest = history.at(-1).id;
  assert.ok(current.detail.some((item) => item.id === newest), 'the newest detail is the detail kept');
  await small.update((value) => value);
  assert.ok(bytesOnDisk(root) <= cap * 0.9);
  assert.equal(sumCalls((await small.read()).daily), history.length);
});

function claudeLine(requestId, timestamp) {
  return JSON.stringify({type: 'assistant', requestId, timestamp,
    message: {model: 'claude-opus-5', usage: {input_tokens: 5, output_tokens: 7}}});
}

test('after a trim, a changed log file does not count its older calls a second time', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-capacity-ext-'));
  const project = path.join(home, '.claude', 'projects', 'project');
  fs.mkdirSync(project, {recursive: true});
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), {recursive: true});
  const log = path.join(project, 'session.jsonl');
  const start = Date.now() - 6 * 86_400_000;
  const lines = Array.from({length: 40}, (_, index) =>
    claudeLine(`req_${index}`, new Date(start + index * 3 * 3_600_000).toISOString()));
  fs.writeFileSync(log, `${lines.join('\n')}\n`);

  const status = {show() {}, dispose() {}, text: '', tooltip: ''};
  const commands = new Map();
  let panel;
  const warnings = [];
  const vscode = {
    StatusBarAlignment: {Right: 2},
    ViewColumn: {Beside: 2},
    workspace: {getConfiguration: () => ({get: (key, fallback) => ({reportingPeriod: 'cumulative'})[key] ?? fallback})},
    commands: {registerCommand: (name, callback) => { commands.set(name, callback); return {dispose() {}}; }, executeCommand: async () => {}},
    window: {
      createStatusBarItem: () => status,
      createWebviewPanel: () => (panel = {webview: {html: ''}}),
      showWarningMessage: async (message) => { warnings.push(message); },
      showInformationMessage: () => {}
    }
  };
  const OriginalStore = storage.PartitionedStore;
  const originalHome = os.homedir;
  const originalLoad = Module._load;
  storage.PartitionedStore = class extends OriginalStore {
    constructor(root) { super(root, 9000); }
  };
  os.homedir = () => home;
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  const context = {subscriptions: [], globalStorageUri: {fsPath: path.join(home, 'storage')},
    globalState: {values: new Map(), get(key, fallback) { return this.values.has(key) ? this.values.get(key) : fallback; },
      async update(key, value) { if (value === undefined) this.values.delete(key); else this.values.set(key, value); }}};
  try {
    delete require.cache[require.resolve('../src/extension')];
    const extension = require('../src/extension');
    await extension.activate(context);
    const reader = new OriginalStore(context.globalStorageUri.fsPath);
    const first = await reader.read();
    assert.ok(first.trimmedBefore, 'the fixture must force a trim');
    assert.ok(first.detail.length < lines.length);
    assert.equal(sumCalls(first.daily), lines.length);

    // The log changes, so the scanner re-reads it and re-emits every call in it.
    fs.appendFileSync(log, `${claudeLine('req_new', new Date().toISOString())}\n`);
    await commands.get('aiImpactLedger.refresh')();
    const second = await reader.read();
    assert.equal(sumCalls(second.daily), lines.length + 1, 'only the new call is added');

    await commands.get('aiImpactLedger.showReport')();
    assert.match(panel.webview.html, /(\d+) model calls/);
    assert.equal(Number(panel.webview.html.match(/([\d,]+) model calls/)[1].replace(/,/g, '')), lines.length + 1);
    assert.match(panel.webview.html, /storage limit/);
    assert.ok(warnings.every((message) => !/preserved/.test(message)));
  } finally {
    for (const item of context.subscriptions) item.dispose?.();
    require('../src/extension').deactivate();
    storage.PartitionedStore = OriginalStore;
    Module._load = originalLoad;
    os.homedir = originalHome;
    delete require.cache[require.resolve('../src/extension')];
  }
});
