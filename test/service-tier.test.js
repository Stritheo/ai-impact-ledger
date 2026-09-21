'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../src/data/impact-registry.v1.json');
const {createLineAccumulator} = require('../src/core/parsers');
const {estimateEvent} = require('../src/core/estimate');
const {sanitiseEvent} = require('../src/core/security');
const {mergeEvents, updateDaily, rebuildDaily, reconcileDailyFloor} = require('../src/core/ledger');
const {buildSummary, reportHtml} = require('../src/core/report');
const {PartitionedStore} = require('../src/core/storage');

const NOW = new Date('2026-09-17T12:00:00Z');
const DAY = '2026-09-10';

function claudeRecord(requestId, usageExtras, output = 1000) {
  return JSON.stringify({type: 'assistant', requestId, timestamp: `${DAY}T03:00:00.000Z`,
    message: {model: 'claude-opus-5', usage: {input_tokens: 1000, output_tokens: output, ...usageExtras}}});
}

function parse(lines) {
  const accumulator = createLineAccumulator('anthropic', 'session.jsonl');
  for (const line of lines) accumulator.add(line);
  return accumulator.events().map((event) => ({...sanitiseEvent(event), id: event.id}));
}

test('a fast-mode or non-standard-tier Claude call is flagged, and nothing else is kept about its tier', () => {
  const events = parse([
    claudeRecord('fast', {speed: 'fast', service_tier: 'standard'}),
    claudeRecord('priority', {speed: 'standard', service_tier: 'priority'}),
    claudeRecord('standard', {speed: 'standard', service_tier: 'standard'}),
    claudeRecord('nulls', {speed: null, service_tier: null}),
    claudeRecord('absent', {}),
    claudeRecord('odd', {speed: 3})
  ]);
  const flagged = Object.fromEntries(events.map((event) => [event.id.replace('claude:', ''), event.nonStandardTier === true]));
  assert.deepEqual(flagged, {fast: true, priority: true, standard: false, nulls: false, absent: false, odd: true});
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['id', 'provider', 'model', 'timestamp', 'tokens', 'inferenceGeo',
      ...(event.nonStandardTier ? ['nonStandardTier'] : [])].sort());
    // The request identifiers in this fixture name the tier, so they are left out.
    const {id, ...rest} = event;
    assert.equal(JSON.stringify(rest).includes('fast'), false, 'the tier value itself is not retained');
    assert.equal(JSON.stringify(rest).includes('priority'), false);
  }
  assert.equal(sanitiseEvent({...events[0], nonStandardTier: 'yes'}).nonStandardTier, undefined);
});

test('a streamed request is flagged if any of its records carries a non-standard tier', () => {
  const [event] = parse([claudeRecord('stream', {speed: 'fast'}, 10), claudeRecord('stream', {}, 1000)]);
  assert.equal(event.nonStandardTier, true);
  assert.equal(event.tokens.output, 1000);
  const merged = mergeEvents([{...event, nonStandardTier: undefined, tokens: {...event.tokens, output: 2000}}], [event]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].tokens.output, 2000);
  assert.equal(merged[0].nonStandardTier, true, 'a merge across files keeps the flag');
});

test('a non-standard-tier call is never priced at standard rates, but its energy still counts', () => {
  const [fast, standard] = parse([claudeRecord('fast', {speed: 'fast'}), claudeRecord('standard', {speed: 'standard'})]);
  const fastEstimate = estimateEvent(fast, registry);
  const standardEstimate = estimateEvent(standard, registry);
  assert.equal(fastEstimate.cost.central, null);
  assert.equal(fastEstimate.cost.reason, 'non-standard-tier');
  assert.ok(standardEstimate.cost.central > 0);
  // energyWh carries low, mid and high: comparing a field that does not exist
  // would pass however the energy differed.
  assert.equal(fastEstimate.energyWh.mid, standardEstimate.energyWh.mid);
  assert.ok(fastEstimate.energyWh.mid > 0);
});

