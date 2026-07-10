'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVERS = Object.freeze(['intel', 'analytics', 'connect']);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEFAULT_LOCK_WAIT_MS = 120_000;
const DEFAULT_STALE_LOCK_MS = 10 * 60_000;
const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
const DEFAULT_REPAIR_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const MAX_KILL_GRACE_MS = 5_000;

function assertServer(server) {
  if (!SERVERS.includes(server)) {
    throw new Error(`Runtime dependency target must be one of: ${SERVERS.join(', ')}.`);
  }
}

function dependencyPath(nodeModules, dependency) {
  return path.join(nodeModules, ...dependency.split('/'));
}

function pathIsWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function runtimePaths(pluginRoot, dataRoot, server) {
  assertServer(server);
  const resolvedPluginRoot = path.resolve(pluginRoot);
  const source = path.join(resolvedPluginRoot, 'server', server);
  const depsRoot = path.join(path.resolve(dataRoot), 'deps');
  if (pathIsWithin(resolvedPluginRoot, depsRoot)) {
    throw new Error(
      `Runtime dependencies must use the durable data root outside the plugin tree: ${depsRoot}`
    );
  }
  return {
    source,
    sourceManifest: path.join(source, 'package.json'),
    sourceLock: path.join(source, 'package-lock.json'),
    depsRoot,
    target: path.join(depsRoot, server),
    lock: path.join(depsRoot, '.locks', `${server}.lock`),
  };
}

