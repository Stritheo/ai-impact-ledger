'use strict';

// Regression tests for defects found by independent verification of the
// counting-basis branch on 16 September 2026. Each test is named for the
// behaviour a user would observe, not the defect number.

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/data/impact-registry.v1.json');
const {buildSummary, reportHtml} = require('../src/core/report');
const {parseClaudeLines, parseCodexLines, createLineAccumulator} = require('../src/core/parsers');
const {mergeEvents, rebuildDaily} = require('../src/core/ledger');

const event = (id, timestamp, tokens = {}) => ({id, provider: 'anthropic', model: 'claude-opus-5', timestamp,
  tokens: {input: 1_000, cachedInput: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 10,
    reasoningOutput: 0, ...tokens}, inferenceGeo: null});

// D1: daily rows are UTC-dated. Feeding them into a local-day period pulls a
// neighbouring local day into "Today" for any zone behind UTC.
test('Today counts only today, in a time zone behind UTC', () => {
  const now = new Date('2026-09-16T02:00:00Z');           // 15 September, 19:00 in Los Angeles
  const today = event('today', '2026-09-16T01:00:00Z');   // 15 September, 18:00 local
  const daily = {'2026-09-15|anthropic|claude-opus-5': {date: '2026-09-15', provider: 'anthropic',
    model: 'claude-opus-5', calls: 1, input: 1_000, cachedInput: 0, cacheWrite: 0, output: 10, reasoningOutput: 0}};

  const summary = buildSummary([today], registry, 'unknown',
    {period: 'today', daily, now, timeZone: 'America/Los_Angeles'});

  assert.equal(summary.calls, 1, 'a UTC-dated aggregate must not be added to a local calendar day');
  assert.equal(summary.tokens, 1_010);
});

// D9: the note must describe what actually happened.
test('a complete period does not claim its records are incomplete', () => {
  const now = new Date('2026-09-16T02:00:00Z');
  const daily = {'2026-09-16|anthropic|claude-opus-5': {date: '2026-09-16', provider: 'anthropic',
    model: 'claude-opus-5', calls: 1, input: 1_000, cachedInput: 0, cacheWrite: 0, output: 10, reasoningOutput: 0}};
  const summary = buildSummary([event('today', '2026-09-16T01:00:00Z')], registry, 'unknown',
    {period: 'today', daily, now, timeZone: 'Australia/Sydney'});

  assert.doesNotMatch(reportHtml(summary), /Detailed records do not cover the whole period/);
});

// D2: purging detail deletes records; it must not shrink the aggregate that
// deliberately survives a purge.
test('a rebuild does not shrink the day that contains a purge', () => {
  const carried = {'2026-09-12|openai|gpt-5.6-sol': {date: '2026-09-12', provider: 'openai',
    model: 'gpt-5.6-sol', calls: 2, input: 20_000, cachedInput: 0, cacheWrite: 0, output: 200, reasoningOutput: 0}};
  const survivingDetail = [{id: 'b', provider: 'openai', model: 'gpt-5.6-sol',
    timestamp: '2026-09-12T03:00:00Z', tokens: {input: 10_000, cachedInput: 0, cacheWrite: 0, output: 100,
      reasoningOutput: 0}, inferenceGeo: null}];

  const rebuilt = rebuildDaily(carried, survivingDetail, {purgedBefore: '2026-09-12T02:18:00Z'});

  assert.equal(rebuilt['2026-09-12|openai|gpt-5.6-sol'].calls, 2, 'purged detail still counts in daily totals');
  assert.equal(rebuilt['2026-09-12|openai|gpt-5.6-sol'].input, 20_000);
});

// D4: normalising timestamps can move a day key. An orphaned old-basis row for
// a day the rebuild covers must not be added to the corrected one.
test('a rebuild does not keep a stale row for a day it recomputed', () => {
  const carried = {'2026-09-16|openai|unknown': {date: '2026-09-16', provider: 'openai', model: 'unknown',
    calls: 1, input: 12_000, cachedInput: 0, cacheWrite: 0, output: 10, reasoningOutput: 0}};
  const detail = [{id: 'a', provider: 'openai', model: 'gpt-5.6-terra', timestamp: '2026-09-16T01:00:00Z',
    tokens: {input: 33_000, cachedInput: 0, cacheWrite: 0, output: 30, reasoningOutput: 0}, inferenceGeo: null}];

  const rebuilt = rebuildDaily(carried, detail, {});

  assert.equal(Object.keys(rebuilt).length, 1, 'the superseded row for a recomputed day and provider is dropped');
  assert.equal(rebuilt['2026-09-16|openai|gpt-5.6-terra'].input, 33_000);
});

// D3: the original defect is reachable whenever a response carries no identifier.
test('responses without an identifier are still counted separately', () => {
  const lines = [JSON.stringify({type: 'turn_context', timestamp: '2026-09-15T00:00:00Z',
    payload: {turn_id: 't1', model: 'gpt-5.6-sol'}})];
  for (const input of [10_000, 11_000, 12_000]) {
    lines.push(JSON.stringify({type: 'token_usage_record', timestamp: '2026-09-15T00:00:01Z',
      payload: {turn_id: 't1', usage: {input_tokens: input, cached_input_tokens: 0,
        cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0}}}));
  }

  const events = parseCodexLines(lines, 'rollout.jsonl');

  assert.equal(events.length, 3, 'a turn must not collapse just because the provider omitted an identifier');
  assert.equal(events.reduce((sum, item) => sum + item.tokens.input + item.tokens.output, 0), 33_030);
});

