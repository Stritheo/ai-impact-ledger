'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {parseClaudeLines, parseCodexLines, createLineAccumulator} = require('../src/core/parsers');

const turnContext = (turnId, model = 'gpt-5.6-sol', timestamp = '2026-09-15T00:00:00Z') =>
  JSON.stringify({type: 'turn_context', timestamp, payload: {turn_id: turnId, model}});

const usageRecord = (turnId, responseId, usage, timestamp = '2026-09-15T00:00:01Z') =>
  JSON.stringify({type: 'token_usage_record', timestamp,
    payload: {turn_id: turnId, response_id: responseId, session_id: 's1', usage: {
      input_tokens: usage.input, cached_input_tokens: usage.cached || 0,
      cache_write_input_tokens: usage.cacheWrite || 0, output_tokens: usage.output,
      reasoning_output_tokens: usage.reasoning || 0}}});

const tokenCount = (usage, total, timestamp = '2026-09-15T00:00:01Z') =>
  JSON.stringify({type: 'event_msg', timestamp, payload: {type: 'token_count', info: {
    last_token_usage: {input_tokens: usage.input, cached_input_tokens: usage.cached || 0,
      cache_write_input_tokens: usage.cacheWrite || 0, output_tokens: usage.output,
      reasoning_output_tokens: usage.reasoning || 0},
    total_token_usage: {input_tokens: total.input, output_tokens: total.output}}}});

const claudeLine = (requestId, timestamp, usage, model = 'claude-opus-5') =>
  JSON.stringify({type: 'assistant', requestId, timestamp, message: {model, usage}});

const totalTokens = (events) => events.reduce((sum, event) =>
  sum + event.tokens.input + event.tokens.cachedInput + event.tokens.cacheWrite + event.tokens.output, 0);

function codexDiagnostics(lines, source = 'rollout.jsonl') {
  const accumulator = createLineAccumulator('openai', source);
  for (const line of lines) accumulator.add(line);
  return {events: accumulator.events(), diagnostics: accumulator.diagnostics()};
}

test('each model response in a Codex turn is counted once', () => {
  const events = parseCodexLines([
    turnContext('t1'),
    usageRecord('t1', 'resp_1', {input: 10_000, cached: 0, output: 100}),
    usageRecord('t1', 'resp_2', {input: 11_000, cached: 0, output: 200}),
    usageRecord('t1', 'resp_3', {input: 12_000, cached: 0, output: 300})
  ], 'rollout.jsonl');

  assert.equal(events.length, 3);
  assert.equal(totalTokens(events), 33_600);
  assert.deepEqual(events.map((event) => event.model), ['gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-5.6-sol']);
});

test('a Codex response identifier is stable regardless of the file that holds it', () => {
  const lines = [turnContext('t1'), usageRecord('t1', 'resp_1', {input: 10, output: 1})];
  assert.equal(parseCodexLines(lines, 'a.jsonl')[0].id, parseCodexLines(lines, 'b.jsonl')[0].id);
});

test('a repeated Codex usage record does not add a second call', () => {
  const record = usageRecord('t1', 'resp_1', {input: 10_000, cached: 4_000, output: 100});
  const events = parseCodexLines([turnContext('t1'), record, record], 'rollout.jsonl');
  assert.equal(events.length, 1);
  assert.equal(events[0].tokens.input, 6_000);
  assert.equal(events[0].tokens.cachedInput, 4_000);
});

test('when a file carries both Codex schemas each request is counted once', () => {
  const {events, diagnostics} = codexDiagnostics([
    turnContext('t1'),
    tokenCount({input: 10_000, cached: 0, output: 100}, {input: 10_000, output: 100}),
    usageRecord('t1', 'resp_1', {input: 10_000, cached: 0, output: 100}),
    tokenCount({input: 11_000, cached: 0, output: 200}, {input: 21_000, output: 300}),
    usageRecord('t1', 'resp_2', {input: 11_000, cached: 0, output: 200})
  ]);

  assert.equal(events.length, 2);
  assert.equal(totalTokens(events), 21_300);
  assert.equal(diagnostics.unmatchedLegacyRecords, 0);
});