test('a fast-mode call whose detail has expired stays unpriced in daily totals', async () => {
  const [fast, standard] = parse([claudeRecord('fast', {speed: 'fast'}), claudeRecord('standard', {speed: 'standard'})]);
  const standardCost = estimateEvent(standard, registry).cost.central;
  const daily = updateDaily({}, [], [fast, standard]);
  assert.equal(Object.keys(daily).length, 2, 'the two tiers are kept in separate rows');

  // Round trip through storage: the tier row and the flag survive validation.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-tier-'));
  const store = new PartitionedStore(root);
  await store.update(() => ({detail: [fast, standard], daily, checkpoints: {}, basisVersion: 2}));
  const stored = await store.read();
  assert.equal(stored.detail.find((event) => event.id === fast.id).nonStandardTier, true);
  assert.deepEqual(stored.daily, daily);

  for (const period of ['cumulative', '30d']) {
    for (const detail of [stored.detail, []]) {
      const summary = buildSummary(detail, registry, 'unknown', {settings: {period}, daily: stored.daily, now: NOW, timeZone: 'UTC'});
      assert.equal(summary.calls, 2, `${period}, ${detail.length ? 'with' : 'without'} detail`);
      assert.equal(summary.total.cost.central, standardCost, `${period}: only the standard call is priced`);
      assert.equal(summary.providers.anthropic.unpricedCalls, 1);
      assert.equal(summary.providers.anthropic.nonStandardTierCalls, 1);
      const html = reportHtml(summary);
      // Wording widened when OpenAI's long-context price joined this reason
      // (evidence sprint, 17 September 2026); the count is what matters.
      assert.match(html, /1 at a price the reference rates do not cover/);
    }
  }

  // The daily floor and a basis rebuild keep the tiers apart as well.
  assert.deepEqual(reconcileDailyFloor({}, [fast, standard]), daily);
  const rebuilt = rebuildDaily({}, [fast, standard]);
  assert.deepEqual(rebuilt, daily);
});

test('after upgrade, a fast-mode call already stored at standard rates is re-read and left unpriced', async () => {
  const crypto = require('node:crypto');
  const Module = require('node:module');
  const {hashEventId} = require('../src/core/security');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-tier-upgrade-'));
  const project = path.join(home, '.claude', 'projects', 'project');
  fs.mkdirSync(project, {recursive: true});
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), {recursive: true});
  const log = path.join(project, 'session.jsonl');
  const timestamp = new Date(Date.now() - 3_600_000).toISOString();
  fs.writeFileSync(log, `${JSON.stringify({type: 'assistant', requestId: 'req_fast', timestamp,
    message: {model: 'claude-opus-5', usage: {input_tokens: 1000, output_tokens: 1000, speed: 'fast'}}})}\n`);
  const storageRoot = path.join(home, 'storage');
  fs.mkdirSync(storageRoot, {recursive: true});
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(storageRoot, 'hash-secret'), secret, {mode: 0o600});

  // The ledger as version 0.2 left it: the call stored without the flag, and
  // the log checkpointed under that version's parser, so it is not re-read
  // unless the parser version moves on.
  const stat = fs.statSync(log);
  const oldKey = crypto.createHmac('sha256', secret).update('4:project/session.jsonl').digest('hex');
  const stale = {id: hashEventId('claude:req_fast', secret), provider: 'anthropic', model: 'claude-opus-5', timestamp,
    tokens: {input: 1000, cachedInput: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 1000, reasoningOutput: 0},
    inferenceGeo: null};
  await new PartitionedStore(storageRoot).update(() => ({detail: [stale], daily: updateDaily({}, [], [stale]),
    checkpoints: {anthropic: {[oldKey]: `${stat.size}:${Math.trunc(stat.mtimeMs)}`}}, basisVersion: 2}));

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
  const values = new Map([['localHashSecret.v1', secret]]);
  const context = {subscriptions: [], globalStorageUri: {fsPath: storageRoot},
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
  const stored = await new PartitionedStore(storageRoot).read();
  assert.equal(stored.detail.length, 1);
  assert.equal(stored.detail[0].nonStandardTier, true);
  assert.deepEqual(Object.values(stored.daily).map((row) => [row.calls, row.nonStandardTier === true]), [[1, true]],
    'the call moves to the non-standard row rather than being counted twice');
  assert.match(status.text, /No reference price/);
});

test('a call updated in place keeps the other fields of its daily row', () => {
  const [call] = parse([claudeRecord('in-place', {})]);
  const key = Object.keys(updateDaily({}, [], [call]))[0];
  const previous = {[key]: {...updateDaily({}, [], [call])[key], preCorrection: true, cacheWriteUnclassified: 0}};
  const grown = {...call, tokens: {...call.tokens, output: call.tokens.output + 5}};
  const next = updateDaily(previous, [call], [grown]);
  assert.equal(next[key].calls, 1);
  assert.equal(next[key].output, grown.tokens.output);
  assert.equal(next[key].preCorrection, true);
  assert.equal(next[key].cacheWriteUnclassified, 0);
});
