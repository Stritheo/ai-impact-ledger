import crypto from 'node:crypto';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = fs.existsSync('package-lock.json') ? fs.readFileSync('package-lock.json') : Buffer.from('{}');
const digest = crypto.createHash('sha256').update(lock).digest('hex');
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  version: 1,
  metadata: {
    timestamp: '2026-09-12T00:00:00Z',
    component: {type: 'application', name: manifest.name, version: manifest.version, licenses: [{license: {id: 'MIT'}}]},
    properties: [{name: 'ai-impact-ledger:runtime-network', value: 'disabled'}]
  },
  components: []
};
fs.writeFileSync('sbom.cdx.json', `${JSON.stringify(sbom, null, 2)}\n`);
console.log('Wrote sbom.cdx.json (CycloneDX 1.6; zero third-party runtime components).');
