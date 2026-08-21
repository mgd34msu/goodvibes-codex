#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const plugin = readJson('plugins/goodvibes/.codex-plugin/plugin.json');
const rootPackage = readJson('package.json');

const versionedFiles = [
  'packages/core/package.json',
  'packages/intel/package.json',
  'packages/analytics/package.json',
  'packages/connect/package.json',
  'plugins/goodvibes/server/intel/package.json',
  'plugins/goodvibes/server/analytics/package.json',
  'plugins/goodvibes/server/connect/package.json',
];

for (const relativePath of versionedFiles) {
  const value = readJson(relativePath).version;
  if (value !== plugin.version) {
    throw new Error(`${relativePath} has version ${value}; expected ${plugin.version}`);
  }
}

if (rootPackage.version !== plugin.version) {
  throw new Error(`package.json has version ${rootPackage.version}; expected ${plugin.version}`);
}

const marketplace = readJson('.agents/plugins/marketplace.json');
const entry = marketplace.plugins.find((candidate) => candidate.name === plugin.name);
if (!entry || entry.source?.path !== './plugins/goodvibes') {
  throw new Error('Marketplace entry is missing or points at the wrong plugin path');
}

// allowScripts pins an exact version per package (npm requires this), separate from the
// ^-ranged dependency. A lockfile refresh can bump the resolved version without anyone
// touching allowScripts, silently detaching the pin from what actually gets installed.
// Catch that drift here instead of letting npm's postinstall allowlist quietly stop applying.
const lockfile = readJson('package-lock.json');
for (const [allowScriptsKey] of Object.entries(rootPackage.allowScripts ?? {})) {
  const separatorIndex = allowScriptsKey.lastIndexOf('@');
  const packageName = allowScriptsKey.slice(0, separatorIndex);
  const pinnedVersion = allowScriptsKey.slice(separatorIndex + 1);
  const lockedPackage = lockfile.packages?.[`node_modules/${packageName}`];
  if (!lockedPackage) {
    throw new Error(`allowScripts references "${packageName}", which is not present in package-lock.json`);
  }
  if (lockedPackage.version !== pinnedVersion) {
    throw new Error(
      `allowScripts pins ${packageName}@${pinnedVersion}, but package-lock.json resolves it to ` +
        `${lockedPackage.version}. Update the allowScripts key in package.json to match the locked version.`,
    );
  }
}

process.stdout.write(`GoodVibes version ${plugin.version} is consistent across manifests.\n`);
