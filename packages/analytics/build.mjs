/**
 * Build the goodvibes-analytics server bundle.
 *
 * The Codex adapter is a dependency-free metadata reader beyond the bundled
 * MCP SDK/core helpers. It does not load SQLite/WASM or a pricing provider.
 * Output is committed under plugins/goodvibes/server/analytics/ by the release
 * build; this script never installs or mutates runtime dependencies.
 */

import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdir, rm } from 'fs/promises';

// Version is injected from the single source of truth (plugin.json) so the
// SERVER_VERSION constant can never drift from releases again (2.0.2 lesson).
const PLUGIN_VERSION = JSON.parse(
  readFileSync(
    new URL('../../plugins/goodvibes/.codex-plugin/plugin.json', import.meta.url),
    'utf8'
  )
).version;

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = join(__dirname, '../../plugins/goodvibes/server/analytics');

const SHARED = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // Bundle module-key comments are rendered relative to esbuild's working
  // directory; pin it to the repo root so output is byte-identical no
  // matter where the build is invoked from.
  absWorkingDir: join(__dirname, '../..'),
  sourcemap: process.env.GOODVIBES_SOURCEMAP === '1',
  minify: false,
  keepNames: true,
  define: { __GV_VERSION__: JSON.stringify(PLUGIN_VERSION) },
};

async function build() {
  await mkdir(serverDir, { recursive: true });
  // Remove assets from the retired SQLite analytics runtime so a rebuild can
  // never publish stale WASM alongside the dependency-free Codex adapter.
  await rm(join(serverDir, 'wasm'), { recursive: true, force: true });

  // MCP server bundle (answers initialize + serves the 7 tools over stdio).
  await esbuild.build({
    ...SHARED,
    entryPoints: [join(__dirname, 'src/index.ts')],
    outfile: join(serverDir, 'index.cjs'),
  });
  console.info('Build completed: plugins/goodvibes/server/analytics/index.cjs');
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
