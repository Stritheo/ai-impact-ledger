'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reportHtml } = require('../src/core/report');

test('report uses a closed CSP and escapes dynamic values', () => {
  const html = reportHtml({
    day: '<script>alert(1)</script>',
    calls: 1,
    registryVersion: 'v1',
    analogy: '<img src=x>',
    total: {
      cost: {central: 1}, hasUnknownCost: false,
      energyWh: {low: 1, central: 2, high: 3},
      water: {low: 0.1, central: 0.2, high: 0.3},
      carbonGrams: {low: 1, central: 2, high: 3}
    }
  });
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
});
