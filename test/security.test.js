'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitiseEvent } = require('../src/core/security');

// Log path safety is enforced by the scanner and tested there
// (test/scanner.test.js): symlinked logs and logs swapped to a symlink
// outside the root. The unused helper this file once tested was removed.

test('storage sanitiser rejects content and path fields', () => {
  const safe = sanitiseEvent({id: 'x', provider: 'openai', model: 'terra', timestamp: '2026-09-12T00:00:00Z', tokens: {input: 1, output: 2}, prompt: 'secret', cwd: '/private'});
  assert.equal('prompt' in safe, false);
  assert.equal('cwd' in safe, false);
  assert.deepEqual(Object.keys(safe).sort(), ['id', 'inferenceGeo', 'model', 'provider', 'timestamp', 'tokens']);
});
