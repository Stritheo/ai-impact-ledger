'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const LEVELS = ['low', 'medium', 'high'];

test('every evidence entry states how far its figure can be relied on for its use here', () => {
  const registry = JSON.parse(fs.readFileSync('src/data/impact-registry.v1.json', 'utf8'));
  for (const [id, evidence] of Object.entries(registry.evidence)) {
    assert.ok(LEVELS.includes(evidence.confidence), `${id}.confidence must be one of ${LEVELS.join(', ')}`);
  }
  const schema = JSON.parse(fs.readFileSync('schemas/impact-registry.schema.json', 'utf8'));
  assert.ok(schema.$defs.evidence.required.includes('confidence'));
  assert.deepEqual(schema.$defs.evidence.properties.confidence.enum, LEVELS);
});

// Runs the security gate against a copy of the repository whose registry has
// been altered, so the gate's own rule is what is tested.
function gateWith(alter) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-confidence-'));
  for (const item of ['src', 'scripts', 'package.json']) fs.cpSync(item, path.join(root, item), {recursive: true});
  const file = path.join(root, 'src', 'data', 'impact-registry.v1.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  alter(registry);
  fs.writeFileSync(file, JSON.stringify(registry));
  return spawnSync(process.execPath, ['scripts/security-audit.mjs'], {cwd: root, encoding: 'utf8'});
}

test('the security gate rejects evidence without a valid confidence', () => {
  const unchanged = gateWith(() => {});
  assert.equal(unchanged.status, 0, unchanged.stderr);
  const firstPriced = (registry) => registry.models.find((model) => model.priceEvidenceRef).priceEvidenceRef;
  for (const [label, alter] of [
    ['missing on a factor', (registry) => { delete registry.evidence[registry.carbon.evidenceRef].confidence; }],
    ['missing on a price', (registry) => { delete registry.evidence[firstPriced(registry)].confidence; }],
    ['not a defined level', (registry) => { registry.evidence[registry.water.evidenceRef].confidence = 'fairly sure'; }]
  ]) {
    const result = gateWith(alter);
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, /confidence/, label);
  }
});
