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
