'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/data/impact-registry.v1.json');
const {buildSummary, reportHtml} = require('../src/core/report');
const {normaliseSettings, convertCost, convertWater} = require('../src/core/settings');

function event(id, timestamp, provider, model, input = 1000) {
  return {id, timestamp, provider, model, tokens: {input, cachedInput: 0, cacheWrite: 0, output: 0, reasoningOutput: 0}, inferenceGeo: null};
}

test('seven local calendar days include Sydney DST boundary and exclude the eighth', () => {
  const now = new Date('2026-10-05T02:00:00Z');
  const events = [
    event('a', '2026-09-28T13:30:00Z', 'anthropic', 'claude-opus-5'),
    event('b', '2026-09-29T14:30:00Z', 'anthropic', 'claude-opus-5'),
    event('c', '2026-10-04T13:30:00Z', 'openai', 'gpt-5.6-terra')
  ];
  const summary = buildSummary(events, registry, 'unknown', {period: '7d', now, timeZone: 'Australia/Sydney'});
  assert.equal(summary.calls, 2);
  assert.equal(summary.start, '2026-09-29');
  assert.equal(summary.end, '2026-10-05');
  assert.equal(summary.timeZone, 'Australia/Sydney');
});

test('provider contributions reconcile and unpriced cost is clearly partial', () => {
  const now = new Date('2026-09-13T04:00:00Z');
  const events = [event('a', '2026-09-13T01:00:00Z', 'anthropic', 'claude-opus-5'),
    event('b', '2026-09-13T02:00:00Z', 'openai', 'gpt-5.6-luna')];
  const summary = buildSummary(events, registry, 'unknown', {period: 'today', now, timeZone: 'Australia/Sydney'});
  assert.equal(summary.providers.anthropic.calls + summary.providers.openai.calls, summary.calls);
  // Provider shares use the midpoint of the energy range (17 September 2026).
  assert.equal(summary.providers.anthropic.energyWh + summary.providers.openai.energyWh, summary.total.energyWh.mid);
  assert.equal(summary.total.hasUnknownCost, true);
  assert.match(reportHtml(summary), /no reference price/);
  assert.match(reportHtml(summary), /Claude/);
  assert.match(reportHtml(summary), /Codex/);
});

test('model contribution is hidden until selected and reconciles to each provider', () => {
  const now = new Date('2026-09-13T04:00:00Z');
  const summary = buildSummary([
    event('a', '2026-09-13T01:00:00Z', 'anthropic', 'claude-opus-5', 1000),
    event('b', '2026-09-13T01:00:00Z', 'anthropic', 'claude-sonnet-5', 2000),
    event('c', '2026-09-13T01:00:00Z', 'openai', 'gpt-5.6-terra', 3000)
  ], registry, 'unknown', {period: 'today', now, timeZone: 'Australia/Sydney'});
  assert.equal(summary.models.anthropic.reduce((sum, row) => sum + row.calls, 0), summary.providers.anthropic.calls);
  assert.equal(summary.models.openai.reduce((sum, row) => sum + row.energyWh, 0), summary.providers.openai.energyWh);
  const html = reportHtml(summary);
  assert.match(html, /<details><summary>Show model contribution<\/summary>/);
  assert.match(html, /claude-opus-5/);
  assert.match(html, /claude-sonnet-5/);
  assert.match(html, /gpt-5\.6-terra/);
});

test('presentation settings fail safely and never change canonical USD or litres', () => {
  const invalid = normaliseSettings({currency: 'NZD', waterUnits: '<script>', period: 'yesterday'});
  assert.equal(invalid.currency, 'USD');
  assert.equal(invalid.waterUnits, 'metric');
  assert.equal(invalid.period, 'today');
  const aud = normaliseSettings({currency: 'AUD', waterUnits: 'us', showAnalogy: false});
  assert.equal(convertCost(1, aud.currency).value.toFixed(4), '1.3942');
  assert.equal(convertWater(3.785411784, aud.waterUnits).value, 1);
  const uk = normaliseSettings({waterUnits: 'uk'});
  assert.equal(convertWater(4.54609, uk.waterUnits).value, 1);
});

test('report can hide analogy but cannot hide method and uncertainty', () => {
  const summary = buildSummary([event('a', '2026-09-13T01:00:00Z', 'openai', 'gpt-5.6-terra')], registry, 'unknown',
    {period: 'today', now: new Date('2026-09-13T04:00:00Z'), timeZone: 'Australia/Sydney', settings: {showAnalogy: false, currency: 'AUD'}});
  const html = reportHtml(summary);
  assert.doesNotMatch(html, /In everyday terms/);
  assert.match(html, /API-equivalent/);
  assert.match(html, /11 Sept? 2026/);
  assert.match(html, /inference operations only/);
  assert.match(html, /Australia\/Sydney.*13 Sept? 2026/);
});

test('cumulative report uses older daily totals without counting retained detail twice', () => {
  const today = event('new', '2026-09-13T01:00:00Z', 'openai', 'gpt-5.6-terra');
  const daily = {
    '2026-01-01|anthropic|claude-opus-5': {date: '2026-01-01', provider: 'anthropic', model: 'claude-opus-5', calls: 4,
      input: 4000, cachedInput: 0, cacheWrite: 0, output: 0, reasoningOutput: 0},
    '2026-09-13|openai|gpt-5.6-terra': {date: '2026-09-13', provider: 'openai', model: 'gpt-5.6-terra', calls: 1,
      input: 1000, cachedInput: 0, cacheWrite: 0, output: 0, reasoningOutput: 0}
  };
  const summary = buildSummary([today], registry, 'unknown', {period: 'cumulative', daily, now: new Date('2026-09-13T04:00:00Z'), timeZone: 'Australia/Sydney'});
  assert.equal(summary.calls, 5);
  assert.equal(summary.providers.anthropic.calls, 4);
  assert.equal(summary.providers.openai.calls, 1);
  assert.equal(summary.historicalUtc, true);
  assert.match(reportHtml(summary), /Historical daily totals use UTC dates/);
});

test('unknown processing location cannot be promoted to local water-stress evidence by a setting', () => {
  const summary = buildSummary([], registry, 'water-stressed-or-slow-recharge', {settings: {showAnalogy: false}});
  const html = reportHtml(summary);
  assert.doesNotMatch(html, /higher community and replenishment risk/);
  assert.match(html, /water source are unknown/);
  assert.match(html, /low-to-medium/);
  assert.match(html, /Infrastructure location is not verified/);
});

test('report states incomplete coverage when a source line was too large', () => {
  const summary = buildSummary([], registry, 'unknown');
  summary.monitor = {durationMs: 1, filesRead: 1, unchangedFiles: 0, filesSkipped: 0, linesSkipped: 1};
  assert.match(reportHtml(summary), /1 log line skipped; totals may be incomplete/);
});
