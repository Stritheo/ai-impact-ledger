'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createLineAccumulator} = require('../src/core/parsers');
const {projectKey} = require('../src/core/security');
const {scanRoot} = require('../src/core/scanner');
const {buildUsageExport} = require('../src/core/usage-export');
const {run} = require('../src/cli/usage-export');
const registry = require('../src/data/impact-registry.v1.json');

const claudeLine = (fields) => JSON.stringify({type: 'assistant', requestId: 'r1', timestamp: '2026-10-08T01:00:00Z',
  message: {model: 'claude-sonnet-5', usage: {input_tokens: 10, output_tokens: 2}}, ...fields});
const codexUsage = (fields) => JSON.stringify({type: 'token_usage_record', timestamp: '2026-10-08T01:00:00Z',
  payload: {response_id: 'resp-1', turn_id: 't1', usage: {input_tokens: 100, cached_input_tokens: 40, output_tokens: 5}}, ...fields});

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('project key is a deterministic hash of the absolute folder, never the folder itself', () => {
  const key = projectKey('/work/alpha');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(projectKey('/work/alpha/'), key);
  assert.equal(projectKey('/work/beta/../alpha'), key);
  assert.notEqual(projectKey('/work/beta'), key);
  assert.equal(key, crypto.createHash('sha256').update('ai-impact-ledger/project/v1:/work/alpha').digest('hex'));
  for (const refused of ['relative/folder', '', null, 42, `/${'a'.repeat(5000)}`]) assert.equal(projectKey(refused), null);
});

test('a Claude session is attributed to the folder it started in, only when asked', () => {
  const lines = [
    JSON.stringify({type: 'user', cwd: '/work/alpha', message: {content: 'secret prompt'}}),
    claudeLine({cwd: '/work/alpha/.claude/worktrees/drifted'}),
    claudeLine({requestId: 'r2', cwd: '/work/other'})
  ];
  const attributed = createLineAccumulator('anthropic', 'session.jsonl', {project: true});
  for (const line of lines) attributed.add(line);
  const events = attributed.events();
  assert.equal(events.length, 2);
  for (const event of events) assert.equal(event.project, projectKey('/work/alpha'));
  assert.doesNotMatch(JSON.stringify(events), /work|secret/);

  const plain = createLineAccumulator('anthropic', 'session.jsonl');
  for (const line of lines) plain.add(line);
  for (const event of plain.events()) assert.equal(Object.hasOwn(event, 'project'), false);
});

test('a Codex session is attributed to its session folder, and a session without one is unattributed', () => {
  const accumulator = createLineAccumulator('openai', 'rollout.jsonl', {project: true});
  accumulator.add(JSON.stringify({type: 'session_meta', payload: {cwd: '/work/beta', instructions: 'secret'}}));
  accumulator.add(JSON.stringify({type: 'turn_context', timestamp: '2026-10-08T01:00:00Z', payload: {turn_id: 't1', model: 'gpt-5.6-terra', cwd: '/work/beta/sub'}}));
  accumulator.add(codexUsage());
  const [event] = accumulator.events();
  assert.equal(event.project, projectKey('/work/beta'));
  assert.doesNotMatch(JSON.stringify(event), /work|secret/);

  const orphan = createLineAccumulator('anthropic', 'session.jsonl', {project: true});
  orphan.add(claudeLine({}));
  assert.equal(orphan.events()[0].project, null);
});

test('scanner leaves files last written before the window unread and counts them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-window-'));
  fs.writeFileSync(path.join(root, 'old.jsonl'), claudeLine({requestId: 'old'}));
  fs.writeFileSync(path.join(root, 'new.jsonl'), claudeLine({requestId: 'new', cwd: '/work/alpha'}));
  const longAgo = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(path.join(root, 'old.jsonl'), longAgo, longAgo);
  const windowed = await scanRoot(root, 'anthropic', {}, '', {modifiedSince: Date.parse('2026-06-01T00:00:00Z'), project: true});
  assert.equal(windowed.diagnostics.filesRead, 1);
  assert.equal(windowed.diagnostics.filesBeforeWindow, 1);
  assert.deepEqual(windowed.events.map((event) => event.id), ['claude:new']);
  assert.equal(windowed.events[0].project, projectKey('/work/alpha'));

  const full = await scanRoot(root, 'anthropic');
  assert.equal(full.diagnostics.filesRead, 2);
  assert.equal(full.events.some((event) => Object.hasOwn(event, 'project')), false);
});

