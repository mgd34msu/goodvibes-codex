import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export function goodvibesDataRoot(env = process.env) {
  if (env.GOODVIBES_DATA_ROOT) return path.resolve(env.GOODVIBES_DATA_ROOT);
  const pluginRoot = env.PLUGIN_ROOT ? path.resolve(env.PLUGIN_ROOT) : null;
  const marker = `${path.sep}plugins${path.sep}cache${path.sep}`;
  const markerIndex = pluginRoot?.toLowerCase().lastIndexOf(marker.toLowerCase()) ?? -1;
  const inferred = pluginRoot && markerIndex > 0 ? pluginRoot.slice(0, markerIndex) : null;
  const codexHome = env.CODEX_HOME
    ? path.resolve(env.CODEX_HOME)
    : inferred || path.join(homedir(), '.codex');
  return path.join(codexHome, 'goodvibes');
}

export function hookDataRoot(env = process.env) {
  return env.PLUGIN_DATA
    ? path.resolve(env.PLUGIN_DATA)
    : path.join(goodvibesDataRoot(env), 'hooks');
}

export function projectStateRoot(cwd) {
  return path.join(path.resolve(cwd), '.goodvibes', 'codex');
}

export function canonicalCwd(value) {
  const resolved = path.resolve(typeof value === 'string' && value ? value : process.cwd());
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function workspaceKey(cwd) {
  return createHash('sha256').update(canonicalCwd(cwd)).digest('hex').slice(0, 24);
}

export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  return dir;
}

export function readJson(file, fallback = {}) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  const dir = ensurePrivateDir(path.dirname(file));
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  );
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      // Best effort on platforms without POSIX modes.
    }
    return true;
  } catch {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Ignore cleanup failures.
    }
    return false;
  }
}
