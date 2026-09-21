import crypto from 'node:crypto';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8'});
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status || 1);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const gates = [];
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
run('npm', ['ci', '--ignore-scripts']);
gates.push({gate: 'clean dependency installation', result: 'pass'});

const audit = run('npm', ['audit', '--omit=dev']);
if (!/found 0 vulnerabilities/.test(audit)) throw new Error('dependency audit outcome is not clean');
gates.push({gate: 'known dependency vulnerabilities', result: 'pass'});

const verify = run('npm', ['run', 'verify']);
const testCountMatch = verify.match(/tests\s+(\d+)/);
const testCount = testCountMatch ? Number(testCountMatch[1]) : 0;
if (!testCount) throw new Error('test count could not be verified');
gates.push({gate: 'tests, syntax and security policy', result: 'pass', tests: testCount});

const coverage = run('node', ['--test', '--experimental-test-coverage']);
const coverageMatch = coverage.match(/all files\s+\|\s+([\d.]+)/);
const coveragePercent = coverageMatch ? Number(coverageMatch[1]) : NaN;
if (!Number.isFinite(coveragePercent) || coveragePercent < 90) throw new Error('line coverage gate failed or could not be verified');
gates.push({gate: 'line coverage', result: 'pass', percent: coveragePercent});

run('npm', ['run', 'sbom']);
gates.push({gate: 'CycloneDX SBOM', result: 'pass'});

run('node', ['scripts/package-vsix.mjs']);
const packagePath = `build/${manifest.name}-${manifest.version}.vsix`;
const firstHash = sha256(packagePath);
run('node', ['scripts/package-vsix.mjs']);
const secondHash = sha256(packagePath);
if (firstHash !== secondHash) throw new Error('VSIX builds are not reproducible');
run('/usr/bin/unzip', ['-t', packagePath]);
gates.push({gate: 'reproducible valid VSIX', result: 'pass', sha256: firstHash});

run('git', ['diff', '--exit-code']);
gates.push({gate: 'tracked source remains unchanged', result: 'pass'});

const report = {
  generatedAt: new Date().toISOString(),
  releaseDecision: 'local-gates-pass',
  gates,
  pendingHostedGates: ['Marketplace signature or approved private-distribution control'],
  unavailableOptionalGates: [{
    gate: 'CodeQL',
    reason: 'GitHub requires a paid Code Security licence for private repositories; hosted assurance remains mandatory'
  }]
};
fs.mkdirSync('build', {recursive: true});
fs.writeFileSync('build/assurance-report.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
