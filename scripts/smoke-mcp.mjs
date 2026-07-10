#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.resolve(
  process.argv[2] || process.env.GOODVIBES_PLUGIN_ROOT || path.join(repoRoot, 'plugins', 'goodvibes'),
);
const smokeDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goodvibes-mcp-smoke-'));
fs.writeFileSync(
  path.join(smokeDataRoot, 'trusted-roots.json'),
  `${JSON.stringify({ version: 1, roots: [repoRoot] }, null, 2)}\n`,
  { mode: 0o600 },
);

const expected = {
  intel: [
    'api_routes',
    'api_spec',
    'api_validate',
    'client_boundary',
    'code_glob',
    'code_grep',
    'code_read',
    'code_safe_delete',
    'code_surface',
    'component_tree',
    'db_schema',
    'hook_dependencies',
    'layout_analysis',
    'scaffold',
    'structural_edit',
  ],
  analytics: ['budget', 'config', 'dashboard', 'export', 'query', 'sync', 'tag'],
  connect: ['api_request', 'db_query', 'service'],
};

const dependencyFreeCall = {
  intel: {
    name: 'code_read',
    arguments: {
      files: [{ path: 'package.json', extract: 'lines', range: { start: 1, end: 3 } }],
      base_path: repoRoot,
    },
  },
  analytics: { name: 'config', arguments: { action: 'get' } },
  connect: { name: 'service', arguments: { action: 'status' } },
};

function withTimeout(promise, label, timeoutMs = 10_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function smokeServer(name, expectedTools) {
  const child = spawn(process.execPath, [`server/${name}/launcher.cjs`], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      GOODVIBES_DATA_ROOT: smokeDataRoot,
      GOODVIBES_HOST: 'codex',
      NODE_ENV: 'test',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let stderr = '';
  const waiting = new Map();

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes('\n')) {
      const newline = stdoutBuffer.indexOf('\n');
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        child.kill('SIGTERM');
        throw new Error(`${name} wrote non-JSON stdout: ${line}`, { cause: error });
      }
      const resolver = waiting.get(message.id);
      if (resolver) {
        waiting.delete(message.id);
        resolver(message);
      }
    }
  });

  function request(id, method, params = {}) {
    const response = new Promise((resolve) => waiting.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return withTimeout(response, `${name}:${method}`);
  }

  let shutdownError;
  try {
    const initialized = await request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'goodvibes-smoke', version: '0.1.0' },
    });
    if (initialized.error) throw new Error(`${name} initialize failed: ${JSON.stringify(initialized.error)}`);
    if (initialized.result?.serverInfo?.name !== `goodvibes-${name}`) {
      throw new Error(`${name} advertised unexpected server name: ${initialized.result?.serverInfo?.name}`);
    }
    if (!initialized.result?.instructions) throw new Error(`${name} did not advertise server instructions.`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const listed = await request(2, 'tools/list');
    if (listed.error) throw new Error(`${name} tools/list failed: ${JSON.stringify(listed.error)}`);
    const actual = listed.result.tools.map((tool) => tool.name).sort();
    const wanted = [...expectedTools].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      throw new Error(`${name} tool mismatch\nexpected: ${wanted.join(', ')}\nactual:   ${actual.join(', ')}`);
    }
    for (const tool of listed.result.tools) {
      const annotations = tool.annotations;
      if (!annotations || typeof annotations.readOnlyHint !== 'boolean' || typeof annotations.openWorldHint !== 'boolean') {
        throw new Error(`${name}:${tool.name} is missing behavioral annotations.`);
      }
    }

    const call = dependencyFreeCall[name];
    const called = await request(3, 'tools/call', call);
    if (called.error || called.result?.isError === true) {
      throw new Error(`${name}:${call.name} smoke call failed: ${JSON.stringify(called.error ?? called.result)}`);
    }
    const text = called.result?.content?.find((item) => item.type === 'text')?.text;
    if (!text) throw new Error(`${name}:${call.name} returned no text result.`);
    const envelope = JSON.parse(text);
    if (envelope.success !== true) {
      throw new Error(`${name}:${call.name} returned an unsuccessful envelope: ${text}`);
    }
    process.stdout.write(`${name}: initialize ok, ${actual.length} tools, ${call.name} call ok\n`);
  } finally {
    child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, 1_000)),
    ]);
    if (child.exitCode && child.exitCode !== 0) {
      shutdownError = new Error(`${name} exited ${child.exitCode}: ${stderr.trim()}`);
    }
  }
  if (shutdownError) throw shutdownError;
}

try {
  for (const [name, tools] of Object.entries(expected)) {
    await smokeServer(name, tools);
  }
} finally {
  fs.rmSync(smokeDataRoot, { recursive: true, force: true });
}