test('a legacy record with no matching usage record is disclosed rather than counted', () => {
  const {events, diagnostics} = codexDiagnostics([
    turnContext('t1'),
    usageRecord('t1', 'resp_1', {input: 10_000, cached: 0, output: 100}),
    tokenCount({input: 10_000, cached: 0, output: 100}, {input: 10_000, output: 100}),
    tokenCount({input: 5_000, cached: 0, output: 50}, {input: 15_000, output: 150})
  ]);

  assert.equal(events.length, 1);
  assert.equal(totalTokens(events), 10_100);
  assert.equal(diagnostics.unmatchedLegacyRecords, 1);
});

test('a legacy-only Codex file counts each change in the running total', () => {
  const events = parseCodexLines([
    turnContext('t1'),
    tokenCount({input: 10_000, cached: 0, output: 100}, {input: 10_000, output: 100}),
    tokenCount({input: 10_000, cached: 0, output: 100}, {input: 10_000, output: 100}),
    tokenCount({input: 11_000, cached: 0, output: 200}, {input: 21_000, output: 300})
  ], 'legacy.jsonl');

  assert.equal(events.length, 2);
  assert.equal(totalTokens(events), 21_300);
});

test('one Claude request recorded in two files is counted once', () => {
  const {mergeEvents} = require('../src/core/ledger');
  const usage = {input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10};
  const first = parseClaudeLines([claudeLine('req-1', '2026-09-15T00:00:00Z', usage)], 'session-a.jsonl');
  const second = parseClaudeLines([claudeLine('req-1', '2026-09-15T00:00:00Z', usage)], 'session-b.jsonl');

  assert.equal(first[0].id, second[0].id);
  assert.equal(mergeEvents(first, second).length, 1);
});

test('a stored timestamp is always UTC ISO-8601', () => {
  const events = parseClaudeLines([
    claudeLine('req-1', '2026-09-16T08:30:00+10:00', {input_tokens: 5, output_tokens: 1})
  ], 'session.jsonl');

  assert.equal(events[0].timestamp, '2026-09-15T22:30:00.000Z');
});

test('a parseable but non-ISO timestamp is skipped rather than stored', () => {
  const {events, diagnostics} = (() => {
    const accumulator = createLineAccumulator('anthropic', 'session.jsonl');
    accumulator.add(claudeLine('req-1', 'Wed Sep 16 2026 10:00:00 GMT+1000', {input_tokens: 5, output_tokens: 1}));
    return {events: accumulator.events(), diagnostics: accumulator.diagnostics()};
  })();

  assert.equal(events.length, 0);
  assert.equal(diagnostics.recordsSkipped, 1);
});

test('an implausible timestamp cannot enter the ledger', () => {
  const events = parseClaudeLines([
    claudeLine('old', '1999-01-01T00:00:00Z', {input_tokens: 5, output_tokens: 1}),
    claudeLine('future', '2099-01-01T00:00:00Z', {input_tokens: 5, output_tokens: 1})
  ], 'session.jsonl');

  assert.equal(events.length, 0);
});

test('an implausible token counter cannot produce a headline cost', () => {
  const events = parseClaudeLines([
    claudeLine('huge', '2026-09-15T00:00:00Z', {input_tokens: 1_000_000_000, output_tokens: 1})
  ], 'session.jsonl');

  assert.equal(events.length, 0);
});

