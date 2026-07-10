#!/usr/bin/env node

/** Interactive control plane for GoodVibes authority and runtime dependencies. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import readline from 'node:readline/promises';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const {
  SERVERS,
  ensureRuntimeDependencies,
  inspectRuntimeDependencies,
} = require('./lib/runtime-deps.cjs');
function inferCodexHome(root) {
  const marker = `${path.sep}plugins${path.sep}cache${path.sep}`;
  const index = root.toLowerCase().lastIndexOf(marker.toLowerCase());
  return index > 0 ? root.slice(0, index) : null;
}
const codexHome =
  process.env.CODEX_HOME || inferCodexHome(pluginRoot) || path.join(os.homedir(), '.codex');
const dataRoot = process.env.GOODVIBES_DATA_ROOT || path.join(codexHome, 'goodvibes');
const rootsFile =
  process.env.GOODVIBES_TRUSTED_ROOTS_FILE || path.join(dataRoot, 'trusted-roots.json');
const registryFile = path.join(dataRoot, 'services.json');
const secretsFile = path.join(dataRoot, 'goodvibes.secrets.json');
const configFile = path.join(dataRoot, 'config.json');
const lockFile = path.join(dataRoot, '.control.lock');

function ensureInteractive(action) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `${action} requires an interactive terminal; non-interactive authority changes are refused.`
    );
  }
}

async function ask(label, fallback = '') {
  ensureInteractive(label);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = fallback ? ` [${fallback}]` : '';
    const answer = await prompt.question(`${label}${suffix}: `);
    return answer.trim() || fallback;
  } finally {
    prompt.close();
  }
}

async function askSecret(label) {
  ensureInteractive(label);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdout.write(`${label}: `);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = error => {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Cancelled.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      if (typeof text === 'string' && text && !key.ctrl && !key.meta) {
        value += text;
        process.stdout.write('*');
      }
    };
    process.stdin.on('keypress', onKeypress);
  });
}

async function confirm(action, phrase = 'yes') {
  const answer = await ask(`${action}\nType ${phrase} to continue`);
  if (answer.toLowerCase() !== phrase.toLowerCase()) throw new Error('Cancelled.');
}

function privateModeOkay(stat) {
  return process.platform === 'win32' || (stat.mode & 0o077) === 0;
}

function readPrivateJson(file, fallback) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Refusing unsafe state path: ${file}`);
    if (!privateModeOkay(stat))
      throw new Error(`Refusing authority file with permissions broader than 0600: ${file}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

async function writePrivateJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Refusing unsafe state path: ${file}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fsp.rename(temporary, file);
    if (process.platform !== 'win32') await fsp.chmod(file, 0o600);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function withControlLock(operation) {
  await fsp.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await fsp.open(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Another control operation holds ${lockFile}.`);
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await fsp.rm(lockFile, { force: true }).catch(() => {});
  }
}

function rootsDocument() {
  const parsed = readPrivateJson(rootsFile, { version: 1, roots: [] });
  const roots =
    parsed.version === 1 && Array.isArray(parsed.roots)
      ? [...new Set(parsed.roots.filter(value => typeof value === 'string'))].sort()
      : [];
  return { version: 1, roots };
}

function registryDocument() {
  const value = readPrivateJson(registryFile, {});
  return {
    ...value,
    services: value.services && typeof value.services === 'object' ? value.services : {},
    connections:
      value.connections && typeof value.connections === 'object' ? value.connections : {},
    allowlist: Array.isArray(value.allowlist) ? value.allowlist : [],
  };
}

function secretsDocument() {
  const value = readPrivateJson(secretsFile, { services: {}, global: {} });
  return {
    services: value.services && typeof value.services === 'object' ? value.services : {},
    global: value.global && typeof value.global === 'object' ? value.global : {},
  };
}

function validateName(value, kind) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value || '')) {
    throw new Error(`${kind} name must match [a-z][a-z0-9_-]{0,63}.`);
  }
  return value;
}

function validateServiceUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Service URL must use http or https.');
  if (url.username || url.password)
    throw new Error('Store credentials separately; base URLs cannot contain user-info.');
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function normalizeAllowEntry(value) {
  if (value.includes('://')) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Allowlist origins must be credential-free http(s) URLs.');
    }
    return url.origin;
  }
  const host = value.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..')) throw new Error('Invalid hostname.');
  return host;
}

function connectionSecret(value) {
  if (!value) throw new Error('Connection URL/path cannot be empty.');
  if (/^postgres(?:ql)?:/i.test(value)) {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    if (
      url.hash ||
      keys.length !== 1 ||
      keys[0] !== 'sslmode' ||
      url.searchParams.getAll('sslmode').length !== 1 ||
      url.searchParams.get('sslmode')?.toLowerCase() !== 'verify-full'
    ) {
      throw new Error('PostgreSQL URLs require the sole parameter sslmode=verify-full.');
    }
    return value;
  }
  if (/^mysql:/i.test(value)) {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    if (
      url.hash ||
      keys.length !== 1 ||
      keys[0] !== 'ssl-mode' ||
      url.searchParams.getAll('ssl-mode').length !== 1 ||
      url.searchParams.get('ssl-mode')?.toUpperCase() !== 'VERIFY_IDENTITY'
    ) {
      throw new Error('MySQL URLs require the sole parameter ssl-mode=VERIFY_IDENTITY.');
    }
    return value;
  }
  if (/^(sqlite|file):/i.test(value) || value === ':memory:') return value;
  if (/\.(db|sqlite|sqlite3)$/i.test(value)) return path.resolve(value);
  throw new Error('Connection must be PostgreSQL, MySQL, or a SQLite file/path.');
}

function safeRegistryView(registry) {
  return {
    services: Object.entries(registry.services).map(([name, service]) => ({
      name,
      base_url: service.base_url,
      auth_type: service.auth_type || 'none',
      write_methods: service.write_methods || [],
      allow_private_network: service.allow_private_network === true,
      description: service.description,
    })),
    connections: Object.entries(registry.connections).map(([name, connection]) => ({
      name,
      allow_writes: connection.allow_writes === true,
      description: connection.description,
    })),
    allowlist: registry.allowlist,
  };
}

async function servicesCommand(action, rest) {
  const registry = registryDocument();
  if (action === 'list') {
    process.stdout.write(`${JSON.stringify(safeRegistryView(registry), null, 2)}\n`);
    return;
  }

  if (action === 'add') {
    const name = validateName(rest[0], 'Service');
    const baseUrl = validateServiceUrl(rest[1] || (await ask('Base URL')));
    const description = await ask('Description (optional)');
    const methodsText = await ask('Allowed write methods, comma-separated (blank = read-only)');
    const writeMethods = [
      ...new Set(
        methodsText
          .split(',')
          .map(v => v.trim().toUpperCase())
          .filter(Boolean)
      ),
    ];
    if (writeMethods.some(method => !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))) {
      throw new Error('Write methods are limited to POST, PUT, PATCH, and DELETE.');
    }
    const allowPrivate =
      (await ask('Allow private network destinations? (yes/no)', 'no')).toLowerCase() === 'yes';
    await confirm(
      `Register service '${name}' at ${baseUrl}\nWrites: ${writeMethods.join(', ') || 'none'}\nPrivate network: ${allowPrivate ? 'allowed' : 'denied'}`
    );
    await withControlLock(async () => {
      const current = registryDocument();
      if (current.services[name])
        throw new Error(`Service '${name}' already exists; remove it first.`);
      // A prior interrupted removal may have left an orphan credential under
      // this reusable display name. Purge it before granting the name a new
      // destination so it can never bind to a different origin.
      const secrets = secretsDocument();
      delete secrets.services[name];
      await writePrivateJson(secretsFile, secrets);
      current.services[name] = {
        base_url: baseUrl,
        ...(description ? { description } : {}),
        ...(writeMethods.length ? { write_methods: writeMethods } : {}),
        ...(allowPrivate ? { allow_private_network: true } : {}),
      };
      await writePrivateJson(registryFile, current);
    });
    process.stdout.write(`Registered service: ${name}\n`);
    return;
  }

  if (action === 'remove') {
    const name = validateName(rest[0], 'Service');
    await confirm(`Remove service '${name}', its credentials, and URL mappings`);
    await withControlLock(async () => {
      const current = registryDocument();
      if (!current.services[name]) throw new Error(`Service '${name}' is not registered.`);
      const secrets = secretsDocument();
      delete secrets.services[name];
      await writePrivateJson(secretsFile, secrets);
      delete current.services[name];
      current.url_patterns = (current.url_patterns || []).filter(item => item.service !== name);
      await writePrivateJson(registryFile, current);
    });
    process.stdout.write(`Removed service: ${name}\n`);
    return;
  }

  if (action === 'auth') {
    const name = validateName(rest[0], 'Service');
    const registeredService = registry.services[name];
    if (!registeredService) throw new Error(`Service '${name}' is not registered.`);
    const serviceUrl = new URL(registeredService.base_url);
    if (serviceUrl.protocol !== 'https:') {
      throw new Error(
        'Static service credentials require an HTTPS base URL. Plaintext HTTP auth is refused.'
      );
    }
    const serviceOrigin = serviceUrl.origin;
    const type = (rest[1] || (await ask('Auth type (bearer/basic/api-key)'))).toLowerCase();
    let auth;
    if (type === 'bearer') {
      const token = await askSecret('Bearer token');
      if (!token) throw new Error('Token cannot be empty.');
      auth = { type, token, service_origin: serviceOrigin };
    } else if (type === 'basic') {
      const username = await ask('Username');
      const password = await askSecret('Password');
      if (!username || !password) throw new Error('Username and password are required.');
      auth = { type, username, password, service_origin: serviceOrigin };
    } else if (type === 'api-key') {
      const header = await ask('Header name', 'X-API-Key');
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header))
        throw new Error('Invalid HTTP header name.');
      const key = await askSecret('API key');
      if (!key) throw new Error('API key cannot be empty.');
      auth = { type, header, key, service_origin: serviceOrigin };
    } else {
      throw new Error('Supported interactive auth types: bearer, basic, api-key.');
    }
    await confirm(`Replace stored ${type} credentials for service '${name}'`);
    await withControlLock(async () => {
      const secrets = secretsDocument();
      secrets.services[name] = auth;
      const current = registryDocument();
      if (!current.services[name]) throw new Error(`Service '${name}' was revoked.`);
      current.services[name].auth_type = type;
      await writePrivateJson(secretsFile, secrets);
      await writePrivateJson(registryFile, current);
    });
    process.stdout.write(`Updated credentials for service: ${name}\n`);
    return;
  }

  if (action === 'clear-auth') {
    const name = validateName(rest[0], 'Service');
    await confirm(`Delete stored credentials for service '${name}'`);
    await withControlLock(async () => {
      const secrets = secretsDocument();
      delete secrets.services[name];
      const current = registryDocument();
      if (current.services[name]) current.services[name].auth_type = 'none';
      await writePrivateJson(secretsFile, secrets);
      await writePrivateJson(registryFile, current);
    });
    process.stdout.write(`Cleared credentials for service: ${name}\n`);
    return;
  }

  if (action === 'allow') {
    const verb = rest[0];
    if (verb === 'list') {
      process.stdout.write(`${JSON.stringify({ allowlist: registry.allowlist }, null, 2)}\n`);
      return;
    }
    const entry = normalizeAllowEntry(rest[1]);
    await confirm(
      `${verb === 'add' ? 'Allow' : 'Revoke'} unregistered read-only HTTP destination '${entry}'`
    );
    await withControlLock(async () => {
      const current = registryDocument();
      if (verb === 'add') current.allowlist = [...new Set([...current.allowlist, entry])].sort();
      else if (verb === 'remove')
        current.allowlist = current.allowlist.filter(item => item !== entry);
      else throw new Error('Use services allow list|add|remove.');
      await writePrivateJson(registryFile, current);
    });
    process.stdout.write(`${verb === 'add' ? 'Allowed' : 'Revoked'} destination: ${entry}\n`);
    return;
  }

  throw new Error('Use services list|add|remove|auth|clear-auth|allow.');
}

async function connectionsCommand(action, rest) {
  if (action === 'list') {
    process.stdout.write(
      `${JSON.stringify(safeRegistryView(registryDocument()).connections, null, 2)}\n`
    );
    return;
  }
  const name = validateName(rest[0], 'Connection');
  if (action === 'add') {
    const url = connectionSecret(await askSecret('Database URL or SQLite path'));
    const description = await ask('Description (optional)');
    const allowWrites = (await ask('Allow SQL writes? (yes/no)', 'no')).toLowerCase() === 'yes';
    await confirm(
      `Register database connection '${name}'\nWrites: ${allowWrites ? 'allowed with write:true' : 'denied'}`
    );
    await withControlLock(async () => {
      const registry = registryDocument();
      if (registry.connections[name])
        throw new Error(`Connection '${name}' already exists; remove it first.`);
      const ref = `connection:${name}`;
      registry.connections[name] = {
        secret_ref: ref,
        allow_writes: allowWrites,
        ...(description ? { description } : {}),
      };
      const secrets = secretsDocument();
      secrets.global[ref] = url;
      await writePrivateJson(secretsFile, secrets);
      await writePrivateJson(registryFile, registry);
    });
    process.stdout.write(`Registered connection: ${name}\n`);
    return;
  }
  if (action === 'remove') {
    await confirm(`Remove database connection '${name}' and its stored URL`);
    await withControlLock(async () => {
      const registry = registryDocument();
      const connection = registry.connections[name];
      if (!connection) throw new Error(`Connection '${name}' is not registered.`);
      delete registry.connections[name];
      const secrets = secretsDocument();
      delete secrets.global[connection.secret_ref];
      await writePrivateJson(registryFile, registry);
      await writePrivateJson(secretsFile, secrets);
    });
    process.stdout.write(`Removed connection: ${name}\n`);
    return;
  }
  throw new Error('Use connections list|add|remove.');
}

async function rootsCommand(action, value) {
  const current = rootsDocument();
  if (action === 'list') {
    process.stdout.write(`${JSON.stringify({ roots: current.roots }, null, 2)}\n`);
    return;
  }
  if (!value) throw new Error('roots add/remove requires a directory.');
  if (action === 'add') {
    const canonical = fs.realpathSync.native(path.resolve(value));
    if (!fs.statSync(canonical).isDirectory()) throw new Error(`Not a directory: ${canonical}`);
    await confirm(`Register trusted workspace: ${canonical}`);
    await withControlLock(async () => {
      const doc = rootsDocument();
      doc.roots = [...new Set([...doc.roots, canonical])].sort();
      await writePrivateJson(rootsFile, doc);
    });
    process.stdout.write(`Registered trusted workspace: ${canonical}\n`);
    return;
  }
  if (action === 'remove') {
    const absolute = path.resolve(value);
    const canonical = current.roots.find(
      root =>
        root === absolute ||
        (() => {
          try {
            return fs.realpathSync.native(absolute) === root;
          } catch {
            return false;
          }
        })()
    );
    if (!canonical) throw new Error(`Workspace is not registered: ${absolute}`);
    await confirm(`Revoke trusted workspace: ${canonical}`);
    await withControlLock(async () => {
      const doc = rootsDocument();
      doc.roots = doc.roots.filter(root => root !== canonical);
      await writePrivateJson(rootsFile, doc);
    });
    process.stdout.write(`Revoked trusted workspace: ${canonical}\n`);
    return;
  }
  throw new Error('Use roots list|add|remove.');
}

async function configCommand(action, rest) {
  const config = readPrivateJson(configFile, {});
  if (action === 'show') {
    process.stdout.write(`${JSON.stringify({ ...config, data_root: dataRoot }, null, 2)}\n`);
    return;
  }
  if (action === 'set-mode') {
    const mode = rest[0];
    if (!['restricted', 'open'].includes(mode)) throw new Error('Mode must be restricted or open.');
    const persist = rest.includes('--persist');
    const phrase = mode === 'open' ? 'open network access' : 'yes';
    await confirm(
      mode === 'open'
        ? `Enable open public-network mode${persist ? ' across sessions' : ' until the next SessionStart'}\nCredential origin pinning and private-address blocking remain active.`
        : 'Restore restricted mode',
      phrase
    );
    await withControlLock(async () => {
      const current = readPrivateJson(configFile, {});
      current.mode = mode;
      current.dangerously_persist_across_sessions = mode === 'open' && persist;
      await writePrivateJson(configFile, current);
    });
    process.stdout.write(`Mode set to ${mode}${persist ? ' (persistent)' : ''}.\n`);
    return;
  }
  throw new Error('Use config show|set-mode.');
}

async function depsCommand(action, rest) {
  const names = [...SERVERS];
  if (action === 'status') {
    const entries = await Promise.all(
      names.map(async name => {
        const inspected = await inspectRuntimeDependencies({ pluginRoot, dataRoot, server: name });
        return [
          name,
          {
            prepared: inspected.prepared,
            dependencies: Object.keys(inspected.dependencies),
            path: inspected.path,
            issues: inspected.issues,
          },
        ];
      })
    );
    const status = Object.fromEntries(entries);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  if (action !== 'install') throw new Error('Use deps status|install.');
  const requested = rest[0] || 'all';
  const selected = requested === 'all' ? names : [requested];
  if (selected.some(name => !names.includes(name)))
    throw new Error('Dependency target must be intel, analytics, connect, or all.');
  for (const name of selected) {
    const result = await ensureRuntimeDependencies({ pluginRoot, dataRoot, server: name });
    process.stdout.write(
      `${result.repaired ? 'Repaired' : 'Verified'} ${name} dependencies at ${path.join(dataRoot, 'deps', name)}.\n`
    );
  }
}

function usage() {
  return `GoodVibes control utility

Usage:
  goodvibes-control.mjs status
  goodvibes-control.mjs roots list|add|remove [directory]
  goodvibes-control.mjs services list
  goodvibes-control.mjs services add <name> [base-url]
  goodvibes-control.mjs services remove <name>
  goodvibes-control.mjs services auth <name> [bearer|basic|api-key]
  goodvibes-control.mjs services clear-auth <name>
  goodvibes-control.mjs services allow list|add|remove [origin-or-host]
  goodvibes-control.mjs connections list|add|remove [name]
  goodvibes-control.mjs config show
  goodvibes-control.mjs config set-mode restricted|open [--persist]
  goodvibes-control.mjs deps status|install [intel|analytics|connect|all]

Authority mutations require an interactive terminal and an explicit phrase. Runtime dependency
repair is automatic and may also be invoked non-interactively with deps install.`;
}

const [group, action, ...rest] = process.argv.slice(2);

try {
  if (!group || group === '--help' || group === 'help') {
    process.stdout.write(`${usage()}\n`);
  } else if (group === 'status') {
    process.stdout.write(
      `${JSON.stringify(
        {
          data_root: dataRoot,
          plugin_root: pluginRoot,
          trusted_roots: rootsDocument().roots,
          ...safeRegistryView(registryDocument()),
          mode: readPrivateJson(configFile, {}).mode || 'restricted',
        },
        null,
        2
      )}\n`
    );
  } else if (group === 'roots') {
    await rootsCommand(action, rest[0]);
  } else if (group === 'services') {
    await servicesCommand(action, rest);
  } else if (group === 'connections') {
    await connectionsCommand(action, rest);
  } else if (group === 'config') {
    await configCommand(action, rest);
  } else if (group === 'deps') {
    await depsCommand(action, rest);
  } else {
    throw new Error(`Unknown command '${group}'.\n\n${usage()}`);
  }
} catch (error) {
  process.stderr.write(
    `goodvibes-control: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
