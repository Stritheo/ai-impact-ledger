import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const build = path.resolve('build');
const staging = path.join(build, 'vsix');
fs.rmSync(staging, {recursive: true, force: true});
fs.mkdirSync(path.join(staging, 'extension'), {recursive: true});

const included = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'PRIVACY.md', 'SECURITY.md', 'sbom.cdx.json', 'src'];
for (const item of included) fs.cpSync(item, path.join(staging, 'extension', item), {recursive: true});

const contentTypes = `<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="txt" ContentType="text/plain"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>`;
const vsixManifest = `<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="${manifest.name}" Version="${manifest.version}" Publisher="${manifest.publisher}"/><DisplayName>${manifest.displayName}</DisplayName><Description xml:space="preserve">${manifest.description}</Description><Tags>${manifest.keywords.join(',')}</Tags><Categories>Other</Categories><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${manifest.engines.vscode}"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true"/></Assets></PackageManifest>`;
fs.writeFileSync(path.join(staging, '[Content_Types].xml'), contentTypes);
fs.writeFileSync(path.join(staging, 'extension.vsixmanifest'), vsixManifest);

const epoch = new Date('1980-01-01T00:00:00Z');
function normaliseTimes(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) normaliseTimes(target);
    fs.utimesSync(target, epoch, epoch);
  }
}
normaliseTimes(staging);

// Zip records entries in the order the file system lists them and with each
// file's own mode, and both differ between machines: macOS and Linux list a
// directory differently, and a checkout's modes follow the builder's umask.
// Files are therefore given one fixed mode and passed in byte order, without
// directory entries, so the local and hosted builds of a commit match.
const files = [];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(target);
    else if (entry.isFile()) {
      fs.chmodSync(target, 0o644);
      files.push(path.relative(staging, target).split(path.sep).join('/'));
    } else throw new Error(`unexpected packaged entry: ${target}`);
  }
}
collect(staging);
files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const output = path.join(build, `${manifest.name}-${manifest.version}.vsix`);
fs.rmSync(output, {force: true});
// Zip stores DOS timestamps in local time, so the zone is fixed as well.
const result = spawnSync('/usr/bin/zip', ['-X', '-D', '-q', output, '-@'],
  {cwd: staging, input: `${files.join('\n')}\n`, stdio: ['pipe', 'inherit', 'inherit'], env: {...process.env, TZ: 'UTC'}});
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Wrote ${output}`);
