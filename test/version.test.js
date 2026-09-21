'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../package.json');
const lock = require('../package-lock.json');

test('the released version is labelled consistently across manifest and lockfile', () => {
  assert.equal(manifest.version, '0.3.0');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
});
