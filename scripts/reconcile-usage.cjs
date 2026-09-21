'use strict';
const fs = require('node:fs');

function number(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function reconcile(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('snapshot must be an object');
  const ledger = snapshot.ledger || {};
  const provider = snapshot.provider || {};
  const ledgerTokens = number(Number(ledger.tokens), 'ledger.tokens');
  const providerTokens = number(Number(provider.tokens), 'provider.tokens');
  const difference = ledgerTokens - providerTokens;
  return {
    period: String(snapshot.period || 'unspecified'), ledgerTokens, providerTokens, difference,
    differencePercent: Math.round((difference / Math.max(providerTokens, 1)) * 10000) / 100,
    explainedBy: Array.isArray(snapshot.explainedBy) ? snapshot.explainedBy.map(String) : [],
    status: difference === 0 ? 'reconciled' : 'difference-requires-explanation'
  };
}

if (require.main === module) {
  const input = process.argv[2];
  if (!input) throw new Error('usage: reconcile-usage.cjs snapshot.json');
  process.stdout.write(`${JSON.stringify(reconcile(JSON.parse(fs.readFileSync(input, 'utf8'))), null, 2)}\n`);
}

module.exports = {reconcile};
