'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/data/impact-registry.v1.json');
const {estimateEvent, pricedAtStandardRates} = require('../src/core/estimate');
const {updateDaily} = require('../src/core/ledger');
const {buildSummary, reportHtml} = require('../src/core/report');

function codexCall(model, input, cachedInput = 0) {
  return {id: `${model}-${input}`, provider: 'openai', model, timestamp: '2026-09-10T03:00:00.000Z',
    tokens: {input: input - cachedInput, cachedInput, cacheWrite: 0, output: 1000, reasoningOutput: 0}, inferenceGeo: null};
}

// Corrected 18 September 2026: Astra's own model page states the same 272K
// rule. The earlier reading used the comparison page, which omits it, so this
// test previously asserted that Astra had no threshold.
test('the registry records the long-context threshold OpenAI states for every priced OpenAI model', () => {
  const byId = Object.fromEntries(registry.models.map((model) => [model.id, model]));
  for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra']) {
    assert.equal(byId[id].standardPriceMaxInputTokens, 272000, id);
  }
});

test('a Codex prompt above the long-context threshold is never priced at standard rates', () => {
  // The threshold counts the whole prompt, cached input included.
  const atLimit = codexCall('gpt-5.6-sol', 272000, 200000);
  const overLimit = codexCall('gpt-5.6-sol', 272001, 200000);
  const astra = codexCall('gpt-6-astra', 500000);
  assert.equal(pricedAtStandardRates(atLimit, registry), true);
  assert.equal(pricedAtStandardRates(overLimit, registry), false);
  assert.equal(pricedAtStandardRates(astra, registry), false, 'Astra states the same rule on its own page');
  assert.equal(estimateEvent(astra, registry).cost.central, null);
  assert.ok(estimateEvent(atLimit, registry).cost.central > 0);
  const over = estimateEvent(overLimit, registry);
  assert.equal(over.cost.central, null);
  assert.equal(over.cost.reason, 'non-standard-tier');
  assert.ok(over.energyWh.mid > 0);
});

test('a long-context call stays unpriced once only its daily total remains', () => {
  const small = codexCall('gpt-5.6-terra', 100000);
  const large = {...codexCall('gpt-5.6-terra', 300000), nonStandardTier: true};
  const daily = updateDaily({}, [], [small, large]);
  assert.equal(Object.keys(daily).length, 2);
  const summary = buildSummary([], registry, 'unknown',
    {settings: {period: 'cumulative'}, daily, now: new Date('2026-09-17T00:00:00Z'), timeZone: 'UTC'});
  assert.equal(summary.providers.openai.unpricedCalls, 1);
  assert.equal(summary.total.cost.central, estimateEvent(small, registry).cost.central);
  assert.match(reportHtml(summary), /1 at a price the reference rates do not cover/);
});

test('the extension flags a long-context Codex call as it is recorded', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const Module = require('node:module');
  const {PartitionedStore} = require('../src/core/storage');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-long-context-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), {recursive: true});
  const sessions = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(sessions, {recursive: true});
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  const usage = (input) => ({input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 10, reasoning_output_tokens: 0});
  fs.writeFileSync(path.join(sessions, 'rollout.jsonl'), [
    {type: 'turn_context', timestamp, payload: {turn_id: 'turn-1', model: 'gpt-5.6-sol'}},
    {type: 'token_usage_record', timestamp, payload: {turn_id: 'turn-1', response_id: 'resp_small', usage: usage(1000)}},
    {type: 'token_usage_record', timestamp, payload: {turn_id: 'turn-1', response_id: 'resp_large', usage: usage(300000)}}
  ].map((line) => JSON.stringify(line)).join('\n'));
  const status = {show() {}, dispose() {}, text: '', tooltip: ''};
  const vscode = {
    StatusBarAlignment: {Right: 2}, ViewColumn: {Beside: 2},
    workspace: {getConfiguration: () => ({get: (_key, fallback) => fallback})},
    commands: {registerCommand: () => ({dispose() {}}), executeCommand: async () => {}},
    window: {createStatusBarItem: () => status, createWebviewPanel: () => ({webview: {html: ''}}),
      showWarningMessage: async () => undefined, showInformationMessage: () => {}}
  };
  const originalHome = os.homedir;
  const originalLoad = Module._load;
  os.homedir = () => home;
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  const values = new Map();
  const context = {subscriptions: [], globalStorageUri: {fsPath: path.join(home, 'storage')},
    globalState: {get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); }}};
  try {
    delete require.cache[require.resolve('../src/extension')];
    await require('../src/extension').activate(context);
  } finally {
    for (const item of context.subscriptions) item.dispose?.();
    require('../src/extension').deactivate();
    Module._load = originalLoad;
    os.homedir = originalHome;
  }
  const {detail, daily} = await new PartitionedStore(context.globalStorageUri.fsPath).read();
  assert.deepEqual(detail.map((event) => [event.tokens.input, event.nonStandardTier === true]).sort((a, b) => a[0] - b[0]),
    [[1000, false], [300000, true]]);
  assert.deepEqual(Object.values(daily).map((row) => [row.calls, row.nonStandardTier === true]).sort(), [[1, false], [1, true]]);
  // One call is priced and one is not: the status bar shows the priced part
  // and says the rest lacks a reference cost.
  assert.match(status.text, /^\$\(pulse\) US\$\d+\.\d{2} · /);
  assert.doesNotMatch(status.text, /No reference price/);
  assert.match(status.tooltip, /some calls lack a defensible reference cost/);
});
