/**
 * Build the goodvibes-intel server bundle.
 *
 * Bundle the authored TypeScript for Node 20 and commit the output under the
 * installable plugin tree. Native search/edit packages and web-tree-sitter stay
 * external so the interactive dependency installer can prepare them outside
 * the read-only plugin cache. TypeScript and fast-glob are pure JavaScript and
 * are bundled. Grammar and web-tree-sitter WASM assets are copied beside the
 * bundle.
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
const serverDir = join(__dirname, '../../plugins/goodvibes/server/intel');
const wasmDir = join(serverDir, 'wasm');
// Grammar WASM assets are committed source rather than build-time downloads.
const localWasmDir = join(__dirname, 'wasm');

async function copyResolved(resolveSpec, destName) {
  const src = require.resolve(resolveSpec);
  const destination = join(wasmDir, destName);
  await mkdir(wasmDir, { recursive: true });
  await copyFile(src, destination);
  await chmod(destination, 0o644);
  console.log(`Copied: ${destName}`);
}

async function copyLocal(srcName, destName = srcName) {
  const destination = join(wasmDir, destName);
  await mkdir(wasmDir, { recursive: true });
  await copyFile(join(localWasmDir, srcName), destination);
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
    // web-tree-sitter resolves its own WASM relative to its module, which a CJS
    // bundle cannot preserve reliably, so it remains a runtime dependency.
    external: ['@ast-grep/napi', '@vscode/ripgrep', 'web-tree-sitter'],
  });
  console.log('Build completed: plugins/goodvibes/server/intel/index.cjs');

  // Copy the committed grammar modules and web-tree-sitter runtime module.
  const languages = ['typescript', 'javascript', 'python', 'rust', 'go'];
  for (const lang of languages) {
    await copyLocal(`tree-sitter-${lang}.wasm`);
  }
  // web-tree-sitter's runtime WASM is distinct from the language grammars.
  await copyResolved('web-tree-sitter/web-tree-sitter.wasm', 'web-tree-sitter.wasm');
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