// 14:00 on 8 October in Sydney, daylight time (UTC+11). The month opened in
// standard time (UTC+10), so the boundaries below sit on local midnights.
const NOW = new Date('2026-10-08T03:00:00Z');
const ZONE = 'Australia/Sydney';

function event(id, timestamp, fields = {}) {
  return {id, provider: 'anthropic', model: 'claude-sonnet-5', timestamp, inferenceGeo: null, project: 'k1',
    tokens: {input: 1, cachedInput: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoningOutput: 0}, ...fields};
}

test('each window holds exactly the calls inside its local or rolling bounds', () => {
  const events = [
    event('in-5h', '2026-10-08T01:00:00Z'),
    event('5h-edge', '2026-10-07T22:00:00Z'),
    event('before-5h', '2026-10-07T21:59:59Z'),
    event('local-today-utc-yesterday', '2026-10-07T13:30:00Z'),
    event('local-yesterday', '2026-10-07T12:59:00Z'),
    event('week-first-day', '2026-10-01T14:30:00Z'),
    event('before-week', '2026-10-01T13:30:00Z'),
    event('month-first-instant', '2026-09-30T14:00:00Z'),
    event('before-month', '2026-09-30T13:59:59Z'),
    event('after-now', '2026-10-08T03:00:01Z')
  ];
  const result = buildUsageExport(events, registry, {now: NOW, timeZone: ZONE});
  assert.deepEqual(Object.fromEntries(Object.entries(result.totals).map(([name, figures]) => [name, figures.calls])),
    {fiveHours: 2, day: 4, week: 6, month: 8});
  assert.deepEqual(result.windows.fiveHours, {from: '2026-10-07T22:00:00.000Z', to: '2026-10-08T03:00:00.000Z', basis: 'rolling'});
  assert.deepEqual(result.windows.day, {from: '2026-10-08', to: '2026-10-08', basis: 'local calendar days'});
  assert.deepEqual(result.windows.week, {from: '2026-10-02', to: '2026-10-08', basis: 'local calendar days'});
  assert.deepEqual(result.windows.month, {from: '2026-10-01', to: '2026-10-08', basis: 'local calendar days'});
  assert.equal(result.timeZone, ZONE);
});

test('figures are priced from the registry, split by provider and project, and unpriced calls are disclosed', () => {
  const events = [
    event('a', '2026-10-08T01:00:00Z', {tokens: {input: 1_000_000, cachedInput: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 100_000, reasoningOutput: 0}}),
    event('a', '2026-10-08T01:00:00Z', {tokens: {input: 1_000_000, cachedInput: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 100_000, reasoningOutput: 0}}),
    event('b', '2026-10-08T02:00:00Z', {provider: 'openai', model: 'gpt-5.6-terra', project: 'k2', tokens: {input: 100_000, cachedInput: 50_000, cacheWrite: 0, output: 0, reasoningOutput: 0}}),
    event('c', '2026-10-08T02:30:00Z', {model: 'claude-opus-9', project: null, tokens: {input: 7, cachedInput: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 3, reasoningOutput: 0}})
  ];
  const result = buildUsageExport(events, registry, {now: NOW, timeZone: ZONE});
  const window = result.totals.fiveHours;
  assert.equal(window.calls, 3);
  assert.deepEqual(window.tokens, {input: 1_100_007, cachedInput: 50_000, cacheWrite: 0, output: 100_003, total: 1_250_010});
  assert.equal(window.costUsd, 3.21);
  assert.equal(window.unpricedCalls, 1);
  assert.equal(window.unpricedTokens, 10);
  assert.equal(window.byProvider.anthropic.calls, 2);
  assert.equal(window.byProvider.anthropic.costUsd, 3);
  assert.equal(window.byProvider.openai.costUsd, 0.21);
  assert.deepEqual(Object.keys(result.projects).sort(), ['k1', 'k2', 'unattributed']);
  assert.equal(result.projects.k1.month.costUsd, 3);
  assert.equal(result.projects.k2.day.tokens.total, 150_000);
  assert.equal(result.projects.unattributed.week.unpricedCalls, 1);
  assert.equal(result.coverage.duplicateCalls, 1);
  assert.equal(result.coverage.unattributedCalls, 1);
  assert.equal(result.cost.currency, 'USD');
  assert.equal(result.cost.registryReviewedAt, registry.reviewedAt);
});

