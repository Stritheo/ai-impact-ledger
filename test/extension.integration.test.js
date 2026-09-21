'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('extension activates locally with empty provider roots and registers its commands', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-extension-'));
  const storage = path.join(home, 'extension-storage');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), {recursive: true});
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), {recursive: true});
  os.homedir = () => home;

  const commands = new Map();
  const status = {show() {}, dispose() {}};
  const state = new Map([
    ['detail.v1', [{id: 'legacy', timestamp: new Date().toISOString(), provider: 'openai', model: 'unknown', tokens: {input: 1, output: 1}}]],
    ['daily.v1', {}],
    ['scanCheckpoints.v1', {}]
  ]);
  let reportPanel;
  let reportOptions;
  const executed = [];
  const warnings = [];
  const notices = [];
  let warningAnswer;
  const fakeVscode = {
    StatusBarAlignment: {Right: 2},
    ViewColumn: {Beside: 2},
    workspace: {getConfiguration: () => ({get: (key, fallback) => ({currency: 'AUD', waterUnits: 'us', reportingPeriod: '7d', showAnalogy: false})[key] ?? fallback})},
    commands: {registerCommand: (name, callback) => { commands.set(name, callback); return {dispose() {}}; }, executeCommand: async (...args) => executed.push(args)},
    window: {
      createStatusBarItem: () => status,
      createWebviewPanel: (_viewType, _title, _column, options) => {
        reportOptions = options;
        return (reportPanel = {webview: {html: ''}});
      },
      showWarningMessage: async (message) => {warnings.push(message); return warningAnswer;},
      showInformationMessage: (message) => notices.push(message)
    }
  };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    return request === 'vscode' ? fakeVscode : originalLoad.call(this, request, parent, isMain);
  };
  try {
    const extension = require('../src/extension');
    const context = {
      subscriptions: [],
      globalStorageUri: {fsPath: storage},
      globalState: {
        get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
        update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value)
      }
    };
    await extension.activate(context);
    // The only recorded call has no reference price, so the status bar must not
    // present the period as having cost nothing.
    assert.match(status.text, /^\$\(pulse\) No reference price/);
    assert.doesNotMatch(status.text, /A\$0\.00/);
    assert.equal(state.has('detail.v1'), false, 'bulk detail must not use VS Code global state');
    assert.equal(state.has('daily.v1'), false, 'bulk aggregates must not use VS Code global state');
    assert.equal(state.has('scanCheckpoints.v1'), false, 'bulk checkpoints must not use VS Code global state');
    // Detail held under the previous counting basis is not re-stored: its event
    // identifiers no longer mean anything. What it counted is folded into the
    // daily totals instead, marked as recorded before the correction.
    const statePath = path.join(storage, 'ledger.v2', 'state.json');
    assert.equal(fs.existsSync(statePath), true);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    const today = new Date().toISOString().slice(0, 10);
    const carried = JSON.parse(fs.readFileSync(statePath, 'utf8')).daily[`${today}|openai|unknown`];
    assert.equal(carried.calls, 1);
    assert.equal(carried.preCorrection, true);
    const partition = path.join(storage, 'ledger.v2', `${today}.json`);
    const originalRead = fs.promises.readFile;
    let warmPartitionReads = 0;
    fs.promises.readFile = async (...args) => {
      if (String(args[0]) === partition) warmPartitionReads += 1;
      return originalRead.apply(fs.promises, args);
    };
    try { await commands.get('aiImpactLedger.refresh')(); }
    finally { fs.promises.readFile = originalRead; }
    assert.equal(warmPartitionReads, 0, 'unchanged refresh should not read retained detail');
    await commands.get('aiImpactLedger.showReport')();
    assert.equal(reportOptions.enableScripts, false);
    assert.deepEqual(reportOptions.enableCommandUris, ['aiImpactLedger.openSettings']);
    assert.deepEqual(reportOptions.localResourceRoots, []);
    assert.match(reportPanel.webview.html, /Not available/);
    assert.match(reportPanel.webview.html, /no reference price/);
    assert.match(reportPanel.webview.html, /US gal/);
    assert.doesNotMatch(reportPanel.webview.html, /In everyday terms/);
    await commands.get('aiImpactLedger.openSettings')();
    assert.deepEqual(executed, [['workbench.action.openSettings', '@ext:stritheo.ai-impact-ledger']]);
    const oversized = path.join(home, '.claude', 'projects', 'oversized.jsonl');
    fs.writeFileSync(oversized, 'x');
    fs.truncateSync(oversized, 32 * 1024 * 1024 + 1);
    await commands.get('aiImpactLedger.refresh')();
    assert.match(status.text, /\$\(warning\)/);
    await commands.get('aiImpactLedger.showReport')();
    assert.match(reportPanel.webview.html, /1 log line skipped; totals may be incomplete/);
    const backup = path.join(storage, 'ledger.v1.json');
    fs.writeFileSync(backup, JSON.stringify({detail: [], daily: {}, checkpoints: {}}));
    warningAnswer = 'Delete detail';
    await commands.get('aiImpactLedger.purgeDetail')();
    // Changed with the approved rollback policy (release sprint plan, 17 September
    // 2026): a purge now deletes the v1 rollback copy at once, and the dialogue
    // must say so. The earlier assertion expected the copy to remain.
    assert.match(warnings.at(-1), /older rollback copy will also be deleted/);
    assert.match(notices.at(-1), /rollback copy deleted/);
    assert.equal(fs.existsSync(backup), false);
    assert.deepEqual([...commands.keys()].sort(), ['aiImpactLedger.openSettings', 'aiImpactLedger.purgeDetail', 'aiImpactLedger.rebuildFromLogs', 'aiImpactLedger.refresh', 'aiImpactLedger.showReport']);
    for (const disposable of context.subscriptions) disposable.dispose?.();
    extension.deactivate();
  } finally {
    require('../src/extension').deactivate();
    Module._load = originalLoad;
  }
});
