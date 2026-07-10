/**
 * Build the goodvibes-connect server bundle.
 *
 * The authored TypeScript is bundled for Node 20. sql.js remains external and
 * its WASM file is copied beside the bundle. PostgreSQL and MySQL drivers are
 * loaded dynamically from the plugin's prepared runtime dependencies, never
 * from the target workspace. Output is committed under the plugin tree because
 * marketplace installation does not run a build.
 */

import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { chmod, copyFile, mkdir, rm } from 'fs/promises';
import { createRequire } from 'module';

// Inject the manifest version so the bundled server cannot drift from a release.
const PLUGIN_VERSION = JSON.parse(
  readFileSync(
    new URL('../../plugins/goodvibes/.codex-plugin/plugin.json', import.meta.url),
    'utf8'
  )
).version;

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const serverDir = join(__dirname, '../../plugins/goodvibes/server/connect');
const wasmDir = join(serverDir, 'wasm');

async function copyResolved(resolveSpec, destName) {
  const src = require.resolve(resolveSpec);
  const destination = join(wasmDir, destName);
  await mkdir(wasmDir, { recursive: true });
  await copyFile(src, destination);
  await chmod(destination, 0o644);
  console.log(`Copied: ${destName}`);
}

async function build() {
  await mkdir(serverDir, { recursive: true });
  await rm(wasmDir, { recursive: true, force: true });

  await esbuild.build({
    entryPoints: [join(__dirname, 'src/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: join(serverDir, 'index.cjs'),
    // Keep generated module comments independent of the caller's working directory.
    absWorkingDir: join(__dirname, '../..'),
    sourcemap: process.env.GOODVIBES_SOURCEMAP === '1',
    minify: false,
    keepNames: true,
    define: { __GV_VERSION__: JSON.stringify(PLUGIN_VERSION) },
    external: ['sql.js'],
  });
  console.log('Build completed: plugins/goodvibes/server/connect/index.cjs');

  await copyResolved('sql.js/dist/sql-wasm.wasm', 'sql-wasm.wasm');
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
