import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const roots = ['src', 'test', 'scripts'];
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else files.push(target);
  }
}
for (const root of roots) walk(root);

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) JSON.parse(source);
  if (file.endsWith('.js')) new vm.Script(source, {filename: file});
}
JSON.parse(fs.readFileSync('package.json', 'utf8'));
JSON.parse(fs.readFileSync('schemas/impact-registry.schema.json', 'utf8'));
console.log(`Source and JSON syntax checked: ${files.length + 2} files`);
