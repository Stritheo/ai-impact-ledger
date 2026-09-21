'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Version 0.2.1 writes state.json with exactly these three fields, dropping
// the basis stamp. Rewriting the file that way is how these tests stand in for
// an older version running in another window.
function stripStamp(statePath) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  fs.writeFileSync(statePath,
    JSON.stringify({daily: state.daily, checkpoints: state.checkpoints, purgedBefore: state.purgedBefore ?? null}));
}

function claudeRecord(id, timestamp) {
  return JSON.stringify({type: 'assistant', requestId: id, timestamp,
    message: {model: 'claude-sonnet-5', usage: {input_tokens: 10, output_tokens: 2}}});
}

async function withExtension(body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-downgrade-'));
  const storage = path.join(home, 'extension-storage');
  const logs = path.join(home, '.claude', 'projects');
  fs.mkdirSync(logs, {recursive: true});
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), {recursive: true});
  const log = path.join(logs, 'session.jsonl');
  fs.writeFileSync(log, claudeRecord('r1', new Date().toISOString()) + '\n');
  const status = {show() {}, dispose() {}, text: '', tooltip: ''};
  const commands = new Map();
  const panels = [];
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
      createWebviewPanel: () => { const panel = {webview: {html: ''}, onDidDispose: () => ({dispose() {}})}; panels.push(panel); return panel; },
      showWarningMessage: async () => undefined,
      showInformationMessage: () => {}
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
    await body({status, commands, panels, log, statePath: path.join(storage, 'ledger.v2', 'state.json')});
  } finally {
    for (const item of context.subscriptions) item.dispose?.();
    require('../src/extension').deactivate();
    Module._load = originalLoad;
    os.homedir = originalHome;
  }
}

test('a refresh pauses, and writes nothing, once an older version has stripped the basis stamp', async () => {
  await withExtension(async ({status, commands, log, statePath}) => {
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).basisVersion, 2, 'this version stamps the state');
    stripStamp(statePath);
    const afterStrip = fs.readFileSync(statePath, 'utf8');
    // New work that a normal refresh would record, so a store left untouched
    // proves the pause rather than an idle scan.
    fs.appendFileSync(log, claudeRecord('r2', new Date().toISOString()) + '\n');
    await commands.get('aiImpactLedger.refresh')();
    assert.match(status.text, /older version/);
    assert.match(status.tooltip, /Reload/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), afterStrip, 'a paused session writes nothing');
  });
});

test('the pause holds for the session, because the other window is still running', async () => {
  await withExtension(async ({status, commands, statePath}) => {
    stripStamp(statePath);
    await commands.get('aiImpactLedger.refresh')();
    assert.match(status.text, /older version/);
    // A later refresh must not present the stale figures as current again.
    await commands.get('aiImpactLedger.refresh')();
    assert.match(status.text, /older version/);
  });
});

test('the open report says counting is paused and how to fix it', async () => {
  await withExtension(async ({commands, panels, statePath}) => {
    await commands.get('aiImpactLedger.showReport')();
    const [panel] = panels;
    assert.doesNotMatch(panel.webview.html, /paused/i);
    stripStamp(statePath);
    await commands.get('aiImpactLedger.refresh')();
    assert.match(panel.webview.html, /Counting is paused/);
    assert.match(panel.webview.html, /older version/);
    assert.match(panel.webview.html, /Rebuild From Logs/);
  });
});
