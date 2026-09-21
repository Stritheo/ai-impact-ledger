'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const registry = require('../src/data/impact-registry.v1.json');
const fxRegistry = require('../src/data/fx-registry.v1.json');

const load = () => import('../scripts/check-evidence.mjs');
const NOW = new Date('2026-09-18T00:00:00Z');

test('every source the registry cites is checked, and nothing else can be', async () => {
  const {sourcesFrom} = await load();
  const sources = sourcesFrom(registry, fxRegistry);
  const cited = new Set([...Object.values(registry.evidence).map((entry) => entry.sourceUrl), fxRegistry.source]);
  assert.deepEqual(new Set(sources.map((source) => source.url)), cited, 'coverage must follow the registry');
  for (const source of sources) assert.match(source.checkUrl, /^https:\/\//);

  const hostile = {...registry, evidence: {...registry.evidence,
    planted: {...Object.values(registry.evidence)[0], sourceUrl: 'https://evil.example/prices'}}};
  assert.throws(() => sourcesFrom(hostile, fxRegistry), /allowlist/, 'a registry edit cannot redirect the checker');
});

test('a source is unchanged only when its baseline hash still matches', async () => {
  const {checkSources} = await load();
  const page = '<html><head><script>window.build="abc123"</script></head><body><h1>Prices</h1>' +
    '<p>Input $4.00</p> <p>Cached input $0.40</p></body></html>';
  const source = {id: 'openai-sol', url: 'https://developers.openai.com/x', checkUrl: 'https://developers.openai.com/x',
    mode: 'html', markers: ['Cached input']};
  const respond = (body) => async () => new Response(body, {headers: {'content-type': 'text/html'}});

  const first = await checkSources([source], {fetcher: respond(page), baselines: {}, now: NOW});
  assert.equal(first[0].status, 'no-baseline');
  assert.match(first[0].sha256, /^[a-f0-9]{64}$/);

  const baselines = {'openai-sol': {sha256: first[0].sha256}};
  // Only scripts, whitespace and a build identifier differ: the tracked text
  // is the same, so a monthly run must not cry wolf.
  const cosmetic = '<html><head><script>window.build="zzz999"</script></head>\n<body>  <h1>Prices</h1>\n' +
    '<p>Input $4.00</p>\n<p>Cached input   $0.40</p>\n</body></html>';
  const unchanged = await checkSources([source], {fetcher: respond(cosmetic), baselines, now: NOW});
  assert.equal(unchanged[0].status, 'unchanged');

  const repriced = page.replace('$4.00', '$4.50');
  const changed = await checkSources([source], {fetcher: respond(repriced), baselines, now: NOW});
  assert.equal(changed[0].status, 'changed');

  const restructured = page.replace('Cached input', 'Cached tokens');
  const structure = await checkSources([source], {fetcher: respond(restructured), baselines, now: NOW});
  assert.equal(structure[0].status, 'structure-changed');

  const blocked = await checkSources([source], {fetcher: async () => new Response('', {status: 403}), baselines, now: NOW});
  assert.equal(blocked[0].status, 'blocked');
});

test('a source that refuses automated clients is declared manual and falls due', async () => {
  const {checkSources} = await load();
  const source = {id: 'iea-electricity', url: 'https://www.iea.org/x', checkUrl: 'https://www.iea.org/x',
    mode: 'manual', reviewedAt: '2026-09-15', nextReviewDue: '2026-10-15'};
  let fetched = false;
  const fetcher = async () => { fetched = true; return new Response('x'); };
  const current = await checkSources([source], {fetcher, baselines: {}, now: NOW});
  assert.equal(current[0].status, 'manual-ok');
  assert.equal(fetched, false, 'a manual source is never fetched');
  const overdue = await checkSources([source], {fetcher, baselines: {}, now: new Date('2026-10-16T00:00:00Z')});
  assert.equal(overdue[0].status, 'manual-review-due');
});

test('the run fails unless every source is unchanged or a current manual review', async () => {
  const {exitCodeFor} = await load();
  assert.equal(exitCodeFor([{status: 'unchanged'}, {status: 'manual-ok'}]), 0);
  for (const status of ['changed', 'structure-changed', 'blocked', 'manual-review-due', 'no-baseline']) {
    assert.equal(exitCodeFor([{status: 'unchanged'}, {status}]), 1, status);
  }
});

test('the job summary carries statuses and hashes, never page content', async () => {
  const {checkSources, summaryMarkdown} = await load();
  const hostile = '<html><body>Cached input <script>alert(1)</script>' +
    '| [click me](https://evil.example) <img src=x onerror=alert(1)> SECRETMARKER</body></html>';
  const source = {id: 'openai-sol', url: 'https://developers.openai.com/x', checkUrl: 'https://developers.openai.com/x',
    mode: 'html', markers: ['Cached input']};
  const results = await checkSources([source], {fetcher: async () => new Response(hostile, {headers: {'content-type': 'text/html'}}),
    baselines: {}, now: NOW});
  const markdown = summaryMarkdown(results, NOW);
  assert.match(markdown, /openai-sol/);
  assert.match(markdown, /no-baseline/);
  assert.doesNotMatch(markdown, /SECRETMARKER|alert\(1\)|evil\.example/, 'fetched content is data, never republished');
});

test('the stored baselines cover the registry and are not packaged', async () => {
  const {sourcesFrom} = await load();
  const baselines = JSON.parse(fs.readFileSync('evidence/source-baselines.json', 'utf8'));
  for (const source of sourcesFrom(registry, fxRegistry)) {
    if (source.mode === 'manual' || source.mode === 'structure') continue;
    assert.match(baselines.sources[source.id]?.sha256 || '', /^[a-f0-9]{64}$/, `baseline for ${source.id}`);
  }
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(manifest.files.includes('evidence'), false, 'baselines are not shipped to users');
});

// Carried over from the previous checker's tests (test/evidence-update.test.js,
// removed with the API it exercised): the checker must fail closed and must
// never return or write a figure.
test('redirected, oversized and unreachable sources fail closed, and no figure is ever returned', async () => {
  const {checkSources} = await load();
  const source = {id: 'openai-sol', url: 'https://developers.openai.com/x', checkUrl: 'https://developers.openai.com/x',
    mode: 'html', markers: []};
  const responses = [
    new Response('', {status: 302, headers: {location: 'https://evil.example'}}),
    new Response('x'.repeat(9 * 1024 * 1024), {headers: {'content-type': 'text/html'}}),
    new Response('', {status: 500})
  ];
  for (const response of responses) {
    const [result] = await checkSources([source], {fetcher: async () => response, baselines: {}, now: NOW});
    assert.equal(result.status, 'blocked');
  }
  const [failed] = await checkSources([source], {fetcher: async () => { throw new Error('offline'); }, baselines: {}, now: NOW});
  assert.equal(failed.status, 'blocked');

  const [ok] = await checkSources([source], {fetcher: async () => new Response('<p>Input $4.00</p>',
    {headers: {'content-type': 'text/html'}}), baselines: {}, now: NOW});
  assert.deepEqual(Object.keys(ok).sort(), ['id', 'mode', 'sha256', 'status', 'url'],
    'a result carries status and hash only: never a price or factor');
});

test('the checker sends no credentials and follows no redirects', async () => {
  const {checkSources} = await load();
  const calls = [];
  await checkSources([{id: 'x', url: 'https://developers.openai.com/x', checkUrl: 'https://developers.openai.com/x',
    mode: 'html', markers: []}], {
    fetcher: async (url, options) => { calls.push({url, options}); return new Response('<p>ok</p>', {headers: {'content-type': 'text/html'}}); },
    baselines: {}, now: NOW});
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.ok(calls[0].options.signal, 'requests are bounded by a timeout');
});

test('a source that changes daily by design is checked for structure, not hashed', async () => {
  const {checkSources} = await load();
  const source = {id: 'fx-reference-rates', url: 'https://www.ecb.europa.eu/x', checkUrl: 'https://www.ecb.europa.eu/x',
    mode: 'structure', markers: ['reference rates']};
  const monday = async () => new Response('<html><body>Euro foreign exchange reference rates 1.6161</body></html>',
    {headers: {'content-type': 'text/html'}});
  const tuesday = async () => new Response('<html><body>Euro foreign exchange reference rates 1.6207</body></html>',
    {headers: {'content-type': 'text/html'}});
  const first = await checkSources([source], {fetcher: monday, baselines: {}, now: NOW});
  const second = await checkSources([source], {fetcher: tuesday, baselines: {}, now: NOW});
  assert.equal(first[0].status, 'unchanged');
  assert.equal(second[0].status, 'unchanged', 'a daily rate change is not a source change');
  assert.equal(second[0].sha256, undefined, 'no baseline hash is kept for a daily source');
  assert.match(second[0].note, /daily/);

  const restructured = await checkSources([source], {
    fetcher: async () => new Response('<html><body>Page moved</body></html>', {headers: {'content-type': 'text/html'}}),
    baselines: {}, now: NOW});
  assert.equal(restructured[0].status, 'structure-changed');
});
