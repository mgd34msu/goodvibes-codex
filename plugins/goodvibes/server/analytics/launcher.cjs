'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const pluginRoot = path.resolve(__dirname, '..', '..');
function inferCodexHome(root) {
  const marker = `${path.sep}plugins${path.sep}cache${path.sep}`;
  const index = root.toLowerCase().lastIndexOf(marker.toLowerCase());
  return index > 0 ? root.slice(0, index) : null;
}
const codexHome =
  process.env.CODEX_HOME || inferCodexHome(pluginRoot) || path.join(os.homedir(), '.codex');
const dataRoot = process.env.GOODVIBES_DATA_ROOT || path.join(codexHome, 'goodvibes');
const dependencyRoots = [
  path.join(__dirname, 'node_modules'),
  path.join(dataRoot, 'deps', 'analytics', 'node_modules'),
].filter(candidate => fs.existsSync(candidate));

if (dependencyRoots.length > 0) {
  process.env.NODE_PATH = [...dependencyRoots, process.env.NODE_PATH]
    .filter(Boolean)
    .join(path.delimiter);
  Module._initPaths();
}

process.env.GOODVIBES_HOST = 'codex';
process.env.CODEX_HOME ||= codexHome;
process.env.GOODVIBES_PLUGIN_ROOT = pluginRoot;
process.env.GOODVIBES_DATA_ROOT = dataRoot;

require('./index.cjs');
