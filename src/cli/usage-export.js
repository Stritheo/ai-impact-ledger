'use strict';

// Writes JSON totals of tokens and API-price cost for scripts on this machine,
// such as a usage governor. Read-only: it opens the provider logs read-only and
// never opens the extension's store. The only file it writes is --out.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {scanRoot} = require('../core/scanner');
const {projectKey} = require('../core/security');
const {buildUsageExport, scanFloor} = require('../core/usage-export');
const registry = require('../data/impact-registry.v1.json');

const USAGE = `Usage:
  node src/cli/usage-export.js [--out <file>] [--claude-root <folder>] [--codex-root <folder>]
  node src/cli/usage-export.js --key-for <folder>
`;
const VALUED = new Set(['--out', '--claude-root', '--codex-root', '--key-for']);

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!VALUED.has(name)) throw new Error(`Unknown argument: ${name}`);
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) throw new Error(`${name} needs a value`);
    if (Object.hasOwn(options, name)) throw new Error(`${name} was given twice`);
    options[name] = value;
  }
  if (options['--key-for'] && Object.keys(options).length > 1) throw new Error('--key-for stands alone');
  return options;
}

// Session logs record the physical folder, so a folder reached through a link
// is resolved before hashing, or its key would never match.
function keyFor(folder) {
  const absolute = path.resolve(folder);
  try {
    return projectKey(fs.realpathSync(absolute));
  } catch {
    return projectKey(absolute);
  }
}

// Written beside the target and renamed over it, so a reader never sees half a
// file and a link at the target is replaced rather than followed.
function writePrivate(file, text) {
  const target = path.resolve(file);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, text, {mode: 0o600, flag: 'wx'});
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, {force: true});
    throw error;
  }
}

async function run(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    stdout.write(USAGE);
    return 0;
  }
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (options['--key-for']) {
    const key = keyFor(options['--key-for']);
    if (!key) {
      stderr.write('That folder cannot be keyed.\n');
      return 2;
    }
    stdout.write(`${key}\n`);
    return 0;
  }
  const now = io.now || new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const home = os.homedir();
  const roots = [
    [options['--claude-root'] || path.join(home, '.claude', 'projects'), 'anthropic'],
    [options['--codex-root'] || path.join(home, '.codex', 'sessions'), 'openai']
  ];
  const scanOptions = {modifiedSince: scanFloor(now, timeZone), project: true};
  const scans = await Promise.all(roots.map(([root, provider]) => scanRoot(root, provider, {}, '', scanOptions)));
  const sum = (field) => scans.reduce((total, scan) => total + (scan.diagnostics[field] || 0), 0);
  const coverage = {
    sources: Object.fromEntries(scans.map((scan, index) => [roots[index][1], scan.diagnostics.malformedRoots ? 'missing' : 'read'])),
    filesRead: sum('filesRead'),
    filesBeforeWindow: sum('filesBeforeWindow'),
    filesSkipped: sum('filesSkipped'),
    linesSkipped: sum('linesSkipped'),
    recordsSkipped: sum('recordsSkipped'),
    unrecognisedSchemas: sum('schemaUnknown')
  };
  const result = buildUsageExport(scans.flatMap((scan) => scan.events), registry, {now, timeZone, coverage});
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (!options['--out']) {
    stdout.write(text);
    return 0;
  }
  try {
    writePrivate(options['--out'], text);
  } catch (error) {
    stderr.write(`Could not write the export: ${error.code || error.message}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) run(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = {run};
