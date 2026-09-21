'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function claudeRecord(id, timestamp) {
  return JSON.stringify({type: 'assistant', requestId: id, timestamp,
    message: {model: 'claude-sonnet-5', usage: {input_tokens: 10, output_tokens: 2}}});
}

async function withExtension(body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-rebuild-'));
  const storage = path.join(home, 'extension-storage');
  const logs = path.join(home, '.claude', 'projects');
  fs.mkdirSync(logs, {recursive: true});
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), {recursive: true});
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(logs, 'session.jsonl'),
    claudeRecord('r1', now) + '\n' + claudeRecord('r2', now) + '\n');
  const status = {show() {}, dispose() {}, text: '', tooltip: ''};
  const commands = new Map();
  const answers = {warning: undefined};
  const notices = [];
  const vscode = {
    StatusBarAlignment: {Right: 2},
    ViewColumn: {Beside: 2},
    workspace: {
      getConfiguration: () => ({get: (key, fallback) => fallback}),
      onDidChangeConfiguration: () => ({dispose() {}})
    },
    commands: {registerCommand: (name, callback) => { commands.set(name, callback); return {dispose() {}}; },
      executeCommand: async () => {}},
    window: {
      createStatusBarItem: () => status,
      createWebviewPanel: () => ({webview: {html: ''}, onDidDispose: () => ({dispose() {}})}),
      showWarningMessage: async () => answers.warning,
      showInformationMessage: (message) => notices.push(message)
    }
  };
  const originalHome = os.homedir;
  const originalLoad = Module._load;
  os.homedir = () => home;
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  const context = {subscriptions: [], globalStorageUri: {fsPath: storage},
    globalState: {values: new Map(), get(key, fallback) { return this.values.has(key) ? this.values.get(key) : fallback; },
      async update(key, value) { if (value === undefined) this.values.delete(key); else this.values.set(key, value); }}};
  try {
    delete require.cache[require.resolve('../src/extension')];
    const extension = require('../src/extension');
    await extension.activate(context);
    await body({status, commands, answers, notices, statePath: path.join(storage, 'ledger.v2', 'state.json')});
  } finally {
    for (const item of context.subscriptions) item.dispose?.();
    require('../src/extension').deactivate();
    Module._load = originalLoad;
    os.homedir = originalHome;
  }
}

function dailyCalls(statePath) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return Object.values(state.daily).reduce((sum, row) => sum + row.calls, 0);
}

test('a rebuild replaces inflated totals with what the logs contain', async () => {
  await withExtension(async ({commands, answers, notices, statePath}) => {
    assert.equal(dailyCalls(statePath), 2);
    // Stand in for the corruption: the stored totals claim work the logs do
    // not contain, which is what an older version writing here produced.
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const row of Object.values(state.daily)) row.calls = 341_330;
    fs.writeFileSync(statePath, JSON.stringify(state));
    assert.equal(dailyCalls(statePath), 341_330);

    answers.warning = 'Rebuild';
    await commands.get('aiImpactLedger.rebuildFromLogs')();
    assert.equal(dailyCalls(statePath), 2, 'the totals now match the logs');
    assert.match(notices.at(-1), /rebuilt/i);
  });
});

test('a rebuild that is not confirmed changes nothing', async () => {
  await withExtension(async ({commands, answers, statePath}) => {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const row of Object.values(state.daily)) row.calls = 999;
    fs.writeFileSync(statePath, JSON.stringify(state));
    answers.warning = undefined;
    await commands.get('aiImpactLedger.rebuildFromLogs')();
    assert.equal(dailyCalls(statePath), 999, 'nothing is rebuilt without a yes');
  });
});

test('a rebuild does not restore detail a purge deleted', async () => {
  await withExtension(async ({commands, answers, statePath}) => {
    answers.warning = 'Delete detail';
    await commands.get('aiImpactLedger.purgeDetail')();
    const purgedBefore = JSON.parse(fs.readFileSync(statePath, 'utf8')).purgedBefore;
    assert.ok(purgedBefore, 'the purge records its watermark');

    answers.warning = 'Rebuild';
    await commands.get('aiImpactLedger.rebuildFromLogs')();
    const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(after.purgedBefore, purgedBefore, 'the purge watermark survives a rebuild');
    assert.equal(dailyCalls(statePath), 2, 'the daily totals are still rebuilt in full');
    const directory = path.dirname(statePath);
    const partitions = fs.readdirSync(directory).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name));
    const restored = partitions.flatMap((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
    assert.deepEqual(restored.filter((event) => event.timestamp <= purgedBefore), [],
      'no detailed record from before the purge comes back');
  });
});
