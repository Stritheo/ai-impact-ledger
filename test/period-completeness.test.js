'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/data/impact-registry.v1.json');
const {buildSummary, reportHtml} = require('../src/core/report');
const {updateDaily, rebuildDaily, aggregateByDay} = require('../src/core/ledger');
const {estimateEvent} = require('../src/core/estimate');

const NOW = new Date('2026-09-18T12:00:00Z');
const DAY = '2026-09-18';

function call(index, hour, model = 'claude-opus-5', provider = 'anthropic') {
  return {id: `c${index}`, provider, model,
    timestamp: `${DAY}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    tokens: {input: 1000, cachedInput: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 100, reasoningOutput: 0},
    inferenceGeo: null};
}

// A day's calls, of which only the later ones still have per-call detail: what
// a purge, a storage trim or the retention cut-off all leave behind.
function partlyCoveredDay() {
  const morning = [call(1, 1), call(2, 2), call(3, 3)];
  const afternoon = [call(4, 13), call(5, 14)];
  return {morning, afternoon, daily: updateDaily({}, [], [...morning, ...afternoon])};
}

for (const [reason, completeFrom] of [
  ['a purge', `${DAY}T10:00:00.000Z`],
  ['a storage trim', `${DAY}T09:30:00.000Z`],
  ['retention expiry', `${DAY}T08:00:00.000Z`]
]) {
  test(`a day only partly covered by detail still reports its whole total after ${reason}`, () => {
    const {afternoon, daily} = partlyCoveredDay();
    for (const period of ['7d', '30d', '90d', 'cumulative']) {
      const summary = buildSummary(afternoon, registry, 'unknown',
        {settings: {period}, daily, now: NOW, timeZone: 'UTC', detailCompleteFrom: completeFrom});
      assert.equal(summary.calls, 5, `${period} after ${reason}`);
      assert.equal(summary.tokens, 5 * 1100, `${period} tokens after ${reason}`);
    }
  });
}

test('a day whose detail is complete is counted once, from its detail', () => {
  const {morning, afternoon, daily} = partlyCoveredDay();
  const events = [...morning, ...afternoon];
  for (const completeFrom of [null, '2026-09-01T00:00:00.000Z']) {
    const summary = buildSummary(events, registry, 'unknown',
      {settings: {period: '30d'}, daily, now: NOW, timeZone: 'UTC', detailCompleteFrom: completeFrom});
    assert.equal(summary.calls, 5, 'no double counting when detail covers the day');
    assert.equal(summary.aggregateDays, false, 'no aggregate day is disclosed when none was used');
  }
});

test('the report discloses a day supplied by totals rather than detail', () => {
  const {afternoon, daily} = partlyCoveredDay();
  const summary = buildSummary(afternoon, registry, 'unknown',
    {settings: {period: '30d'}, daily, now: NOW, timeZone: 'UTC', detailCompleteFrom: `${DAY}T10:00:00.000Z`});
  assert.equal(summary.aggregateDays, true);
  assert.match(reportHtml(summary), /come from daily totals/);
});

test('a day of ordinary calls is still priced once its total passes the long-context threshold', () => {
  // Thirty ordinary Codex calls of 10,000 prompt tokens: 300,000 in the day,
  // no single call anywhere near the 272,000 limit.
  const calls = Array.from({length: 30}, (_, index) => ({...call(index, 1, 'gpt-5.6-terra', 'openai'),
    id: `x${index}`, tokens: {input: 10_000, cachedInput: 0, cacheWrite: 0, output: 100, reasoningOutput: 0}}));
  const perCall = calls.reduce((sum, event) => sum + estimateEvent(event, registry).cost.central, 0);
  const daily = updateDaily({}, [], calls);
  const summary = buildSummary([], registry, 'unknown',
    {settings: {period: 'cumulative'}, daily, now: NOW, timeZone: 'UTC'});
  assert.equal(summary.calls, 30);
  assert.equal(summary.providers.openai.unpricedCalls, 0, 'a day total is not a prompt size');
  assert.ok(Math.abs(summary.total.cost.central - perCall) < 1e-9, `${summary.total.cost.central} vs ${perCall}`);
  assert.doesNotMatch(reportHtml(summary), /long-context/);
});

test('a basis rebuild keeps a complete day it can only partly reproduce', () => {
  const {morning, afternoon, daily} = partlyCoveredDay();
  const complete = {...daily};
  // The rebuild sees only the detail that survived the retention cut-off.
  const rebuilt = rebuildDaily(complete, afternoon, {completeFrom: `${DAY}T08:00:00.000Z`});
  const key = `${DAY}|anthropic|claude-opus-5`;
  assert.equal(rebuilt[key].calls, 5, 'the boundary day must not shrink to its surviving detail');
  assert.equal(rebuilt[key].preCorrection, true, 'and it is marked as not reproduced');

  // A day the rebuild can reproduce in full is still replaced by the rebuild.
  const reproducible = rebuildDaily(aggregateByDay([...morning, ...afternoon]), [...morning, ...afternoon],
    {completeFrom: `${DAY}T08:00:00.000Z`});
  assert.equal(reproducible[key].calls, 5);
  assert.equal(reproducible[key].preCorrection, undefined);
});

test('a purge shows the whole of today, not just the calls that survived it', () => {
  const {afternoon, daily} = partlyCoveredDay();
  const summary = buildSummary(afternoon, registry, 'unknown',
    {settings: {period: 'today'}, daily, now: NOW, timeZone: 'UTC', detailCompleteFrom: `${DAY}T10:00:00.000Z`,
      purgedBefore: `${DAY}T10:00:00.000Z`});
  assert.equal(summary.calls, 5, 'today is the period a purge is most likely to be read in');
  const html = reportHtml(summary);
  assert.match(html, /daily totals/);
  assert.match(html, /deleted/i, 'the report says detailed records were deleted');
});

test('the opening day of a window is not lost when its detail was cut', () => {
  // A seven-day window whose first day lost its detail to the retention cut.
  const first = '2026-09-12';
  const rows = updateDaily({}, [], [
    {id: 'a', provider: 'anthropic', model: 'claude-opus-5', timestamp: `${first}T02:00:00.000Z`,
      tokens: {input: 1000, cachedInput: 0, cacheWrite: 0, output: 100, reasoningOutput: 0}, inferenceGeo: null},
    {id: 'b', provider: 'anthropic', model: 'claude-opus-5', timestamp: `${first}T20:00:00.000Z`,
      tokens: {input: 1000, cachedInput: 0, cacheWrite: 0, output: 100, reasoningOutput: 0}, inferenceGeo: null}
  ]);
  const later = [call(9, 3)];
  const daily = {...rows, ...updateDaily({}, [], later)};
  const summary = buildSummary(later, registry, 'unknown',
    {settings: {period: '7d'}, daily, now: NOW, timeZone: 'UTC', detailCompleteFrom: `${first}T23:00:00.000Z`});
  assert.equal(summary.calls, 3, 'the first day of the window must not vanish');
  assert.match(reportHtml(summary), /may include work from just outside/,
    'and the report says a boundary day comes from a UTC total');
});

test('a malformed or missing completeness instant is treated as unknown, not as complete', () => {
  const {afternoon, daily} = partlyCoveredDay();
  for (const value of ['not-a-date', 42, {}, '']) {
    const summary = buildSummary(afternoon, registry, 'unknown',
      {settings: {period: '30d'}, daily, now: NOW, timeZone: 'UTC', detailCompleteFrom: value});
    assert.equal(summary.calls, 5, `detail is not assumed complete for ${JSON.stringify(value)}`);
  }
});

test('a rebuild never shrinks a day, and says so when it cannot reproduce one', () => {
  const {morning, afternoon} = partlyCoveredDay();
  const events = [...morning, ...afternoon];
  const key = `${DAY}|anthropic|claude-opus-5`;
  // A day the rebuild reproduces exactly is simply replaced.
  const reproduced = rebuildDaily(updateDaily({}, [], events), events, {completeFrom: `${DAY}T00:00:00.000Z`});
  assert.equal(reproduced[key].calls, 5);
  assert.equal(reproduced[key].preCorrection, undefined);

  // A carried row holding more than the rebuild is kept and marked, because
  // nothing records whether its logs rotated away or the row was wrong. Only
  // a purge or a storage trim removes history, and both are disclosed.
  const larger = updateDaily({}, [], events);
  larger[key] = {...larger[key], calls: 50, input: 500_000};
  const kept = rebuildDaily(larger, events, {completeFrom: `${DAY}T00:00:00.000Z`});
  assert.equal(kept[key].calls, 50);
  assert.equal(kept[key].preCorrection, true);
});

test('a rebuild keeps the record holding more work, not merely more calls', () => {
  const key = `${DAY}|openai|gpt-5.6-sol`;
  const carried = {[key]: {date: DAY, provider: 'openai', model: 'gpt-5.6-sol', calls: 2, input: 1_000_000,
    cachedInput: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoningOutput: 0}};
  const thin = Array.from({length: 3}, (_, index) => ({id: `t${index}`, provider: 'openai', model: 'gpt-5.6-sol',
    timestamp: `${DAY}T0${index + 1}:00:00.000Z`,
    tokens: {input: 100, cachedInput: 0, cacheWrite: 0, output: 0, reasoningOutput: 0}, inferenceGeo: null}));
  const rebuilt = rebuildDaily(carried, thin, {completeFrom: `${DAY}T23:00:00.000Z`});
  assert.equal(rebuilt[key].input, 1_000_000, 'a partly covered day must not lose 999,700 tokens');
  assert.equal(rebuilt[key].preCorrection, true);
});

test('the long-context rule cannot be switched off by a field on an event', () => {
  const long = {id: 'long', provider: 'openai', model: 'gpt-5.6-sol', timestamp: `${DAY}T01:00:00.000Z`,
    aggregate: true, tokens: {input: 300_000, cachedInput: 0, cacheWrite: 0, output: 10, reasoningOutput: 0},
    inferenceGeo: null};
  assert.equal(estimateEvent(long, registry).cost.central, null, 'only the caller may declare an aggregate');
  assert.ok(estimateEvent(long, registry, 'unknown', {aggregate: true}).cost.central > 0);
});

// Zones ahead of and behind UTC: a local day maps onto two UTC days, so the
// totals that can supply it sit either side of the period's UTC dates.
test('a partly covered day is not lost in any time zone', () => {
  const calls = [call(1, 1), call(2, 5), call(3, 14), call(4, 20)];
  const daily = updateDaily({}, [], calls);
  const survived = [call(4, 20)];
  for (const timeZone of ['UTC', 'Australia/Sydney', 'America/Los_Angeles', 'Pacific/Chatham', 'Asia/Kolkata']) {
    for (const period of ['today', '7d', '30d']) {
      const summary = buildSummary(survived, registry, 'unknown',
        {settings: {period}, daily, now: NOW, timeZone, detailCompleteFrom: `${DAY}T18:00:00.000Z`});
      assert.ok(summary.calls >= 4, `${timeZone} ${period} reported ${summary.calls} of 4`);
      assert.match(reportHtml(summary), /daily total/i, `${timeZone} ${period} must disclose the basis`);
    }
  }
});

test('a day with detail for one model still reports another model from its total', () => {
  const claude = call(1, 2);
  const codex = {...call(2, 3, 'gpt-5.6-sol', 'openai'), id: 'codex-1'};
  const daily = updateDaily({}, [], [claude, codex]);
  const summary = buildSummary([claude], registry, 'unknown',
    {settings: {period: '30d'}, daily, now: NOW, timeZone: 'UTC', detailCompleteFrom: `${DAY}T00:00:00.000Z`});
  assert.equal(summary.calls, 2, 'one model having detail must not hide another model of the same day');
  assert.equal(summary.providers.openai.calls, 1);
});

test('a rebuild never replaces a day with a smaller record, however the logs rotated', () => {
  const key = `${DAY}|anthropic|claude-opus-5`;
  const carried = {[key]: {date: DAY, provider: 'anthropic', model: 'claude-opus-5', calls: 10, input: 10_000,
    cachedInput: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 1000, reasoningOutput: 0}};
  const remaining = [call(1, 1), call(2, 2)];
  const rebuilt = rebuildDaily(carried, remaining, {});
  assert.equal(rebuilt[key].calls, 10, 'a day whose logs partly rotated away must not shrink');
  assert.equal(rebuilt[key].preCorrection, true);
});

test('a rebuild supersedes a row whose calls moved to another pricing tier', () => {
  // The upgrade case: version 0.2 recorded these calls with no tier; the
  // corrected parse finds the same calls were made on a non-standard tier.
  const standardKey = `${DAY}|anthropic|claude-opus-5`;
  const carried = {[standardKey]: {date: DAY, provider: 'anthropic', model: 'claude-opus-5', calls: 3, input: 3000,
    cachedInput: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 300, reasoningOutput: 0}};
  const flagged = [call(1, 1), call(2, 2), call(3, 3)].map((event) => ({...event, nonStandardTier: true}));
  const rebuilt = rebuildDaily(carried, flagged, {});
  assert.equal(Object.keys(rebuilt).length, 1, 'the same calls must not appear under two tier keys');
  assert.equal(rebuilt[`${standardKey}|non-standard`].calls, 3);
  assert.equal(rebuilt[standardKey], undefined);
});

test('a report opened after a failed refresh says its figures are stale', () => {
  const {afternoon, daily} = partlyCoveredDay();
  const summary = buildSummary(afternoon, registry, 'unknown',
    {settings: {period: '30d'}, daily, now: NOW, timeZone: 'UTC'});
  assert.doesNotMatch(reportHtml(summary), /could not be updated/i);
  assert.match(reportHtml({...summary, stale: true}), /could not be updated/i);
});

test('a cumulative period is never labelled as today', () => {
  const {afternoon, daily} = partlyCoveredDay();
  const summary = buildSummary(afternoon, registry, 'unknown',
    {settings: {period: 'cumulative'}, daily, now: NOW, timeZone: 'UTC'});
  const html = reportHtml(summary);
  assert.match(html, /Everything recorded/i);
  assert.doesNotMatch(html, /Today, 18 Sept 2026 · from midnight/);
});
