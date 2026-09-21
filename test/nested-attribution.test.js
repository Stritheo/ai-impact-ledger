'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {scanRoot} = require('../src/core/scanner');
const {mergeEvents, updateDaily} = require('../src/core/ledger');

// A Claude Code session that runs Codex writes two logs: its own assistant
// records, and Codex's own rollout in its own root. The README promises both
// remain separately attributable and that neither is counted twice.
function session() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-nested-'));
  const project = path.join(home, '.claude', 'projects', 'project');
  const sessions = path.join(home, '.codex', 'sessions', '2026', '09', '18');
  fs.mkdirSync(project, {recursive: true});
  fs.mkdirSync(sessions, {recursive: true});
  const at = (minutes) => new Date(Date.parse('2026-09-18T02:00:00.000Z') + minutes * 60_000).toISOString();

  fs.writeFileSync(path.join(project, 'session.jsonl'), [
    {type: 'assistant', requestId: 'req_plan', timestamp: at(0),
      message: {model: 'claude-opus-5', usage: {input_tokens: 900, cache_read_input_tokens: 40_000, output_tokens: 600}}},
    // The turn in which Claude asked Codex to do the work.
    {type: 'assistant', requestId: 'req_delegate', timestamp: at(3),
      message: {model: 'claude-opus-5', usage: {input_tokens: 120, cache_read_input_tokens: 41_000, output_tokens: 90}}}
  ].map((line) => JSON.stringify(line)).join('\n'));

  fs.writeFileSync(path.join(sessions, 'rollout.jsonl'), [
    {type: 'turn_context', timestamp: at(1), payload: {turn_id: 'turn_1', model: 'gpt-5.6-sol'}},
    {type: 'token_usage_record', timestamp: at(1), payload: {turn_id: 'turn_1', response_id: 'resp_1',
      usage: {input_tokens: 30_000, cached_input_tokens: 25_000, cache_write_input_tokens: 0, output_tokens: 400, reasoning_output_tokens: 120}}},
    {type: 'token_usage_record', timestamp: at(2), payload: {turn_id: 'turn_1', response_id: 'resp_2',
      usage: {input_tokens: 31_000, cached_input_tokens: 30_000, cache_write_input_tokens: 0, output_tokens: 250, reasoning_output_tokens: 60}}}
  ].map((line) => JSON.stringify(line)).join('\n'));
  return home;
}

async function scan(home, checkpoints = {}) {
  const claude = await scanRoot(path.join(home, '.claude', 'projects'), 'anthropic', checkpoints.anthropic || {}, 'secret');
  const codex = await scanRoot(path.join(home, '.codex', 'sessions'), 'openai', checkpoints.openai || {}, 'secret');
  return {events: [...claude.events, ...codex.events],
    checkpoints: {anthropic: claude.checkpoints, openai: codex.checkpoints}};
}

test('a Claude session that runs Codex keeps both providers attributable, each counted once', async () => {
  const home = session();
  const first = await scan(home);
  const merged = mergeEvents(first.events);
  assert.equal(merged.length, 4, 'two Claude requests and two Codex responses');

  const byProvider = (provider) => merged.filter((event) => event.provider === provider);
  assert.equal(byProvider('anthropic').length, 2);
  assert.equal(byProvider('openai').length, 2);
  const tokensOf = (provider) => byProvider(provider)
    .reduce((sum, event) => sum + event.tokens.input + event.tokens.cachedInput + event.tokens.output, 0);
  // Claude: 900 + 40,000 + 600 + 120 + 41,000 + 90
  assert.equal(tokensOf('anthropic'), 82_710);
  // Codex: fresh input is the prompt less its cached part, and reasoning
  // output is already inside output.
  assert.equal(tokensOf('openai'), (30_000 - 25_000) + 25_000 + 400 + (31_000 - 30_000) + 30_000 + 250);

  const daily = updateDaily({}, [], merged);
  assert.deepEqual(Object.keys(daily).sort(),
    ['2026-09-18|anthropic|claude-opus-5', '2026-09-18|openai|gpt-5.6-sol']);
  assert.equal(daily['2026-09-18|anthropic|claude-opus-5'].calls, 2);
  assert.equal(daily['2026-09-18|openai|gpt-5.6-sol'].calls, 2);

  // Scanning again must add nothing, whether or not the checkpoints are kept.
  const rescan = await scan(home, first.checkpoints);
  assert.equal(rescan.events.length, 0, 'unchanged logs are not re-read');
  const rescanWithoutCheckpoints = await scan(home);
  const remerged = mergeEvents(merged, rescanWithoutCheckpoints.events);
  assert.equal(remerged.length, 4, 'the same calls seen twice stay four calls');
  assert.deepEqual(updateDaily(daily, merged, rescanWithoutCheckpoints.events), daily,
    'a repeated scan does not move the daily totals');
});
