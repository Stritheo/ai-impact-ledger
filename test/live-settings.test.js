'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const fxRegistry = require('../src/data/fx-registry.v1.json');

async function withExtension(settings, body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-live-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), {recursive: true});
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), {recursive: true});
  const status = {show() {}, dispose() {}, text: '', tooltip: ''};
  const commands = new Map();
  const listeners = [];
  const counters = {refreshes: 0};
  const panels = [];
  const vscode = {
    StatusBarAlignment: {Right: 2},
    ViewColumn: {Beside: 2},
    workspace: {
      getConfiguration: () => ({get: (key, fallback) => {
        if (key === 'detailRetentionDays') counters.refreshes += 1;
        return settings[key] ?? fallback;
      }}),
      onDidChangeConfiguration: (listener) => { listeners.push(listener); return {dispose() {}}; }
    },
    commands: {registerCommand: (name, callback) => { commands.set(name, callback); return {dispose() {}}; }, executeCommand: async () => {}},
    window: {
      createStatusBarItem: () => status,
      createWebviewPanel: () => {
        const panel = {webview: {html: ''}, disposers: [],
          onDidDispose(listener) { this.disposers.push(listener); return {dispose() {}}; },
          close() { for (const listener of this.disposers) listener(); }};
        panels.push(panel);
        return panel;
      },
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
  const context = {subscriptions: [], globalStorageUri: {fsPath: path.join(home, 'storage')},
    globalState: {values: new Map(), get(key, fallback) { return this.values.has(key) ? this.values.get(key) : fallback; },
      async update(key, value) { if (value === undefined) this.values.delete(key); else this.values.set(key, value); }}};
  try {
    delete require.cache[require.resolve('../src/extension')];
    const extension = require('../src/extension');
    await extension.activate(context);
    const change = (key) => Promise.all(listeners.map((listener) =>
      listener({affectsConfiguration: (section) => section === key || key.startsWith(`${section}.`)})));
    await body({status, commands, counters, change, panels});
  } finally {
    for (const item of context.subscriptions) item.dispose?.();
    require('../src/extension').deactivate();
    Module._load = originalLoad;
    os.homedir = originalHome;
  }
}

test('evidence overdue appears without a reload, even when nothing else has changed', async (t) => {
  const originalZone = process.env.TZ;
  // Both instants fall on 12 October in Sydney, so the second refresh takes
  // the unchanged-data shortcut; the review date passes between them in UTC.
  process.env.TZ = 'Australia/Sydney';
  const due = Date.parse(`${fxRegistry.nextReviewDue}T00:00:00Z`);
  t.mock.timers.enable({apis: ['Date'], now: due + 86_400_000 - 3_600_000});
  try {
    await withExtension({}, async ({status, commands}) => {
      assert.match(status.text, /^\$\(pulse\)/);
      assert.doesNotMatch(status.tooltip, /Evidence review overdue/);
      t.mock.timers.setTime(due + 86_400_000 + 1_800_000);
      await commands.get('aiImpactLedger.refresh')();
      assert.match(status.text, /^\$\(warning\)/);
      assert.match(status.tooltip, /Evidence review overdue: FX/);
    });
  } finally {
    if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone;
  }
});

test('a changed refresh interval takes effect without a reload', async (t) => {
  t.mock.timers.enable({apis: ['setInterval']});
  const settings = {refreshMinutes: 5};
  await withExtension(settings, async ({status, commands, counters, change}) => {
    // Scheduled refreshes can still be running when a test restores the real
    // home directory, so the log roots must be fixed at activation.
    const homedir = os.homedir;
    os.homedir = () => { throw new Error('home directory read after activation'); };
    t.after(() => { os.homedir = homedir; });
    const afterActivation = counters.refreshes;
    t.mock.timers.tick(5 * 60_000);
    assert.equal(counters.refreshes, afterActivation + 1, 'the configured five-minute interval applies');

    settings.refreshMinutes = 1;
    change('aiImpactLedger.refreshMinutes');
    t.mock.timers.tick(60_000);
    assert.equal(counters.refreshes, afterActivation + 2, 'the new one-minute interval applies at once');
    t.mock.timers.tick(4 * 60_000);
    assert.equal(counters.refreshes, afterActivation + 6, 'the old five-minute timer no longer fires');

    // A change to another setting refreshes once, at once, and leaves the
    // interval alone; an invalid interval falls back to the default rather
    // than scanning continuously.
    change('aiImpactLedger.currency');
    assert.equal(counters.refreshes, afterActivation + 7, 'another setting refreshes immediately');
    t.mock.timers.tick(60_000);
    assert.equal(counters.refreshes, afterActivation + 8, 'and the one-minute timer is undisturbed');
    settings.refreshMinutes = 0;
    change('aiImpactLedger.refreshMinutes');
    t.mock.timers.tick(60_000);
    assert.equal(counters.refreshes, afterActivation + 9, 'zero is clamped to the one-minute minimum');
    settings.refreshMinutes = 'often';
    change('aiImpactLedger.refreshMinutes');
    t.mock.timers.tick(4 * 60_000);
    assert.equal(counters.refreshes, afterActivation + 9);
    t.mock.timers.tick(60_000);
    assert.equal(counters.refreshes, afterActivation + 10, 'a non-number falls back to five minutes');
    await commands.get('aiImpactLedger.refresh')();
    assert.doesNotMatch(status.text, /unavailable/);
    os.homedir = homedir;
  });
});

test('an open report follows a settings change without being reopened', async () => {
  const settings = {currency: 'USD', reportingPeriod: 'today'};
  await withExtension(settings, async ({commands, change, panels}) => {
    await commands.get('aiImpactLedger.showReport')();
    const [panel] = panels;
    assert.match(panel.webview.html, /US\$/);
    assert.match(panel.webview.html, /Today/i);

    settings.currency = 'AUD';
    await change('aiImpactLedger.currency');
    assert.match(panel.webview.html, /A\$/, 'the open report is redrawn in the new currency');
    assert.doesNotMatch(panel.webview.html, /US\$/);

    settings.reportingPeriod = '30d';
    await change('aiImpactLedger.reportingPeriod');
    assert.doesNotMatch(panel.webview.html, /Today/i, 'the open report is redrawn for the new period');
  });
});

test('an open report follows a refresh, and a closed one is left alone', async () => {
  const settings = {currency: 'USD'};
  await withExtension(settings, async ({commands, panels}) => {
    await commands.get('aiImpactLedger.showReport')();
    const [panel] = panels;
    // A refresh, a purge and the timer all end in the same place: whatever the
    // report shows must be what was just computed.
    panel.webview.html = 'out of date';
    await commands.get('aiImpactLedger.refresh')();
    assert.match(panel.webview.html, /AI Impact Ledger/, 'a refresh redraws the open report');

    panel.close();
    panel.webview.html = 'closed';
    await commands.get('aiImpactLedger.refresh')();
    assert.equal(panel.webview.html, 'closed', 'a closed report is never written to');
  });
});

test('a refresh with nothing new keeps the full status bar tooltip', async () => {
  await withExtension({}, async ({status, commands}) => {
    const full = status.tooltip;
    assert.match(full, /excluding the energy of re-reading cached context/);
    // The second refresh finds no new data and takes the unchanged-data
    // shortcut, which must not shorten what the tooltip discloses.
    await commands.get('aiImpactLedger.refresh')();
    assert.equal(status.tooltip, full);
  });
});
