'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../package.json');

test('extension remains available in restricted mode because it never reads workspace contents', () => {
  assert.deepEqual(manifest.capabilities?.untrustedWorkspaces, {supported: true});
});