// D10: a timestamp without a zone is not UTC, and reading it as local time
// silently attributes work to the wrong day.
test('a timestamp without a time zone is not guessed', () => {
  const events = parseClaudeLines([JSON.stringify({type: 'assistant', requestId: 'r1',
    timestamp: '2026-09-16T08:30:00', message: {model: 'claude-opus-5',
      usage: {input_tokens: 5, output_tokens: 1}}})], 'session.jsonl');

  assert.equal(events.length, 0);
});

// D12: the documented rule is largest-wins; across files it was scan order.
test('merging two records of one call keeps the larger usage, whatever the order', () => {
  const small = event('same', '2026-09-15T00:00:00Z', {output: 5});
  const large = event('same', '2026-09-15T00:00:00Z', {output: 500});

  assert.equal(mergeEvents([large], [small])[0].tokens.output, 500);
  assert.equal(mergeEvents([small], [large])[0].tokens.output, 500);
});

// D5-D8: a diagnostic nobody sees is not a control.
test('the legacy-record diagnostic is stable and reaches the user', () => {
  const accumulator = createLineAccumulator('openai', 'rollout.jsonl');
  const lines = [
    JSON.stringify({type: 'turn_context', timestamp: '2026-09-15T00:00:00Z', payload: {turn_id: 't1', model: 'gpt-5.6-sol'}}),
    JSON.stringify({type: 'token_usage_record', timestamp: '2026-09-15T00:00:01Z', payload: {turn_id: 't1',
      response_id: 'resp_1', usage: {input_tokens: 10_000, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 100, reasoning_output_tokens: 0}}}),
    JSON.stringify({type: 'event_msg', timestamp: '2026-09-15T00:00:02Z', payload: {type: 'token_count',
      info: {last_token_usage: {input_tokens: 5_000, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 50, reasoning_output_tokens: 0}, total_token_usage: {input_tokens: 15_000, output_tokens: 150}}}})
  ];
  for (const line of lines) accumulator.add(line);

  accumulator.events();
  accumulator.events();
  assert.equal(accumulator.diagnostics().unmatchedLegacyRecords, 1, 'reading the events twice must not double the count');

  const summary = buildSummary([], registry, 'unknown', {period: 'today'});
  summary.monitor = {durationMs: 1, filesRead: 1, unchangedFiles: 0, filesSkipped: 0, linesSkipped: 0,
    recordsSkipped: 0, schemaUnknown: 0, unmatchedLegacyRecords: 3};
  assert.match(reportHtml(summary), /3 earlier usage record/);
});

// D11: a confident figure must not quietly replace an honest "not available".
test('a period priced only in part says so wherever the figure appears', () => {
  const daily = {'2026-09-16|anthropic|claude-opus-5': {date: '2026-09-16', provider: 'anthropic',
    model: 'claude-opus-5', calls: 10, input: 1_000, cachedInput: 0, cacheWrite: 100_000,
    cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnclassified: 100_000, output: 1_000, reasoningOutput: 0}};
  const summary = buildSummary([], registry, 'unknown', {period: 'cumulative', daily,
    now: new Date('2026-09-16T02:00:00Z'), timeZone: 'Australia/Sydney'});

  assert.equal(summary.total.hasPartialCost, true);
  assert.match(reportHtml(summary), /excluded from cost/);
});

// Second verification pass, 16 September 2026: the fixes above introduced two
// defects of their own.

// H1: aggregates were restricted to days before the earliest retained detail, so
// a day with no detail inside the period was dropped entirely.
test('a period reports every day it covers, in every zone', () => {
  const now = new Date('2026-09-16T02:00:00Z');
  const detail = [event('recent', '2026-09-16T01:00:00Z'), event('older', '2026-09-11T01:00:00Z')];
  // A day inside the period whose detail has expired but whose aggregate remains.
  const daily = {'2026-09-13|anthropic|claude-opus-5': {date: '2026-09-13', provider: 'anthropic',
    model: 'claude-opus-5', calls: 5, input: 5_000, cachedInput: 0, cacheWrite: 0, output: 50, reasoningOutput: 0}};

  for (const timeZone of ['Australia/Sydney', 'America/Los_Angeles', 'Pacific/Chatham']) {
    const summary = buildSummary(detail, registry, 'unknown', {period: '7d', daily, now, timeZone});
    assert.equal(summary.calls, 7, `${timeZone}: a day inside the period must not vanish`);
    assert.match(reportHtml(summary), /daily totals/i, `${timeZone}: the mixed basis must be disclosed`);
  }
});

