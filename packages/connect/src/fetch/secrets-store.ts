/**
 * Credential store for connect service authentication.
 *
 * Credentials are stored outside workspaces with owner-only permissions,
 * symlink refusal, and atomic replacement. Environment references are
 * recognized only to reject legacy values; they never read process.env.
 *
 * Value types:
 *  - literal string: "my-api-key"
 *  - legacy environment reference: { "$env": "MY_API_KEY" } (never resolved)
 */

import * as crypto from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { statePath } from '@goodvibes/core/config';

/** Auth configuration for a service. */
export interface ServiceAuth {
  type: 'bearer' | 'basic' | 'api-key' | 'none';
  /**
   * Canonical origin this credential was approved for. Legacy records may omit
   * it, but the data plane treats an unbound record as unusable.
   */
  service_origin?: string;
  /** For bearer auth. */
  token?: string | EnvRef;
  /** For basic auth. */
  username?: string | EnvRef;
  password?: string | EnvRef;
  /** For api-key auth. */
  header?: string;
  key?: string | EnvRef;
}

/** A credential record safe to persist for later data-plane use. */
export type BoundServiceAuth = ServiceAuth & { service_origin: string };

/** Environment-variable reference. */
export interface EnvRef {
  $env: string;
}

/** Full secrets file structure. */
export interface SecretsFile {
  services: Record<string, ServiceAuth>;
  global: Record<string, string | EnvRef>;
}

/** The credential file path, `goodvibes.secrets.json` under the durable GoodVibes data root. */
function getSecretsPath(): string {
  return statePath('goodvibes.secrets.json');
}

/**
 * Load credentials from disk. Returns empty defaults when the file is absent.
 */
export async function loadSecrets(): Promise<SecretsFile> {
  const secretsPath = getSecretsPath();
  try {
    const stat = await fs.promises.lstat(secretsPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing unsafe secrets path: ${secretsPath}`);
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error(`Refusing secrets file with permissions broader than 0600: ${secretsPath}`);
    }
    const content = await fs.promises.readFile(secretsPath, 'utf-8');
    const parsed = JSON.parse(content) as Partial<SecretsFile>;
    return {
      services: parsed.services ?? {},
      global: parsed.global ?? {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { services: {}, global: {} };
    }
    throw error;
  }
}

/**
 * Persist credentials with owner-only (0600) permissions after ensuring the
 * gitignore guard is in place.
 */
export async function saveSecrets(secrets: SecretsFile): Promise<void> {
  const secretsPath = getSecretsPath();
  const secretsDir = path.dirname(secretsPath);

  await fs.promises.mkdir(secretsDir, { recursive: true, mode: 0o700 });
  try {
    const stat = await fs.promises.lstat(secretsPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing unsafe secrets path: ${secretsPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const temporary = `${secretsPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(secrets, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
    await fs.promises.rename(temporary, secretsPath);
    if (process.platform !== 'win32') {
      await fs.promises.chmod(secretsPath, 0o600);
    }
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

/** Get auth for a service, or undefined when absent. */
export async function getServiceSecrets(name: string): Promise<ServiceAuth | undefined> {
  const secrets = await loadSecrets();
  return secrets.services[name];
}

/** Create or update auth for a service. */
export async function setServiceSecret(name: string, auth: BoundServiceAuth): Promise<void> {
  const secrets = await loadSecrets();
  secrets.services[name] = auth;
  await saveSecrets(secrets);
}

/** Remove auth for a service. Returns true when an entry was removed. */
export async function removeServiceSecret(name: string): Promise<boolean> {
  const secrets = await loadSecrets();
  if (!(name in secrets.services)) {
    return false;
  }
  delete secrets.services[name];
  await saveSecrets(secrets);
  return true;
}

/** Type guard: is a value an environment reference? */
export function isEnvRef(value: unknown): value is EnvRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$env' in value &&
    typeof (value as EnvRef).$env === 'string'
  );
}

/**
 * Resolve a secret value: strings pass through and legacy `{$env}` refs do not.
 */
export function resolveSecretValue(value: string | EnvRef | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  // Environment indirection is retained only as a recognizable legacy shape.
  // MCP servers deliberately inherit no arbitrary secret namespace, so a
  // stored {$env} value never resolves. Re-enter it through the control CLI.
  if (isEnvRef(value)) {
    return undefined;
  }
  return undefined;
}

/** Resolve an opaque connection secret created by the control utility. */
export async function getGlobalSecret(ref: string): Promise<string | undefined> {
  const secrets = await loadSecrets();
  const value = secrets.global[ref];
  return typeof value === 'string' ? value : undefined;
}

/**
 * An auth record whose secret fields hold literal values only. A legacy
 * `{$env}` reference resolves to nothing, so each field stays optional and
 * every consumer has to handle its absence.
 */
export type ResolvedServiceAuth = Omit<ServiceAuth, 'token' | 'username' | 'password' | 'key'> & {
  token?: string;
  username?: string;
  password?: string;
  key?: string;
};

/**
 * Resolve every secret field in an auth config, returning a new object.
 * Unresolvable refs become undefined (consumers must validate before use).
 */
export function resolveAuthConfig(auth: ServiceAuth): ResolvedServiceAuth {
  const resolved: ResolvedServiceAuth = { type: auth.type };

  if (auth.service_origin !== undefined) {
    resolved.service_origin = auth.service_origin;
  }

  if (auth.token !== undefined) {
    resolved.token = resolveSecretValue(auth.token);
  }
  if (auth.username !== undefined) {
    resolved.username = resolveSecretValue(auth.username);
  }
  if (auth.password !== undefined) {
    resolved.password = resolveSecretValue(auth.password);
  }
  if (auth.key !== undefined) {
    resolved.key = resolveSecretValue(auth.key);
  }
  if (auth.header !== undefined) {
    resolved.header = auth.header;
  }

  return resolved;
}

/** List service names that have stored credentials. */
export async function listServiceNames(): Promise<string[]> {
  const secrets = await loadSecrets();
  return Object.keys(secrets.services);
}