test('an unrecognised usage-bearing record is disclosed as incomplete coverage', () => {
  const accumulator = createLineAccumulator('openai', 'rollout.jsonl');
  accumulator.add(turnContext('t1'));
  accumulator.add(JSON.stringify({type: 'token_usage_summary', timestamp: '2026-09-15T00:00:01Z',
    payload: {turn_id: 't1', usage: {input_tokens: 10_000, output_tokens: 100}}}));

  assert.equal(accumulator.events().length, 0);
  assert.equal(accumulator.diagnostics().schemaUnknown, 1);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../src/data/impact-registry.v1.json');
const {buildSummary, reportHtml} = require('../src/core/report');
const {PartitionedStore} = require('../src/core/storage');
const {rebuildDaily} = require('../src/core/ledger');

const dailyRow = (date, model, extra = {}) => ({date, provider: 'anthropic', model, calls: 100,
  input: 100_000, cachedInput: 0, cacheWrite: 100_000, cacheWrite5m: 99_000, cacheWrite1h: 0,
  output: 100_000, reasoningOutput: 0, ...extra});

test('one unclassified cache write does not make a whole day unpriced', () => {
  const daily = {'2026-09-10|anthropic|claude-opus-5': dailyRow('2026-09-10', 'claude-opus-5',
    {cacheWriteUnclassified: 1_000, calls: 100})};
  const summary = buildSummary([], registry, 'unknown',
    {period: 'cumulative', daily, now: new Date('2026-09-10T12:00:00Z'), timeZone: 'UTC'});

  assert.ok(summary.total.cost.central > 0, 'the priced remainder of the day must still be priced');
  assert.ok(summary.providers.anthropic.unpricedCalls < 100, 'unpriced calls are calls, not whole rows');
  assert.doesNotMatch(reportHtml(summary), /Not available/);
});

test('a period longer than retained detail reports from aggregates and says so', () => {
  const now = new Date('2026-09-16T02:00:00Z');
  const recent = {id: 'r1', provider: 'anthropic', model: 'claude-opus-5', timestamp: '2026-09-16T01:00:00Z',
    tokens: {input: 1_000, cachedInput: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoningOutput: 0},
    inferenceGeo: null};
  const daily = {'2026-08-25|anthropic|claude-opus-5': {date: '2026-08-25', provider: 'anthropic',
    model: 'claude-opus-5', calls: 7, input: 7_000, cachedInput: 0, cacheWrite: 0, output: 0, reasoningOutput: 0}};

  const summary = buildSummary([recent], registry, 'unknown', {period: '30d', daily, now, timeZone: 'UTC'});

  assert.equal(summary.calls, 8, 'days outside retained detail still count towards the period');
  assert.match(reportHtml(summary), /earlier days in this period come from daily totals/i);
});

test('a rebuild recomputes daily totals instead of adding to them', () => {
  const events = [
    {id: 'a', provider: 'openai', model: 'gpt-5.6-sol', timestamp: '2026-09-12T01:00:00Z',
      tokens: {input: 10, cachedInput: 0, cacheWrite: 0, output: 5, reasoningOutput: 0}, inferenceGeo: null},
    {id: 'b', provider: 'openai', model: 'gpt-5.6-sol', timestamp: '2026-09-12T02:00:00Z',
      tokens: {input: 20, cachedInput: 0, cacheWrite: 0, output: 5, reasoningOutput: 0}, inferenceGeo: null}
  ];
  const undercounted = {'2026-09-12|openai|gpt-5.6-sol': {date: '2026-09-12', provider: 'openai',
    model: 'gpt-5.6-sol', calls: 1, input: 20, cachedInput: 0, cacheWrite: 0, output: 5, reasoningOutput: 0},
  '2026-01-01|openai|gpt-5.6-sol': {date: '2026-01-01', provider: 'openai', model: 'gpt-5.6-sol',
    calls: 9, input: 900, cachedInput: 0, cacheWrite: 0, output: 9, reasoningOutput: 0}};

  const rebuilt = rebuildDaily(undercounted, events);

  assert.equal(rebuilt['2026-09-12|openai|gpt-5.6-sol'].calls, 2, 'a covered day is replaced, not incremented');
  assert.equal(rebuilt['2026-09-12|openai|gpt-5.6-sol'].input, 30);
  assert.equal(rebuilt['2026-01-01|openai|gpt-5.6-sol'].calls, 9, 'a day the logs no longer cover is preserved');
  assert.equal(rebuilt['2026-01-01|openai|gpt-5.6-sol'].preCorrection, true);
});

test('the store records which counting basis produced its totals', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-basis-'));
  const store = new PartitionedStore(root);
  await store.update((current) => ({...current, basisVersion: 2}));
  assert.equal((await store.read()).basisVersion, 2);
  assert.equal((await store.readMetadata()).basisVersion, 2);

  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-basis-legacy-'));
  const older = new PartitionedStore(legacy);
  await older.update(() => ({detail: [], daily: {}, checkpoints: {}}));
  const state = path.join(legacy, 'ledger.v2', 'state.json');
  const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
  delete saved.basisVersion;
  fs.writeFileSync(state, JSON.stringify(saved));
  assert.equal((await older.read()).basisVersion, null, 'a store written before the correction reads as unversioned');
});

const manyEvents = (count, now) => Array.from({length: count}, (_, index) => ({
  id: `e${index}`, provider: 'anthropic', model: 'claude-opus-5',
  timestamp: new Date(now.getTime() - (index % 60) * 86_400_000).toISOString(),
  tokens: {input: 1_000, cachedInput: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 10, reasoningOutput: 0},
  inferenceGeo: null}));

// The extension host that runs this summary also runs the user's other
// extensions, so the cost per event matters. Assert the mechanism, which is
// deterministic, rather than wall-clock time, which is not.
test('a summary builds one date formatter per time zone, not one per call', () => {
  const now = new Date('2026-09-16T00:00:00Z');
  const events = manyEvents(5_000, now);
  const original = Intl.DateTimeFormat;
  let constructed = 0;
  Intl.DateTimeFormat = function (...args) {
    constructed += 1;
    return new original(...args);
  };
  Intl.DateTimeFormat.prototype = original.prototype;
  try {
    buildSummary(events, registry, 'unknown', {period: '90d', now, timeZone: 'America/Halifax'});
  } finally {
    Intl.DateTimeFormat = original;
  }

  // One per time zone, or none if an earlier test warmed the cache: what must
  // never happen is one per event.
  assert.ok(constructed <= 1, `built ${constructed} formatters for 5,000 events`);
});

test('summarising a large ledger does not block for seconds', () => {
  const now = new Date('2026-09-16T00:00:00Z');
  const events = manyEvents(16_000, now);

  const started = performance.now();
  buildSummary(events, registry, 'unknown', {period: '90d', now, timeZone: 'Australia/Sydney'});
  const elapsed = performance.now() - started;

  // Measured at 64-105 ms in isolation, against 688 ms before this change. The
  // guard is loose because concurrent test files share the machine.
  assert.ok(elapsed < 400, `summary took ${elapsed.toFixed(0)} ms`);
});

// The Codex rollout format is implementation detail with no published contract.
// The parser must not depend on guarantees the format does not give.

test('a repeated response identifier is not counted twice and is disclosed', () => {
  const {events, diagnostics} = codexDiagnostics([
    turnContext('t1'),
    usageRecord('t1', 'resp_1', {input: 10_000, cached: 0, output: 100}),
    usageRecord('t1', 'resp_1', {input: 12_000, cached: 0, output: 200})
  ]);

  assert.equal(events.length, 1, 'a reused identifier must not inflate the count');
  assert.equal(diagnostics.duplicateResponseIds, 1,
    'an identifier the provider does not guarantee to be unique must be observable when it repeats');
});

test('a repeated legacy snapshot without a running total is not counted twice', () => {
  const snapshot = JSON.stringify({type: 'event_msg', timestamp: '2026-09-15T00:00:01Z',
    payload: {type: 'token_count', info: {last_token_usage: {input_tokens: 10_000,
      cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0}}}});
  const events = parseCodexLines([turnContext('t1'), snapshot, snapshot], 'legacy.jsonl');

  assert.equal(events.length, 1, 'token_count is a snapshot, not a request record');
  assert.equal(totalTokens(events), 10_100);
});

test('legacy entries the current schema does not account for reach the user', () => {
  const summary = buildSummary([], registry, 'unknown', {period: 'today'});
  summary.monitor = {durationMs: 1, filesRead: 1, unchangedFiles: 0, filesSkipped: 0,
    linesSkipped: 0, recordsSkipped: 0, schemaUnknown: 0, unmatchedLegacyRecords: 3};

  assert.match(reportHtml(summary), /3 earlier usage record\(s\)/);
});
