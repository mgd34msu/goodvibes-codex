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

process.stdout.write(`GoodVibes version ${plugin.version} is consistent across manifests.\n`);
