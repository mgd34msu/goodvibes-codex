'use strict';

const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { ensureRuntimeDependencies } = require('../../scripts/lib/runtime-deps.cjs');

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
  path.join(dataRoot, 'deps', 'connect', 'node_modules'),
];

process.env.GOODVIBES_HOST = 'codex';
process.env.CODEX_HOME ||= codexHome;
process.env.GOODVIBES_PLUGIN_ROOT = pluginRoot;
process.env.GOODVIBES_DATA_ROOT = dataRoot;

async function launch() {
  try {
    const result = await ensureRuntimeDependencies({
      pluginRoot,
      dataRoot,
      server: 'connect',
      allowTestSkip: true,
      repairTimeoutMs: 7_000,
      processTimeoutMs: 5_500,
      killGraceMs: 250,
      lockWaitMs: 6_000,
    });
    if (result.repaired) {
      process.stderr.write(
        `[goodvibes:connect] Repaired runtime dependencies under ${dataRoot}.\n`
      );
    }
  } catch (error) {
    process.stderr.write(
      `[goodvibes:connect] Automatic runtime dependency repair failed; continuing in degraded mode and retrying on the next startup: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }

  process.env.NODE_PATH = [...dependencyRoots, process.env.NODE_PATH]
    .filter(Boolean)
    .join(path.delimiter);
  Module._initPaths();
  require('./index.cjs');
}

launch().catch(error => {
  process.stderr.write(
    `[goodvibes:connect] Launcher failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
