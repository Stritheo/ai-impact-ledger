'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const CURRENT_BASIS = 2;

function fakeVscode(state, capture) {
  return {
    StatusBarAlignment: {Right: 2},
    ViewColumn: {Beside: 2},
    workspace: {getConfiguration: () => ({get: (key, fallback) => state[key] ?? fallback})},
    commands: {
      registerCommand: (name, callback) => { capture.commands.set(name, callback); return {dispose() {}}; },
      executeCommand: async () => {}
    },
    window: {
      createStatusBarItem: () => capture.status,
      createWebviewPanel: () => ({webview: {html: ''}}),
      showWarningMessage: async (message) => { capture.warnings.push(message); return undefined; },
      showInformationMessage: (message) => capture.notices.push(message)
    }
  };
}

async function activateWith({home, storage, settings = {}}) {
  const capture = {commands: new Map(), warnings: [], notices: [], status: {show() {}, dispose() {}, text: '', tooltip: ''}};
  const originalHome = os.homedir;
  const originalLoad = Module._load;
  os.homedir = () => home;
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? fakeVscode(settings, capture) : originalLoad.call(this, request, parent, isMain);
  };
  const globalState = new Map();
  try {
    delete require.cache[require.resolve('../src/extension')];
    const extension = require('../src/extension');
    await extension.activate({
      subscriptions: [],
      globalStorageUri: {fsPath: storage},
      globalState: {
        get: (key, fallback) => globalState.has(key) ? globalState.get(key) : fallback,
        update: async (key, value) => value === undefined ? globalState.delete(key) : globalState.set(key, value)
      }
    });
    extension.deactivate();
  } finally {
    Module._load = originalLoad;
    os.homedir = originalHome;
  }
  return capture;
}

function seedCodexLog(home, turnId, responses) {
  const sessions = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(sessions, {recursive: true});
  const timestamp = new Date().toISOString();
  const lines = [JSON.stringify({type: 'turn_context', timestamp, payload: {turn_id: turnId, model: 'gpt-5.6-terra'}})];
  for (const [index, tokens] of responses.entries()) {
    lines.push(JSON.stringify({type: 'token_usage_record', timestamp, payload: {turn_id: turnId,
      response_id: `resp_${index}`, usage: {input_tokens: tokens, cached_input_tokens: 0,
        cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0}}}));
  }
  fs.writeFileSync(path.join(sessions, 'rollout.jsonl'), lines.join('\n'));
  return timestamp.slice(0, 10);
}

test('a ledger written under the old basis is rebuilt, not added to', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-migration-'));
  const storage = path.join(home, 'storage');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), {recursive: true});
  const day = seedCodexLog(home, 'turn-1', [10_000, 11_000, 12_000]);

  // A store written by the previous release: one turn, its largest response only.
  const version2 = path.join(storage, 'ledger.v2');
  fs.mkdirSync(version2, {recursive: true});
  fs.writeFileSync(path.join(version2, 'state.json'), JSON.stringify({
    daily: {[`${day}|openai|gpt-5.6-terra`]: {date: day, provider: 'openai', model: 'gpt-5.6-terra',
      calls: 1, input: 12_000, cachedInput: 0, cacheWrite: 0, output: 10, reasoningOutput: 0}},
    checkpoints: {}, purgedBefore: null
  }));

  await activateWith({home, storage});

  const state = JSON.parse(fs.readFileSync(path.join(version2, 'state.json'), 'utf8'));
  const row = state.daily[`${day}|openai|gpt-5.6-terra`];
  assert.equal(row.calls, 3, 'the day is recomputed from the corrected parse');
  assert.equal(row.input, 33_000, 'the old undercounted row must not be added to the corrected one');
  assert.equal(row.output, 30);
  assert.equal(state.basisVersion, CURRENT_BASIS, 'the store records which basis produced it');
});

test('a day the logs no longer cover keeps its earlier figures, marked as such', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-migration-'));
  const storage = path.join(home, 'storage');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), {recursive: true});
  const day = seedCodexLog(home, 'turn-1', [10_000]);

  const version2 = path.join(storage, 'ledger.v2');
  fs.mkdirSync(version2, {recursive: true});
  fs.writeFileSync(path.join(version2, 'state.json'), JSON.stringify({
    daily: {'2026-01-01|openai|gpt-5.6-terra': {date: '2026-01-01', provider: 'openai', model: 'gpt-5.6-terra',
      calls: 9, input: 900, cachedInput: 0, cacheWrite: 0, output: 9, reasoningOutput: 0}},
    checkpoints: {}, purgedBefore: null
  }));

  await activateWith({home, storage});

  const state = JSON.parse(fs.readFileSync(path.join(version2, 'state.json'), 'utf8'));
  assert.equal(state.daily['2026-01-01|openai|gpt-5.6-terra'].calls, 9);
  assert.equal(state.daily['2026-01-01|openai|gpt-5.6-terra'].preCorrection, true);
  assert.ok(state.daily[`${day}|openai|gpt-5.6-terra`], 'the covered day is still rebuilt');
});

test('a rebuild cannot resurrect purged detail', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-migration-'));
  const storage = path.join(home, 'storage');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), {recursive: true});
  seedCodexLog(home, 'turn-1', [10_000]);

  const version2 = path.join(storage, 'ledger.v2');
  fs.mkdirSync(version2, {recursive: true});
  fs.writeFileSync(path.join(version2, 'state.json'), JSON.stringify({
    daily: {}, checkpoints: {}, purgedBefore: new Date(Date.now() + 60_000).toISOString()
  }));

  await activateWith({home, storage});

  const partitions = fs.readdirSync(version2).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name));
  const detail = partitions.flatMap((name) => JSON.parse(fs.readFileSync(path.join(version2, name), 'utf8')));
  assert.equal(detail.length, 0, 'records older than the purge watermark stay deleted');
});

test('the status bar states no cost rather than a currency zero when nothing can be priced', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-unpriced-'));
  const storage = path.join(home, 'storage');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), {recursive: true});
  const sessions = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(sessions, {recursive: true});
  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(sessions, 'rollout.jsonl'), [
    JSON.stringify({type: 'turn_context', timestamp, payload: {turn_id: 't1', model: 'codex-auto-review'}}),
    JSON.stringify({type: 'token_usage_record', timestamp, payload: {turn_id: 't1', response_id: 'r1',
      usage: {input_tokens: 5_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 50,
        reasoning_output_tokens: 0}}})
  ].join('\n'));

  const capture = await activateWith({home, storage});

  assert.doesNotMatch(capture.status.text, /\$0\.00/, 'an unpriced period must not read as zero cost');
  assert.match(capture.status.text, /No reference price|Not available/i);
});