test('a day already counted in detail is never also counted from aggregates', () => {
  const now = new Date('2026-09-16T02:00:00Z');
  const detail = [event('today', '2026-09-16T01:00:00Z')];
  const sameDay = {'2026-09-16|anthropic|claude-opus-5': {date: '2026-09-16', provider: 'anthropic',
    model: 'claude-opus-5', calls: 1, input: 1_000, cachedInput: 0, cacheWrite: 0, output: 10, reasoningOutput: 0}};
  const earlierDay = {'2026-09-14|anthropic|claude-opus-5': {date: '2026-09-14', provider: 'anthropic',
    model: 'claude-opus-5', calls: 1, input: 1_000, cachedInput: 0, cacheWrite: 0, output: 10, reasoningOutput: 0}};

  for (const timeZone of ['Australia/Sydney', 'America/Los_Angeles', 'Pacific/Chatham']) {
    // The aggregate for the day detail already holds must never be added.
    const today = buildSummary(detail, registry, 'unknown', {period: 'today', daily: sameDay, now, timeZone});
    assert.equal(today.calls, 1, `${timeZone}: the day detail covers must not be counted twice`);

    // Nor may a neighbouring day leak into a single-day period, because a UTC
    // day straddles two local ones.
    const withNeighbour = buildSummary(detail, registry, 'unknown', {period: 'today',
      daily: {...sameDay, '2026-09-15|anthropic|claude-opus-5': {date: '2026-09-15', provider: 'anthropic',
        model: 'claude-opus-5', calls: 1, input: 1_000, cachedInput: 0, cacheWrite: 0, output: 10, reasoningOutput: 0}},
      now, timeZone});
    assert.equal(withNeighbour.calls, 1, `${timeZone}: a neighbouring UTC day is not today`);

    // A day wholly inside a longer period is real work detail no longer holds.
    const week = buildSummary(detail, registry, 'unknown',
      {period: '7d', daily: {...sameDay, ...earlierDay}, now, timeZone});
    assert.equal(week.calls, 2, `${timeZone}: a day inside the period is reported once`);
  }
});

// H2: dropping every carried row for a date and provider the rebuild covers
// deletes a model whose log has rotated away.
test('a rebuild keeps a model whose log is gone but whose day is otherwise covered', () => {
  const carried = {
    '2026-09-16|openai|gpt-5.6-sol': {date: '2026-09-16', provider: 'openai', model: 'gpt-5.6-sol',
      calls: 4, input: 4_000, cachedInput: 0, cacheWrite: 0, output: 40, reasoningOutput: 0},
    '2026-09-16|openai|unknown': {date: '2026-09-16', provider: 'openai', model: 'unknown',
      calls: 1, input: 12_000, cachedInput: 0, cacheWrite: 0, output: 10, reasoningOutput: 0}
  };
  const detail = [{id: 'a', provider: 'openai', model: 'gpt-5.6-terra', timestamp: '2026-09-16T01:00:00Z',
    tokens: {input: 33_000, cachedInput: 0, cacheWrite: 0, output: 30, reasoningOutput: 0}, inferenceGeo: null}];

  const rebuilt = rebuildDaily(carried, detail, {});

  assert.equal(rebuilt['2026-09-16|openai|gpt-5.6-sol'].calls, 4,
    'a named model the rebuild did not see is real history, not a stale row');
  assert.equal(rebuilt['2026-09-16|openai|gpt-5.6-sol'].preCorrection, true);
  assert.equal(rebuilt['2026-09-16|openai|unknown'], undefined,
    'an unidentified row superseded by a named one is dropped');
  assert.equal(rebuilt['2026-09-16|openai|gpt-5.6-terra'].input, 33_000);
});

// The purge rule must not assemble a row that never existed.
test('a purge-day row comes from one basis, not a blend of two', () => {
  const carried = {'2026-09-12|openai|gpt-5.6-sol': {date: '2026-09-12', provider: 'openai',
    model: 'gpt-5.6-sol', calls: 2, input: 20_000, cachedInput: 0, cacheWrite: 999, output: 20, reasoningOutput: 0}};
  const detail = [{id: 'b', provider: 'openai', model: 'gpt-5.6-sol', timestamp: '2026-09-12T03:00:00Z',
    tokens: {input: 10_000, cachedInput: 0, cacheWrite: 0, output: 100, reasoningOutput: 0}, inferenceGeo: null}];

  const rebuilt = rebuildDaily(carried, detail, {purgedBefore: '2026-09-12T02:18:00Z'});
  const row = rebuilt['2026-09-12|openai|gpt-5.6-sol'];

  assert.equal(row.calls, 2, 'the day that survives a purge keeps its recorded call count');
  assert.equal(row.output, 20, 'fields come from the same record, not the larger of each');
  assert.equal(row.preCorrection, true, 'a figure that predates the correction is marked');
});

test('merging is order-independent even when two records show equal usage', () => {
  const first = {...event('same', '2026-09-15T00:00:00Z'), model: 'claude-opus-5'};
  const second = {...event('same', '2026-09-15T01:00:00Z'), model: 'claude-sonnet-5'};

  assert.deepEqual(mergeEvents([first], [second])[0], mergeEvents([second], [first])[0],
    'a tie must resolve the same way whichever file was scanned first');
});