test('a window with no calls reports zeros rather than leaving the figure out', () => {
  const result = buildUsageExport([], registry, {now: NOW, timeZone: ZONE});
  assert.deepEqual(result.totals.day, {calls: 0, tokens: {input: 0, cachedInput: 0, cacheWrite: 0, output: 0, total: 0},
    costUsd: 0, unpricedCalls: 0, unpricedTokens: 0,
    byProvider: Object.fromEntries(['anthropic', 'openai'].map((provider) => [provider,
      {calls: 0, tokens: {input: 0, cachedInput: 0, cacheWrite: 0, output: 0, total: 0}, costUsd: 0, unpricedCalls: 0, unpricedTokens: 0}]))});
  assert.deepEqual(result.projects, {});
});

function fixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-export-'));
  const claude = path.join(home, 'claude', '-fixture-alpha-project');
  const codex = path.join(home, 'codex', '2026', '10', '08');
  fs.mkdirSync(claude, {recursive: true});
  fs.mkdirSync(codex, {recursive: true});
  const recent = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(path.join(claude, 'session.jsonl'), [
    JSON.stringify({type: 'user', cwd: '/fixture/alpha-project', message: {content: 'a private prompt'}}),
    claudeLine({timestamp: recent, cwd: '/fixture/alpha-project'})
  ].join('\n'));
  fs.writeFileSync(path.join(codex, 'rollout-1.jsonl'), [
    JSON.stringify({type: 'session_meta', payload: {cwd: '/fixture/beta-project'}}),
    JSON.stringify({type: 'turn_context', timestamp: recent, payload: {turn_id: 't1', model: 'gpt-5.6-terra'}}),
    codexUsage({timestamp: recent})
  ].join('\n'));
  return {home, claudeRoot: path.join(home, 'claude'), codexRoot: path.join(home, 'codex'),
    logs: [path.join(claude, 'session.jsonl'), path.join(codex, 'rollout-1.jsonl')]};
}

function listing(directory) {
  return fs.readdirSync(directory, {recursive: true}).sort();
}

function capture() {
  let text = '';
  return {write: (chunk) => { text += chunk; return true; }, get text() { return text; }};
}

test('the command writes a private export without paths and changes nothing it reads', async () => {
  const fixture = fixtureHome();
  const before = fixture.logs.map((file) => [hash(file), fs.statSync(file).mtimeMs]);
  const filesBefore = listing(fixture.home);
  const out = path.join(fixture.home, 'usage.json');
  const stdout = capture();
  const stderr = capture();
  const code = await run(['--out', out, '--claude-root', fixture.claudeRoot, '--codex-root', fixture.codexRoot], {stdout, stderr});
  assert.equal(code, 0, stderr.text);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const text = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(text, /fixture|alpha|beta|private prompt|impact-export-/);
  const result = JSON.parse(text);
  assert.equal(result.schema, 'ai-impact-ledger.usage-export.v1');
  assert.equal(result.totals.fiveHours.calls, 2);
  assert.equal(result.totals.fiveHours.byProvider.anthropic.calls, 1);
  assert.equal(result.totals.fiveHours.byProvider.openai.calls, 1);
  assert.deepEqual(result.coverage.sources, {anthropic: 'read', openai: 'read'});
  assert.deepEqual(fixture.logs.map((file) => [hash(file), fs.statSync(file).mtimeMs]), before);
  assert.deepEqual(listing(fixture.home), [...filesBefore, 'usage.json'].sort());

  const key = capture();
  assert.equal(await run(['--key-for', '/fixture/alpha-project'], {stdout: key, stderr}), 0);
  assert.ok(result.projects[key.text.trim()], 'the printed key matches the exported project');
  assert.ok(result.projects[projectKey('/fixture/beta-project')]);
});

test('the command prints to standard output, reports a missing log root, and refuses unknown arguments', async () => {
  const fixture = fixtureHome();
  const stdout = capture();
  const stderr = capture();
  const code = await run(['--claude-root', fixture.claudeRoot, '--codex-root', path.join(fixture.home, 'absent')], {stdout, stderr});
  assert.equal(code, 0, stderr.text);
  const result = JSON.parse(stdout.text);
  assert.deepEqual(result.coverage.sources, {anthropic: 'read', openai: 'missing'});
  assert.equal(result.totals.day.byProvider.openai.calls, 0);

  const refused = capture();
  assert.equal(await run(['--upload', 'somewhere'], {stdout: capture(), stderr: refused}), 2);
  assert.match(refused.text, /unknown argument/i);
  assert.equal(await run(['--out'], {stdout: capture(), stderr: capture()}), 2);
});
