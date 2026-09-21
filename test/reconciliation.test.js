const test = require('node:test');
const assert = require('node:assert/strict');
const {reconcile} = require('../scripts/reconcile-usage.cjs');

test('reconciliation reports an explained matching provider sample', () => {
  const result = reconcile({period: '2026-09-15', ledger: {tokens: 100}, provider: {tokens: 100}, explainedBy: ['same event window']});
  assert.equal(result.status, 'reconciled');
  assert.equal(result.differencePercent, 0);
});

test('reconciliation never hides a provider difference', () => {
  const result = reconcile({ledger: {tokens: 120}, provider: {tokens: 100}, explainedBy: ['cached input treatment']});
  assert.equal(result.status, 'difference-requires-explanation');
  assert.equal(result.differencePercent, 20);
});

test('reconciliation rejects negative or non-numeric totals', () => {
  assert.throws(() => reconcile({ledger: {tokens: -1}, provider: {tokens: 1}}));
  assert.throws(() => reconcile({ledger: {tokens: 'unknown'}, provider: {tokens: 1}}));
});
