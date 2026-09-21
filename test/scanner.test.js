'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanRoot } = require('../src/core/scanner');

test('scanner reads JSONL beneath the root and ignores links and other files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-scan-'));
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'session.jsonl'), JSON.stringify({type: 'assistant', requestId: 'r1', timestamp: '2026-09-12T00:00:00Z', message: {model: 'claude-sonnet-5', usage: {input_tokens: 10, output_tokens: 2}}}));
  fs.writeFileSync(path.join(nested, 'notes.txt'), 'not a log');
  fs.symlinkSync(path.join(nested, 'session.jsonl'), path.join(root, 'linked.jsonl'));
  const result = await scanRoot(root, 'anthropic');
  assert.equal(result.events.length, 1);
  assert.equal(result.diagnostics.filesRead, 1);
  assert.equal(result.diagnostics.linksSkipped, 1);
});

test('subsequent scans parse only changed files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-incremental-'));
  const log = path.join(root, 'session.jsonl');
  const record = JSON.stringify({type: 'assistant', requestId: 'r1', timestamp: '2026-09-12T00:00:00Z', message: {model: 'claude-sonnet-5', usage: {input_tokens: 10, output_tokens: 2}}});
  fs.writeFileSync(log, record);
  const first = await scanRoot(root, 'anthropic', {});
  const unchanged = await scanRoot(root, 'anthropic', first.checkpoints);
  assert.equal(unchanged.diagnostics.filesRead, 0);
  assert.equal(unchanged.diagnostics.unchangedFiles, 1);
  assert.ok(unchanged.diagnostics.durationMs >= 0);
  fs.appendFileSync(log, `\n${record.replace('r1', 'r2')}`);
  const changed = await scanRoot(root, 'anthropic', unchanged.checkpoints);
  assert.equal(changed.diagnostics.filesRead, 1);
  assert.equal(changed.events.length, 2);
});

test('a failed log open is not checkpointed and is retried on the next scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-retry-'));
  const log = path.join(root, 'session.jsonl');
  fs.writeFileSync(log, JSON.stringify({type: 'assistant', requestId: 'r1', timestamp: '2026-09-12T00:00:00Z',
    message: {model: 'claude-sonnet-5', usage: {input_tokens: 10, output_tokens: 2}}}));
  const original = fs.promises.open;
  fs.promises.open = async (...args) => {
    if (String(args[0]) === fs.realpathSync(log)) throw new Error('simulated transient open failure');
    return original.apply(fs.promises, args);
  };
  let failed;
  try { failed = await scanRoot(root, 'anthropic', {}); }
  finally { fs.promises.open = original; }
  assert.equal(failed.diagnostics.filesSkipped, 1);
  assert.equal(Object.keys(failed.checkpoints).length, 0);
  const retried = await scanRoot(root, 'anthropic', failed.checkpoints);
  assert.equal(retried.events.length, 1);
  assert.equal(retried.diagnostics.filesRead, 1);
});

test('a log swapped to a symlink after path checking cannot read outside the root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-race-'));
  const log = path.join(root, 'session.jsonl');
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'impact-outside-')), 'external.jsonl');
  const record = JSON.stringify({type: 'assistant', requestId: 'external', timestamp: '2026-09-12T00:00:00Z',
    message: {model: 'claude-sonnet-5', usage: {input_tokens: 10, output_tokens: 2}}});
  fs.writeFileSync(log, record.replace('external', 'inside'));
  fs.writeFileSync(outside, record);
  const original = fs.promises.realpath;
  let swapped = false;
  fs.promises.realpath = async (...args) => {
    const canonical = await original.apply(fs.promises, args);
    if (!swapped && path.basename(String(args[0])) === 'session.jsonl') {
      swapped = true;
      fs.renameSync(canonical, `${canonical}.original`);
      fs.symlinkSync(outside, canonical);
    }
    return canonical;
  };
  let result;
  try { result = await scanRoot(root, 'anthropic'); }
  finally { fs.promises.realpath = original; }
  assert.equal(swapped, true);
  assert.equal(result.events.length, 0);
  assert.equal(result.diagnostics.filesSkipped, 1);
});

