'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../package.json');
const lock = require('../package-lock.json');

// 0.3.0 was released on 21 September 2026 (tag v0.3.0); later work ships as 0.3.1.
test('the released version is labelled consistently across manifest and lockfile', () => {
  assert.equal(manifest.version, '0.3.1');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
});
