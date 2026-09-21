'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const PACKAGED = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'PRIVACY.md', 'SECURITY.md', 'sbom.cdx.json', 'src', 'scripts/package-vsix.mjs'];

// A copy of the packaging inputs, so file modes can be changed without
// touching the working tree.
function sourceCopy(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-artefact-'));
  for (const item of PACKAGED) fs.cpSync(item, path.join(root, item), {recursive: true});
  const apply = (target) => {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      fs.chmodSync(target, mode.directory);
      for (const name of fs.readdirSync(target)) apply(path.join(target, name));
    } else {
      fs.chmodSync(target, mode.file);
    }
  };
  for (const item of PACKAGED) apply(path.join(root, item));
  return root;
}

function build(root) {
  const result = spawnSync(process.execPath, ['scripts/package-vsix.mjs'], {cwd: root, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return fs.readFileSync(path.join(root, 'build', `${manifest.name}-${manifest.version}.vsix`));
}

// Reads names and Unix modes from the archive's central directory.
function entries(archive) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory');
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const found = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const mode = archive.readUInt32LE(offset + 38) >>> 16;
    found.push({name: archive.toString('utf8', offset + 46, offset + 46 + nameLength), mode: mode & 0o7777});
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

test('the packaged artefact is identical whatever the builder\'s file modes and directory order', () => {
  const standard = build(sourceCopy({file: 0o644, directory: 0o755}));
  const groupWritable = build(sourceCopy({file: 0o664, directory: 0o775}));
  const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
  assert.equal(hash(groupWritable), hash(standard), 'a checkout with a different umask must produce the same artefact');

  const listed = entries(standard);
  const names = listed.map((entry) => entry.name);
  assert.deepEqual(names, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    'entries are stored in byte order, not the order the file system lists them');
  assert.ok(names.includes('extension/package.json') && names.includes('extension.vsixmanifest'));
  assert.ok(names.every((name) => !name.endsWith('/')), 'no directory entries, whose modes vary by host');
  assert.ok(listed.every((entry) => entry.mode === 0o644), 'every file is stored with one fixed mode');
});
