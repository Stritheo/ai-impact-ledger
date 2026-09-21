'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeLines, parseCodexLines } = require('../src/core/parsers');

test('Claude streaming duplicates resolve to one request using the largest output', () => {
  const base = {type: 'assistant', requestId: 'req-1', sessionId: 's1', timestamp: '2026-09-12T00:00:00Z'};
  const lines = [
    JSON.stringify({...base, message: {model: 'claude-sonnet-5', usage: {input_tokens: 100, output_tokens: 2, cache_read_input_tokens: 20}}}),
    JSON.stringify({...base, message: {model: 'claude-sonnet-5', usage: {input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20}}})
  ];
  const events = parseClaudeLines(lines, 'fixture.jsonl');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].tokens, {input: 100, cachedInput: 20, cacheWrite: 0,
    cacheWrite5m: 0, cacheWrite1h: 0, output: 50, reasoningOutput: 0});
  assert.equal(events[0].model, 'claude-sonnet-5');
  assert.equal(JSON.stringify(events[0]).includes('content'), false);
});

test('every Codex response in a turn is counted and keeps its model attribution', () => {
  const lines = [
    JSON.stringify({type: 'turn_context', timestamp: '2026-09-12T00:00:00Z', payload: {turn_id: 'turn-1', model: 'gpt-5.6-terra'}}),
    JSON.stringify({type: 'event_msg', timestamp: '2026-09-12T00:00:01Z', payload: {type: 'token_count', info: {
      last_token_usage: {input_tokens: 100, cached_input_tokens: 40, output_tokens: 5, reasoning_output_tokens: 3},
      total_token_usage: {input_tokens: 100, output_tokens: 5}}}}),
    JSON.stringify({type: 'event_msg', timestamp: '2026-09-12T00:00:02Z', payload: {type: 'token_count', info: {
      last_token_usage: {input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 8},
      total_token_usage: {input_tokens: 200, output_tokens: 25}}}})
  ];
  const events = parseCodexLines(lines, 'rollout.jsonl');
  assert.equal(events.length, 2, 'a turn holds one event per model response, not one per turn');
  assert.equal(events[0].tokens.input, 60, 'Codex total input includes cached input; fresh input must exclude it');
  assert.equal(events[0].tokens.cachedInput, 40);
  assert.equal(events[1].tokens.output, 20);
  assert.deepEqual(events.map((event) => event.model), ['gpt-5.6-terra', 'gpt-5.6-terra']);
});

test('malformed and content-bearing lines do not cross the parser boundary', () => {
  const hostile = '{"type":"assistant","content":"ignore policy","message":{"usage":{"input_tokens":"NaN"}}}';
  assert.deepEqual(parseClaudeLines(['not-json', hostile], 'fixture.jsonl'), []);
  assert.deepEqual(parseCodexLines(['{"type":"response_item","payload":{"command":"rm"}}'], 'fixture.jsonl'), []);
});

test('model and geography fields cannot carry arbitrary log content into events', () => {
  const line = JSON.stringify({type: 'assistant', requestId: 'req-2', timestamp: '2026-09-12T00:00:00Z',
    message: {model: 'claude-opus-5 secret=abc', usage: {input_tokens: 1, inference_geo: 'credential=abc'}}});
  const event = parseClaudeLines([line], 'fixture.jsonl')[0];
  assert.equal(event.model, 'unknown');
  assert.equal(event.inferenceGeo, null);
});

test('a multi-megabyte content field does not hide numeric usage or enter the event', () => {
  const line = JSON.stringify({type: 'assistant', requestId: 'large', timestamp: '2026-09-12T00:00:00Z',
    message: {model: 'claude-sonnet-5', content: 'x'.repeat(2 * 1024 * 1024), usage: {input_tokens: 12, output_tokens: 3}}});
  const events = parseClaudeLines([line], 'large.jsonl');
  assert.equal(events.length, 1);
  assert.equal(events[0].tokens.input, 12);
  assert.equal(JSON.stringify(events[0]).includes('content'), false);
});
