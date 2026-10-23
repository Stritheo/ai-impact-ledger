'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('completed visual UAT is not reported as a pending release gate', () => {
  const assuranceScript = fs.readFileSync('scripts/assure.mjs', 'utf8');
  assert.doesNotMatch(assuranceScript, /pendingHostedGates:\s*\['visual UAT'/);
});

test('assurance is version-aware and fails closed on missing or weak coverage', () => {
  const assuranceScript = fs.readFileSync('scripts/assure.mjs', 'utf8');
  assert.doesNotMatch(assuranceScript, /ai-impact-ledger-0\.1\.0\.vsix/);
  assert.match(assuranceScript, /coveragePercent < 90/);
  assert.match(assuranceScript, /!Number\.isFinite\(coveragePercent\)/);
  assert.match(assuranceScript, /!testCount/);
});

test('security gate also checks the offline FX registry review date', () => {
  const securityScript = fs.readFileSync('scripts/security-audit.mjs', 'utf8');
  assert.match(securityScript, /fx-registry\.v1\.json/);
  assert.match(securityScript, /FX registry review is overdue/);
});

test('the packaged artefact hash does not depend on the builder time zone', () => {
  const crypto = require('node:crypto');
  const {spawnSync} = require('node:child_process');
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const artefact = `build/${manifest.name}-${manifest.version}.vsix`;
  const build = (timeZone) => {
    const result = spawnSync(process.execPath, ['scripts/package-vsix.mjs'],
      {env: {...process.env, TZ: timeZone}, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return crypto.createHash('sha256').update(fs.readFileSync(artefact)).digest('hex');
  };

  assert.equal(build('Australia/Sydney'), build('UTC'),
    'a release hash that changes with the builder time zone cannot be checked against CI');
});

// Owner's ruling of 23 October 2026: the hosted build's VSIX hash must be
// readable on the run's summary page, so a release can be checked against a
// clean local build without opening the job log.
test('the hosted run summary states the VSIX hash and every gate', async () => {
  const {assuranceSummary} = await import('../scripts/assurance-summary.mjs');
  const report = {generatedAt: '2026-10-23T02:00:00.000Z', releaseDecision: 'local-gates-pass', gates: [
    {gate: 'tests, syntax and security policy', result: 'pass', tests: 230},
    {gate: 'reproducible valid VSIX', result: 'pass', sha256: 'a'.repeat(64)}]};
  const summary = assuranceSummary(report, 'ai-impact-ledger-0.3.0.vsix');
  assert.match(summary, new RegExp(`ai-impact-ledger-0\\.3\\.0\\.vsix.*${'a'.repeat(64)}`));
  assert.match(summary, /\| tests, syntax and security policy \| pass \|/);
  assert.match(summary, /\| reproducible valid VSIX \| pass \|/);
  assert.match(summary, /local-gates-pass/);
  assert.throws(() => assuranceSummary({...report, gates: [report.gates[0]]}, 'x.vsix'), /hash/);
});

test('the assurance run writes its summary to the hosted run page when one is provided', () => {
  const assuranceScript = fs.readFileSync('scripts/assure.mjs', 'utf8');
  assert.match(assuranceScript, /GITHUB_STEP_SUMMARY/);
  assert.match(assuranceScript, /assuranceSummary\(report/);
});
