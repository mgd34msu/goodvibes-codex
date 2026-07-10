#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(root, 'plugins', 'goodvibes');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const fail = (message) => {
  throw new Error(message);
};

const manifest = readJson('plugins/goodvibes/.codex-plugin/plugin.json');
if (manifest.name !== 'goodvibes') fail('plugin name must be goodvibes');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  fail(`plugin version is not semver: ${manifest.version}`);
}
for (const key of ['description', 'author', 'interface', 'mcpServers', 'skills']) {
  if (!manifest[key]) fail(`plugin manifest is missing ${key}`);
}
for (const key of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'capabilities', 'defaultPrompt']) {
  if (!manifest.interface[key]) fail(`plugin interface is missing ${key}`);
}
if ('hooks' in manifest) fail('use default hooks/hooks.json discovery; omit the manifest hooks field');
if (manifest.mcpServers !== './.mcp.json') fail('mcpServers must point to ./.mcp.json');
if (manifest.skills !== './skills/') fail('skills must point to ./skills/');

const mcpDocument = readJson('plugins/goodvibes/.mcp.json');
const servers = mcpDocument.mcpServers ?? mcpDocument.mcp_servers ?? mcpDocument;
const serverNames = Object.keys(servers).sort();
const expectedServers = ['goodvibes_analytics', 'goodvibes_connect', 'goodvibes_intel'];
if (JSON.stringify(serverNames) !== JSON.stringify(expectedServers)) {
  fail(`unexpected MCP server keys: ${serverNames.join(', ')}`);
}

for (const file of ['scripts/goodvibes-control.mjs', 'scripts/lib/runtime-deps.cjs']) {
  if (!fs.existsSync(path.join(pluginRoot, file))) fail(`${file} is missing`);
}
for (const [name, config] of Object.entries(servers)) {
  if (config.command !== 'node' || config.cwd !== '.') fail(`${name} must launch node from plugin cwd`);
  const launcher = config.args?.[0];
  if (!launcher || !fs.existsSync(path.join(pluginRoot, launcher))) fail(`${name} launcher does not exist: ${launcher}`);
  const launcherSource = fs.readFileSync(path.join(pluginRoot, launcher), 'utf8');
  if (
    !launcherSource.includes("require('../../scripts/lib/runtime-deps.cjs')") ||
    !launcherSource.includes('ensureRuntimeDependencies({')
  ) {
    fail(`${name} launcher does not invoke automatic runtime dependency repair`);
  }
}

const hookConfig = path.join(pluginRoot, 'hooks', 'hooks.json');
if (!fs.existsSync(hookConfig)) fail('default hooks/hooks.json is missing');
const hooks = JSON.parse(fs.readFileSync(hookConfig, 'utf8')).hooks ?? {};
const expectedHooks = ['PreCompact', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop'];
if (JSON.stringify(Object.keys(hooks).sort()) !== JSON.stringify(expectedHooks)) {
  fail(`unexpected hook events: ${Object.keys(hooks).sort().join(', ')}`);
}
for (const registrations of Object.values(hooks)) {
  for (const registration of registrations) {
    for (const hook of registration.hooks ?? []) {
      if (!hook.command?.includes('$PLUGIN_ROOT') || !hook.commandWindows?.includes('%PLUGIN_ROOT%')) {
        fail('every hook command must be plugin-root relative on POSIX and Windows');
      }
    }
  }
}

const expectedSkills = [
  'codebase-review',
  'goodvibes-analytics',
  'goodvibes-maintenance',
  'goodvibes-memory',
  'intel-mastery',
  'project-onboarding',
  'review-scoring',
  'service-integration',
  'task-orchestration',
];
const skillRoot = path.join(pluginRoot, 'skills');
const actualSkills = fs.readdirSync(skillRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(actualSkills) !== JSON.stringify(expectedSkills)) {
  fail(`unexpected skill set: ${actualSkills.join(', ')}`);
}
for (const skill of actualSkills) {
  for (const relative of ['SKILL.md', 'agents/openai.yaml']) {
    if (!fs.existsSync(path.join(skillRoot, skill, relative))) fail(`${skill}/${relative} is missing`);
  }
}

for (const server of ['intel', 'analytics', 'connect']) {
  const serverRoot = path.join(pluginRoot, 'server', server);
  for (const file of ['index.cjs', 'launcher.cjs', 'package.json', 'package-lock.json']) {
    if (!fs.existsSync(path.join(serverRoot, file))) fail(`server/${server}/${file} is missing`);
  }
  const runtime = JSON.parse(fs.readFileSync(path.join(serverRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(serverRoot, 'package-lock.json'), 'utf8'));
  if (runtime.version !== manifest.version || lock.version !== manifest.version) {
    fail(`server/${server} runtime version does not match the plugin`);
  }
}
for (const asset of [
  'server/intel/wasm/tree-sitter-typescript.wasm',
  'server/intel/wasm/tree-sitter-javascript.wasm',
  'server/intel/wasm/tree-sitter-python.wasm',
  'server/intel/wasm/tree-sitter-rust.wasm',
  'server/intel/wasm/tree-sitter-go.wasm',
  'server/intel/wasm/web-tree-sitter.wasm',
  'server/connect/wasm/sql-wasm.wasm',
]) {
  if (!fs.existsSync(path.join(pluginRoot, asset))) fail(`${asset} is missing`);
}
if (fs.existsSync(path.join(pluginRoot, 'server', 'analytics', 'wasm'))) {
  fail('analytics must not retain the retired SQL.js WASM directory');
}
if (!fs.existsSync(path.join(pluginRoot, 'ARTIFACTS.json'))) fail('ARTIFACTS.json is missing; run npm run build');

const marketplace = readJson('.agents/plugins/marketplace.json');
const entry = marketplace.plugins.find((candidate) => candidate.name === 'goodvibes');
if (!entry) fail('marketplace entry is missing');
if (entry.source?.source !== 'local' || entry.source?.path !== './plugins/goodvibes') fail('marketplace source is invalid');
if (!entry.policy?.installation || !entry.policy?.authentication || !entry.category) fail('marketplace policy/category is incomplete');

const todos = [];
for (const relativePath of [
  'plugins/goodvibes/.codex-plugin/plugin.json',
  'plugins/goodvibes/.mcp.json',
  '.agents/plugins/marketplace.json',
]) {
  if (fs.readFileSync(path.join(root, relativePath), 'utf8').includes('[TODO:')) todos.push(relativePath);
}
if (todos.length) fail(`unresolved TODO placeholders: ${todos.join(', ')}`);

for (const directory of ['server', 'skills', 'hooks']) {
  const pending = [path.join(pluginRoot, directory)];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail(`plugin artifact contains a symlink: ${full}`);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.name.endsWith('.map')) fail(`source map must not ship: ${full}`);
    }
  }
}

process.stdout.write(`Validated GoodVibes plugin ${manifest.version}.\n`);