test('a large log is parsed with bounded lines instead of being silently omitted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-large-'));
  const log = path.join(root, 'session.jsonl');
  const record = (id) => JSON.stringify({type: 'assistant', requestId: id, timestamp: '2026-09-12T00:00:00Z',
    message: {model: 'claude-sonnet-5', usage: {input_tokens: 10, output_tokens: 2}}});
  fs.writeFileSync(log, `${record('first')}\n`);
  fs.truncateSync(log, 33 * 1024 * 1024);
  fs.appendFileSync(log, `\n${record('second')}\n`);
  const result = await scanRoot(root, 'anthropic');
  assert.equal(result.diagnostics.filesRead, 1);
  assert.equal(result.diagnostics.filesSkipped, 0);
  assert.equal(result.diagnostics.linesSkipped, 1);
  assert.deepEqual(result.events.map((event) => event.id).sort(), ['claude:first', 'claude:second']);
  const unchanged = await scanRoot(root, 'anthropic', result.checkpoints);
  assert.equal(unchanged.diagnostics.filesRead, 0);
  assert.equal(unchanged.diagnostics.linesSkipped, 1, 'coverage warning must persist while the file is unchanged');
});

test('malformed usage metadata is reported as incomplete coverage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-malformed-'));
  fs.writeFileSync(path.join(root, 'session.jsonl'), JSON.stringify({type: 'assistant', requestId: 'bad',
    timestamp: '2026-09-12T00:00:00Z', message: {model: 'claude-sonnet-5',
      usage: {input_tokens: 'not-a-number', output_tokens: 2}}}));
  const result = await scanRoot(root, 'anthropic');
  assert.equal(result.events.length, 0);
  assert.equal(result.diagnostics.recordsSkipped, 1);
  const unchanged = await scanRoot(root, 'anthropic', result.checkpoints);
  assert.equal(unchanged.diagnostics.recordsSkipped, 1);
});

test('a directory beyond the scanner depth limit is reported as incomplete coverage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-depth-'));
  let nested = root;
  for (let index = 0; index < 21; index += 1) {
    nested = path.join(nested, 'sub');
    fs.mkdirSync(nested);
  }
  fs.writeFileSync(path.join(nested, 'session.jsonl'), JSON.stringify({type: 'assistant', requestId: 'deep',
    timestamp: '2026-09-12T00:00:00Z', message: {model: 'claude-sonnet-5', usage: {input_tokens: 1}}}));
  const result = await scanRoot(root, 'anthropic');
  assert.equal(result.events.length, 0);
  assert.ok(result.diagnostics.filesSkipped > 0);
});

test('an unrecognised usage schema is disclosed and stays disclosed on a warm scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-schema-'));
  fs.writeFileSync(path.join(root, 'rollout.jsonl'), [
    JSON.stringify({type: 'turn_context', timestamp: '2026-09-15T00:00:00Z',
      payload: {turn_id: 't1', model: 'gpt-5.6-terra'}}),
    JSON.stringify({type: 'token_usage_v2', timestamp: '2026-09-15T00:00:01Z',
      payload: {turn_id: 't1', usage: {input_tokens: 10_000, output_tokens: 100}}})
  ].join('\n'));

  const first = await scanRoot(root, 'openai');
  assert.equal(first.events.length, 0);
  assert.equal(first.diagnostics.schemaUnknown, 1, 'a provider schema change must be visible');

  const warm = await scanRoot(root, 'openai', first.checkpoints);
  assert.equal(warm.diagnostics.filesRead, 0);
  assert.equal(warm.diagnostics.schemaUnknown, 1, 'the warning must survive while the file is unchanged');
});

test('a legacy record the current schema cannot account for is reported for a large log too', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-large-legacy-'));
  const log = path.join(root, 'rollout.jsonl');
  const context = JSON.stringify({type: 'turn_context', timestamp: '2026-09-15T00:00:00Z',
    payload: {turn_id: 't1', model: 'gpt-5.6-terra'}});
  const current = JSON.stringify({type: 'token_usage_record', timestamp: '2026-09-15T00:00:01Z',
    payload: {turn_id: 't1', response_id: 'resp_1', usage: {input_tokens: 10_000, cached_input_tokens: 0,
      cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0}}});
  const orphan = JSON.stringify({type: 'event_msg', timestamp: '2026-09-15T00:00:02Z',
    payload: {type: 'token_count', info: {last_token_usage: {input_tokens: 5_000, cached_input_tokens: 0,
      cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0},
      total_token_usage: {input_tokens: 15_000, output_tokens: 150}}}});
  fs.writeFileSync(log, `${context}\n`);
  fs.truncateSync(log, 33 * 1024 * 1024);
  fs.appendFileSync(log, `\n${current}\n${orphan}\n`);

  const result = await scanRoot(root, 'openai');
  assert.equal(result.events.length, 1);
  assert.equal(result.diagnostics.unmatchedLegacyRecords, 1,
    'the streaming path must report the same coverage gap as the small-file path');

  const warm = await scanRoot(root, 'openai', result.checkpoints);
  assert.equal(warm.diagnostics.filesRead, 0);
  assert.equal(warm.diagnostics.unmatchedLegacyRecords, 1, 'the gap must survive a warm scan');
});
