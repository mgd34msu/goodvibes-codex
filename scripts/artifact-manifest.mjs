#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(root, 'plugins', 'goodvibes');
const output = path.join(pluginRoot, 'ARTIFACTS.json');
const check = process.argv.includes('--check');

function filesBelow(directory, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.goodvibes') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (relative === 'ARTIFACTS.json' || relative.endsWith('.map')) continue;
    if (entry.isSymbolicLink()) throw new Error(`Plugin artifact may not contain symlink: ${relative}`);
    if (entry.isDirectory()) found.push(...filesBelow(absolute, relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

const plugin = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
const files = filesBelow(pluginRoot).sort().map((relative) => {
  const content = fs.readFileSync(path.join(pluginRoot, relative));
  return {
    path: relative,
    bytes: content.byteLength,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
});
const manifest = `${JSON.stringify({
  schema_version: 1,
  plugin: plugin.name,
  version: plugin.version,
  algorithm: 'sha256',
  files,
}, null, 2)}\n`;

if (check) {
  const existing = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
  if (existing !== manifest) throw new Error('plugins/goodvibes/ARTIFACTS.json is stale; run npm run build.');
  process.stdout.write(`Verified ${files.length} plugin artifact hashes.\n`);
} else {
  fs.writeFileSync(output, manifest, 'utf8');
  process.stdout.write(`Recorded ${files.length} plugin artifact hashes.\n`);
}