async function prospectiveRealpath(candidate) {
  let existing = candidate;
  const suffix = [];
  while (true) {
    try {
      const resolved = await fsp.realpath(existing);
      return path.join(resolved, ...suffix);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

async function assertDurableBoundary(pluginRoot, paths) {
  const [realPluginRoot, realDepsRoot] = await Promise.all([
    prospectiveRealpath(path.resolve(pluginRoot)),
    prospectiveRealpath(paths.depsRoot),
  ]);
  if (pathIsWithin(realPluginRoot, realDepsRoot)) {
    throw new Error(
      `Runtime dependencies resolve inside the immutable plugin tree: ${paths.depsRoot}`
    );
  }
  for (const directory of [paths.depsRoot, path.dirname(paths.lock)]) {
    const stat = await fsp.lstat(directory).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) {
      throw new Error(`Refusing symlinked runtime dependency directory: ${directory}`);
    }
  }
}

function parseJson(content, file) {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid runtime dependency JSON at ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function readRequiredRegularFile(file) {
  const stat = await fsp.lstat(file).catch(error => {
    if (error?.code === 'ENOENT')
      throw new Error(`Required runtime dependency file is missing: ${file}`);
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe runtime dependency file: ${file}`);
  }
  return fsp.readFile(file, 'utf8');
}

function sameDependencyMap(left, right) {
  const leftEntries = Object.entries(left || {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right || {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function boundedTimeout(value, fallback, label, maximum = MAX_TIMEOUT_MS) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number.`);
  }
  return Math.min(Math.floor(value), maximum);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error('Runtime dependency repair was aborted.');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

async function loadRuntimeSpec(pluginRoot, dataRoot, server) {
  const paths = runtimePaths(pluginRoot, dataRoot, server);
  await assertDurableBoundary(pluginRoot, paths);
  const [manifestText, lockText] = await Promise.all([
    readRequiredRegularFile(paths.sourceManifest),
    readRequiredRegularFile(paths.sourceLock),
  ]);
  const manifest = parseJson(manifestText, paths.sourceManifest);
  const lock = parseJson(lockText, paths.sourceLock);
  const dependencies = manifest.dependencies || {};

  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
      throw new Error(
        `${server} runtime dependency ${name} must use an exact version, found ${version}.`
      );
    }
  }

  const lockedRoot = lock.packages?.['']?.dependencies || {};
  if (!sameDependencyMap(dependencies, lockedRoot)) {
    throw new Error(`${server} runtime manifest and committed lockfile dependencies do not match.`);
  }

  return {
    server,
    paths,
    manifestText,
    lockText,
    manifest,
    lock,
    dependencies,
    dependencyNames: Object.keys(dependencies).sort(),
  };
}

function runProcess(command, args, options = {}) {
  const {
    cwd,
    quiet = false,
    env = process.env,
    signal,
    timeoutMs: requestedTimeout,
    killGraceMs: requestedKillGrace,
  } = options;
  const timeoutMs = boundedTimeout(requestedTimeout, DEFAULT_PROCESS_TIMEOUT_MS, 'Process timeout');
  const killGraceMs = boundedTimeout(
    requestedKillGrace,
    DEFAULT_KILL_GRACE_MS,
    'Process kill grace',
    MAX_KILL_GRACE_MS
  );
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let terminationError = null;
    let killTimer;
    let forceSettleTimer;

    const terminate = childSignal => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        try {
          // Capture and terminate the process tree while npm.cmd's parent PID is
          // still alive; waiting for a later direct-child exit can orphan Node
          // lifecycle descendants before taskkill can discover them.
          const treeKill = spawn(
            'taskkill.exe',
            ['/PID', String(child.pid), '/T', '/F'],
            { stdio: 'ignore', windowsHide: true }
          );
          treeKill.once('error', () => {
            try {
              child.kill('SIGKILL');
            } catch {
              // The child may already have exited while taskkill was starting.
            }
          });
          return;
        } catch {
          // Fall through to the direct-child kill as a last resort.
        }
      }
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, childSignal);
        else child.kill(childSignal);
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          try {
            child.kill(childSignal);
          } catch {
            // The close/error event settles the command if it raced termination.
          }
        }
      }
    };
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(forceSettleTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const requestTermination = error => {
      if (settled || terminationError) return;
      terminationError = error;
      terminate('SIGTERM');
      killTimer = setTimeout(() => terminate('SIGKILL'), killGraceMs);
      forceSettleTimer = setTimeout(
        () => settle(terminationError),
        killGraceMs * (process.platform === 'win32' ? 4 : 2)
      );
    };
    const onAbort = () => requestTermination(abortError(signal));
    const timeoutTimer = setTimeout(
      () => requestTermination(new Error(`${command} timed out after ${timeoutMs}ms.`)),
      timeoutMs
    );

    child.stdout.on('data', chunk => {
      if (!quiet) process.stderr.write(chunk);
      else stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (!quiet) process.stderr.write(chunk);
      else stderr.push(chunk);
    });
    child.once('error', error => {
      if (!terminationError) settle(error);
    });
    child.once('close', (code, childSignal) => {
      if (terminationError) return settle(terminationError);
      if (code === 0) return settle();
      const detail = [...stdout, ...stderr]
        .map(chunk => chunk.toString('utf8'))
        .join('')
        .trim()
        .slice(0, 2_000);
      settle(
        new Error(`${command} exited with ${childSignal || code}${detail ? `: ${detail}` : ''}.`)
      );
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function existingSafeDirectory(directory) {
  const stat = await fsp.lstat(directory).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe runtime dependency directory: ${directory}`);
  }
  return true;
}

async function verifyTarget(spec, target, runCommand = runProcess, runOptions = {}) {
  throwIfAborted(runOptions.signal);
  const issues = [];
  if (!(await existingSafeDirectory(target))) {
    return { prepared: false, issues: ['durable dependency directory is missing'] };
  }

  const targetManifest = await fsp
    .readFile(path.join(target, 'package.json'), 'utf8')
    .catch(() => null);
  const targetLock = await fsp
    .readFile(path.join(target, 'package-lock.json'), 'utf8')
    .catch(() => null);
  if (targetManifest !== spec.manifestText) issues.push('runtime manifest fingerprint changed');
  if (targetLock !== spec.lockText) issues.push('runtime lockfile fingerprint changed');

  const nodeModules = path.join(target, 'node_modules');
  for (const [dependency, expectedVersion] of Object.entries(spec.dependencies)) {
    const packageFile = path.join(dependencyPath(nodeModules, dependency), 'package.json');
    const installed = await fsp.readFile(packageFile, 'utf8').catch(() => null);
    if (!installed) {
      issues.push(`${dependency} is missing`);
      continue;
    }
    try {
      const actualVersion = JSON.parse(installed).version;
      if (actualVersion !== expectedVersion) {
        issues.push(
          `${dependency} has ${actualVersion || 'no version'}, expected ${expectedVersion}`
        );
      }
    } catch {
      issues.push(`${dependency} has an invalid package manifest`);
    }
  }

  if (issues.length === 0 && spec.dependencyNames.length > 0) {
    const loadScript = `for (const name of ${JSON.stringify(spec.dependencyNames)}) require(name);`;
    await runCommand(process.execPath, ['-e', loadScript], {
      cwd: target,
      quiet: true,
      signal: runOptions.signal,
      timeoutMs: runOptions.processTimeoutMs,
      killGraceMs: runOptions.killGraceMs,
      env: runOptions.env,
    }).catch(error => {
      if (runOptions.signal?.aborted) throw error;
      issues.push(
        `runtime load check failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  if (issues.length === 0 && spec.server === 'intel') {
    const binary = path.join(
      nodeModules,
      '@vscode',
      'ripgrep',
      'bin',
      process.platform === 'win32' ? 'rg.exe' : 'rg'
    );
    const stat = await fsp.stat(binary).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) {
      issues.push('Intel ripgrep binary is missing');
    } else {
      await runCommand(binary, ['--version'], {
        cwd: target,
        quiet: true,
        signal: runOptions.signal,
        timeoutMs: runOptions.processTimeoutMs,
        killGraceMs: runOptions.killGraceMs,
        env: runOptions.env,
      }).catch(error => {
        if (runOptions.signal?.aborted) throw error;
        issues.push(
          `Intel ripgrep health check failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
  }

  return { prepared: issues.length === 0, issues };
}

async function inspectRuntimeDependencies(options) {
  const { pluginRoot, dataRoot, server, runCommand = runProcess } = options;
  const spec = await loadRuntimeSpec(pluginRoot, dataRoot, server);
  if (spec.dependencyNames.length === 0) {
    return {
      server,
      prepared: true,
      dependencies: spec.dependencies,
      path: spec.paths.target,
      issues: [],
    };
  }
  const result = await verifyTarget(spec, spec.paths.target, runCommand, options);
  return {
    server,
    ...result,
    dependencies: spec.dependencies,
    path: spec.paths.target,
  };
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    // EPERM means the process exists but is owned by another principal. Treat
    // unknown platform errors conservatively and never steal from a live owner.
    return true;
  }
}

async function readLockOwner(lockDirectory) {
  const ownerFile = path.join(lockDirectory, 'owner.json');
  const raw = await fsp.readFile(ownerFile, 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.token !== 'string' ||
      parsed.token.length < 16
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function lockGeneration(owner, stat) {
  const identity = owner
    ? `owner:${owner.token}`
    : `incomplete:${stat?.dev}:${stat?.ino}:${stat?.birthtimeMs}:${stat?.mtimeMs}:${stat?.size}`;
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

async function quarantineLock(lockDirectory, generation, suffix, removeAfterMove) {
  const quarantine = `${lockDirectory}.${suffix}.${generation}`;
  try {
    await fsp.rename(lockDirectory, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    const destinationExists = await fsp.lstat(quarantine).then(
      () => true,
      () => false
    );
    if (destinationExists) return false;
    throw error;
  }
  if (removeAfterMove) {
    await fsp.rm(quarantine, { recursive: true, force: true });
  }
  return true;
}

async function acquireServerLock(lockDirectory, options = {}) {
  const waitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const staleMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const started = Date.now();
  const token = crypto.randomBytes(16).toString('hex');
  await fsp.mkdir(path.dirname(lockDirectory), { recursive: true, mode: 0o700 });

  while (true) {
    throwIfAborted(options.signal);
    try {
      await fsp.mkdir(lockDirectory, { mode: 0o700 });
      try {
        await fsp.writeFile(
          path.join(lockDirectory, 'owner.json'),
          `${JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() })}\n`,
          { mode: 0o600, flag: 'wx' }
        );
      } catch (error) {
        await fsp.rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return async () => {
        const owner = await readLockOwner(lockDirectory);
        if (owner?.token !== token) return;
        await quarantineLock(lockDirectory, lockGeneration(owner), 'released', true).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const [owner, stat] = await Promise.all([
        readLockOwner(lockDirectory),
        fsp.stat(lockDirectory).catch(() => null),
      ]);
      const deadOwner = owner && !processIsAlive(owner.pid);
      const abandonedIncompleteLock = !owner && stat && Date.now() - stat.mtimeMs > staleMs;
      if (deadOwner || abandonedIncompleteLock) {
        // Keep a generation-stable tombstone. Every contender that observed this
        // exact dead owner targets the same destination, so only one rename can
        // win and a delayed contender cannot rename a newer live lock.
        const generation = lockGeneration(owner, stat);
        const reaped = await quarantineLock(lockDirectory, generation, 'stale', false).catch(error => {
          if (error?.code === 'ENOENT') return false;
          throw error;
        });
        if (!reaped) await delay(25, options.signal);
        continue;
      }
      if (Date.now() - started >= waitMs) {
        throw new Error(`Timed out waiting for runtime dependency lock: ${lockDirectory}`);
      }
      await delay(100, options.signal);
    }
  }
}

function npmInvocation() {
  const testCli = process.env.NODE_ENV === 'test' ? process.env.GOODVIBES_TEST_NPM_CLI : undefined;
  if (testCli) {
    return { command: process.execPath, prefixArgs: [path.resolve(testCli)] };
  }
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    prefixArgs: [],
  };
}

async function installLockedDependencies(spec, options) {
  const { runCommand = runProcess } = options;
  const { target } = spec.paths;
  const nonce = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const staging = `${target}.${nonce}.tmp`;
  const backup = `${target}.${nonce}.old`;
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsp.mkdir(staging, { recursive: false, mode: 0o700 });

  try {
    throwIfAborted(options.signal);
    await Promise.all([
      fsp.copyFile(spec.paths.sourceManifest, path.join(staging, 'package.json')),
      fsp.copyFile(spec.paths.sourceLock, path.join(staging, 'package-lock.json')),
    ]);
    const npmCache = path.join(spec.paths.depsRoot, '.npm-cache');
    const npmLogs = path.join(spec.paths.depsRoot, '.npm-logs');
    for (const directory of [npmCache, npmLogs]) {
      if (!(await existingSafeDirectory(directory))) {
        await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      }
    }
    const npm = npmInvocation();
    const npmEnv = { ...process.env, ...(options.env || {}) };
    for (const key of Object.keys(npmEnv)) {
      if (['npm_config_cache', 'npm_config_logs_dir'].includes(key.toLowerCase())) {
        delete npmEnv[key];
      }
    }
    npmEnv.npm_config_cache = npmCache;
    npmEnv.npm_config_logs_dir = npmLogs;
    await runCommand(
      npm.command,
      [...npm.prefixArgs, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--prefix', staging],
      {
        cwd: staging,
        quiet: false,
        env: npmEnv,
        signal: options.signal,
        timeoutMs: options.processTimeoutMs,
        killGraceMs: options.killGraceMs,
      }
    );
    const verified = await verifyTarget(spec, staging, runCommand, options);
    if (!verified.prepared) {
      throw new Error(
        `${spec.server} dependency verification failed: ${verified.issues.join('; ')}`
      );
    }

    throwIfAborted(options.signal);
    await fsp.rm(backup, { recursive: true, force: true });
    const targetExists = await existingSafeDirectory(target);
    if (targetExists) await fsp.rename(target, backup);
    try {
      await fsp.rename(staging, target);
    } catch (error) {
      if (await existingSafeDirectory(backup)) await fsp.rename(backup, target);
      throw error;
    }
    await fsp.rm(backup, { recursive: true, force: true });
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function ensureRuntimeDependenciesWithinBudget(options) {
  const { pluginRoot, dataRoot, server, runCommand = runProcess } = options;
  if (
    process.env.NODE_ENV === 'test' &&
    process.env.GOODVIBES_TEST_DISABLE_AUTO_REPAIR === '1' &&
    options.allowTestSkip === true
  ) {
    return { server, prepared: false, repaired: false, skipped: true, issues: ['test skip'] };
  }

  const spec = await loadRuntimeSpec(pluginRoot, dataRoot, server);
  if (spec.dependencyNames.length === 0) {
    return { server, prepared: true, repaired: false, dependencies: spec.dependencies, issues: [] };
  }

  const first = await verifyTarget(spec, spec.paths.target, runCommand, options);
  if (first.prepared) {
    return { server, ...first, repaired: false, dependencies: spec.dependencies };
  }

  const release = await acquireServerLock(spec.paths.lock, options);
  try {
    const afterLock = await verifyTarget(spec, spec.paths.target, runCommand, options);
    if (afterLock.prepared) {
      return { server, ...afterLock, repaired: false, dependencies: spec.dependencies };
    }
    await installLockedDependencies(spec, options);
    const final = await verifyTarget(spec, spec.paths.target, runCommand, options);
    if (!final.prepared) {
      throw new Error(`${server} dependencies remain unhealthy: ${final.issues.join('; ')}`);
    }
    return { server, ...final, repaired: true, dependencies: spec.dependencies };
  } finally {
    await release();
  }
}

async function ensureRuntimeDependencies(options) {
  const repairTimeoutMs = boundedTimeout(
    options.repairTimeoutMs,
    DEFAULT_REPAIR_TIMEOUT_MS,
    'Repair timeout'
  );
  const processTimeoutMs = boundedTimeout(
    options.processTimeoutMs,
    DEFAULT_PROCESS_TIMEOUT_MS,
    'Process timeout'
  );
  const killGraceMs = boundedTimeout(
    options.killGraceMs,
    DEFAULT_KILL_GRACE_MS,
    'Process kill grace',
    MAX_KILL_GRACE_MS
  );
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`Automatic runtime dependency repair timed out after ${repairTimeoutMs}ms.`)
      ),
    repairTimeoutMs
  );
  try {
    return await ensureRuntimeDependenciesWithinBudget({
      ...options,
      signal: controller.signal,
      processTimeoutMs,
      killGraceMs,
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  SERVERS,
  ensureRuntimeDependencies,
  inspectRuntimeDependencies,
  runtimePaths,
  runProcess,
};
