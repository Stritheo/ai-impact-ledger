// Monthly evidence check. Reads the registry, fetches each cited source and
// compares it with a stored baseline. It never writes to the registry and
// never republishes fetched content: only a status and a hash leave this
// script, because a source page is untrusted data.
import crypto from 'node:crypto';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

const MAX_BYTES = 8 * 1024 * 1024;
const BASELINE_FILE = 'evidence/source-baselines.json';

// A registry edit must not be able to point the checker anywhere new.
const ALLOWED_HOSTS = Object.freeze({
  'ml.energy': {mode: 'json', checkPath: '/leaderboard/data/index.json'},
  'arxiv.org': {mode: 'html'},
  'eta-publications.lbl.gov': {mode: 'binary'},
  'www.iea.org': {mode: 'manual'},
  'platform.claude.com': {mode: 'html', markers: ['Claude Opus 5', 'Prompt caching', 'Cache write']},
  'developers.openai.com': {mode: 'html', markers: ['Cached input']},
  'www.ecb.europa.eu': {mode: 'structure', markers: ['reference rates']}
});

// Two sources share a host, so their structure markers are keyed by entry.
const MARKERS_BY_ID = Object.freeze({
  'google-full-system-2026-09-17': ['Measuring the environmental impact'],
  'mlenergy-benchmark-paper-2026-09-18': ['ML.ENERGY Benchmark']
});

export function sourcesFrom(registry, fxRegistry) {
  const entries = [...Object.entries(registry.evidence).map(([id, entry]) => [id, entry.sourceUrl, entry]),
    ['fx-reference-rates', fxRegistry.source, fxRegistry]];
  const seen = new Map();
  for (const [id, url, entry] of entries) {
    const host = new URL(url).hostname;
    const rule = ALLOWED_HOSTS[host];
    if (!rule) throw new Error(`source host is outside the fixed allowlist: ${host}`);
    if (seen.has(url)) continue;
    seen.set(url, {id, url, checkUrl: rule.checkPath ? new URL(rule.checkPath, url).toString() : url,
      mode: rule.mode, markers: MARKERS_BY_ID[id] || rule.markers || [],
      reviewedAt: entry.reviewedAt, nextReviewDue: entry.nextReviewDue});
  }
  return [...seen.values()];
}

// Pages carry build identifiers, scripts and reflowed whitespace that change
// without the figures changing. Hashing the visible text keeps the monthly
// check meaningful instead of failing every run.
function normalisedText(body) {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readBounded(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error('source exceeds size limit');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error('source exceeds size limit');
  return buffer;
}

export async function checkSources(sources, {fetcher = fetch, baselines = {}, now = new Date()} = {}) {
  const results = [];
  for (const source of sources) {
    if (source.mode === 'manual') {
      const due = Date.parse(source.nextReviewDue);
      results.push({id: source.id, url: source.url, mode: source.mode,
        status: Number.isFinite(due) && due >= now.getTime() ? 'manual-ok' : 'manual-review-due',
        note: 'source refuses automated clients; reviewed by hand'});
      continue;
    }
    try {
      const response = await fetcher(source.checkUrl, {redirect: 'manual', credentials: 'omit',
        signal: AbortSignal.timeout(20_000), headers: {accept: 'text/html, application/xml, application/json, application/pdf'}});
      if (!response.ok || response.redirected || (response.status >= 300 && response.status < 400)) throw new Error('unexpected HTTP response');
      const buffer = await readBounded(response);
      const isText = source.mode !== 'binary';
      const body = isText ? buffer.toString('utf8') : '';
      if (source.markers.some((marker) => !body.includes(marker))) {
        results.push({id: source.id, url: source.url, mode: source.mode, status: 'structure-changed'});
        continue;
      }
      if (source.mode === 'structure') {
        results.push({id: source.id, url: source.url, mode: source.mode, status: 'unchanged',
          note: 'checked for structure only: this source changes daily by design'});
        continue;
      }
      const material = source.mode === 'html' ? Buffer.from(normalisedText(body), 'utf8') : buffer;
      const sha256 = crypto.createHash('sha256').update(material).digest('hex');
      const baseline = baselines[source.id]?.sha256;
      results.push({id: source.id, url: source.url, mode: source.mode, sha256,
        status: !baseline ? 'no-baseline' : baseline === sha256 ? 'unchanged' : 'changed'});
    } catch (error) {
      results.push({id: source.id, url: source.url, mode: source.mode, status: 'blocked', reason: error.message});
    }
  }
  return results;
}

export function exitCodeFor(results) {
  return results.every((result) => result.status === 'unchanged' || result.status === 'manual-ok') ? 0 : 1;
}

// Only our own identifiers, statuses and hashes are written: never any part of
// a fetched page, which could otherwise plant markup in the job summary.
export function summaryMarkdown(results, now = new Date()) {
  const rows = results.map((result) => `| ${result.id} | ${result.mode} | ${result.status} | ${result.sha256 ? result.sha256.slice(0, 16) : 'n/a'} |`);
  const failing = results.filter((result) => result.status !== 'unchanged' && result.status !== 'manual-ok');
  return [`## Evidence review ${now.toISOString().slice(0, 10)}`, '',
    '| Source | Mode | Status | Hash (first 16) |', '|---|---|---|---|', ...rows, '',
    failing.length
      ? `${failing.length} source(s) need a human review before any registry figure is trusted: ${failing.map((result) => result.id).join(', ')}.`
      : 'All sources match their recorded baselines. No registry figure was changed by this run.'].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const registry = JSON.parse(fs.readFileSync('src/data/impact-registry.v1.json', 'utf8'));
  const fxRegistry = JSON.parse(fs.readFileSync('src/data/fx-registry.v1.json', 'utf8'));
  const baselines = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).sources : {};
  const sources = sourcesFrom(registry, fxRegistry);
  const results = await checkSources(sources, {baselines});
  const now = new Date();
  process.stdout.write(`${JSON.stringify({checkedAt: now.toISOString(), results}, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryMarkdown(results, now)}\n`);
  if (process.argv.includes('--write-baselines')) {
    const stored = {capturedAt: now.toISOString(), sources: {}};
    for (const result of results) if (result.sha256) stored.sources[result.id] = {url: result.url, sha256: result.sha256, capturedAt: now.toISOString()};
    fs.mkdirSync('evidence', {recursive: true});
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(stored, null, 2)}\n`);
  }
  process.exitCode = exitCodeFor(results);
}
