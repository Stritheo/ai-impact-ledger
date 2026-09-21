'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/data/impact-registry.v1.json');
const {buildSummary, reportHtml} = require('../src/core/report');

function event(id, provider, model, input) {
  return {id, provider, model, timestamp: '2026-09-14T00:00:00Z',
    tokens: {input, cachedInput: 0, cacheWrite: 0, output: 0, reasoningOutput: 0}, inferenceGeo: null};
}

function sample() {
  return buildSummary([
    event('a', 'anthropic', 'claude-opus-5', 1000),
    event('b', 'openai', 'gpt-5.6-sol', 2000),
    event('c', 'openai', 'gpt-5.6-luna', 3000)
  ], registry, 'unknown', {period: 'today', now: new Date('2026-09-14T00:15:00Z'), timeZone: 'Australia/Sydney'});
}

test('header explains purpose and links settings and How to without repeating the date', () => {
  const summary = sample();
  assert.equal(summary.tokens, 6000);
  const html = reportHtml(summary);
  assert.match(html, /A dashboard to track the cost and impacts of your AI work/);
  assert.match(html, /href="command:aiImpactLedger\.openSettings"[^>]*>settings<\/a>/);
  assert.deepEqual([...html.matchAll(/href="command:([^"]+)"/g)].map((match) => match[1]), ['aiImpactLedger.openSettings']);
  assert.match(html, /<a href="#how-to">How to read this report<\/a>/);
  assert.match(html, /id="how-to"/);
  assert.match(html, /Australia\/Sydney.*14 Sept? 2026.*from midnight to last check at 10:15/);
  assert.match(html, /3 model calls.*6,000 tokens/);
  assert.doesNotMatch(html, /2026-09-14 to 2026-09-14/);
  assert.doesNotMatch(html, /registry 2026-/);
});

test('contribution bar gives both providers explicit proportional colours and aligned columns', () => {
  const html = reportHtml(sample());
  assert.match(html, /class="bar-segment claude"/);
  assert.match(html, /class="bar-segment codex"/);
  const segmentWidths = [...html.matchAll(/#contribution-(?:claude|codex)\{width:([\d.]+)%\}/g)]
    .map((match) => Number(match[1]));
  assert.equal(segmentWidths.length, 2);
  assert.ok(Math.abs(segmentWidths[0] + segmentWidths[1] - 100) < 0.02);
  assert.match(html, /Claude [\d.]+ percent; Codex [\d.]+ percent/);
  assert.match(html, /--vscode-charts-blue/);
  assert.match(html, /--vscode-charts-orange/);
  assert.match(html, /table-layout:fixed/);
  assert.doesNotMatch(html, /energy share of this period \(estimated\)/);
});

test('partial cost, scenario ranges and water boundary use plain English', () => {
  const html = reportHtml(sample());
  assert.match(html, /1 call has no reference price or reconstructable cache duration/);
  assert.doesNotMatch(html, /plus unpriced usage/);
  assert.match(html, /On-site cooling water/);
  assert.match(html, /lower bound not established/i);
  assert.doesNotMatch(html, /0\.000–/);
  assert.match(html, /How the calculations work/);
  assert.match(html, /not a statistical confidence interval/i);
  assert.match(html, /electricity generation.*not included/i);
});

test('monitor describes measured time and leaves local energy and water unclaimed', () => {
  const summary = sample();
  summary.monitor = {durationMs: 206, filesRead: 1, unchangedFiles: 493, filesSkipped: 0, linesSkipped: 0};
  const html = reportHtml(summary);
  assert.match(html, /Last check took 206 ms/);
  assert.match(html, /no AI calls/i);
  assert.match(html, /computer electricity and water use.*not been measured/i);
});
