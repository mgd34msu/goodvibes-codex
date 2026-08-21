/**
 * connect service registry, named API service configurations.
 *
 * The library retains mutation helpers for the isolated control/test layer, but
 * the MCP service tool exposes read-only summaries only. Durable policy lives
 * beneath the shared GoodVibes data root and includes per-service write methods,
 * private-network grants, an allowlist, and named database connections.
 */

import {
  getRegistry,
  updateRegistry,
  type FetchConfig,
  type ServiceConfig,
  type UrlPattern,
  type DbConnection,
} from './registry-store.js';
import { removeServiceSecret } from './secrets-store.js';

export type { FetchConfig, ServiceConfig, UrlPattern, DbConnection } from './registry-store.js';

/** Get the full registry section. */
export function getFetchConfig(): FetchConfig {
  return getRegistry();
}

/** Get all registered services. */
export function getFetchServices(): Record<string, ServiceConfig> {
  return getFetchConfig().services ?? {};
}

/** Get a service by name, or undefined. */
export function getService(name: string): ServiceConfig | undefined {
  return getFetchServices()[name];
}

/**
 * Add or update a service configuration.
 * @param name - service name (e.g. "github")
 * @param config - service configuration
 * @param force - when false, throws on name collision (default false)
 */
export async function addService(
  name: string,
  config: ServiceConfig,
  force = false
): Promise<void> {
  await updateRegistry(async registry => {
    const services = { ...(registry.services ?? {}) };

    if (!force && name in services) {
      throw new Error(`Service "${name}" already exists. Use force=true to overwrite.`);
    }

    // Names are reusable display handles, not credential identities. Remove any
    // legacy/orphaned record before granting a name a destination (and before an
    // overwrite can change that destination).
    await removeServiceSecret(name);
    services[name] = config;
    registry.services = services;
  });
}

/**
 * Remove a service configuration AND its stored credentials and URL patterns.
 * @param name - service name to remove
 * @returns true when the service existed and was removed
 */
export async function removeService(name: string): Promise<boolean> {
  return updateRegistry(async registry => {
    const services = { ...(registry.services ?? {}) };

    if (!(name in services)) {
      return false;
    }

    delete services[name];
    registry.services = services;

    if (registry.url_patterns) {
      registry.url_patterns = registry.url_patterns.filter(p => p.service !== name);
    }

    // Revoke credentials first. If the later registry write fails, the surviving
    // service is unauthenticated rather than leaving an orphan secret behind.
    await removeServiceSecret(name);

    return true;
  });
}

/** Get all URL patterns. */
export function getUrlPatterns(): UrlPattern[] {
  return getFetchConfig().url_patterns ?? [];
}

/**
 * Add a hostname → service URL pattern.
 * @param hostname - hostname to match (e.g. "api.github.com")
 * @param serviceName - service the hostname resolves to (must exist)
 */
export async function addUrlPattern(hostname: string, serviceName: string): Promise<void> {
  await updateRegistry(registry => {
    const patterns = [...(registry.url_patterns ?? [])];

    const services = registry.services ?? {};
    if (!(serviceName in services)) {
      throw new Error(`Service "${serviceName}" not found. Add the service first.`);
    }

    const existingIndex = patterns.findIndex(p => p.hostname === hostname);
    if (existingIndex >= 0) {
      patterns[existingIndex] = { ...patterns[existingIndex], service: serviceName };
    } else {
      patterns.push({ hostname, service: serviceName });
    }

    registry.url_patterns = patterns;
  });
}

/**
 * Match a URL to a service name via hostname patterns.
 * @param url - full URL to match
 * @returns matched service name, or undefined
 */
export function matchServiceByUrl(url: string): string | undefined {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return getUrlPatterns().find(p => p.hostname === hostname)?.service;
}

/** Get global fetch defaults. */
export function getFetchGlobalDefaults(): FetchConfig['global_defaults'] {
  return getFetchConfig().global_defaults;
}

/** Set global fetch defaults. */
export async function setFetchGlobalDefaults(
  defaults: FetchConfig['global_defaults']
): Promise<void> {
  await updateRegistry(registry => {
    registry.global_defaults = defaults;
  });
}

/** List all service names. */
export function listServiceNames(): string[] {
  return Object.keys(getFetchServices());
}

/** Get the destination allowlist (extra hostnames reachable via bare `url`). */
export function getAllowlist(): string[] {
  return getFetchConfig().allowlist ?? [];
}

/** Add a hostname to the destination allowlist (idempotent). */
export async function addAllowlistHost(hostname: string): Promise<void> {
  await updateRegistry(registry => {
    const allowlist = new Set(registry.allowlist ?? []);
    allowlist.add(hostname);
    registry.allowlist = [...allowlist];
  });
}

/** Remove a hostname from the destination allowlist. Returns true when removed. */
export async function removeAllowlistHost(hostname: string): Promise<boolean> {
  return updateRegistry(registry => {
    const before = registry.allowlist ?? [];
    if (!before.includes(hostname)) {
      return false;
    }
    registry.allowlist = before.filter(h => h !== hostname);
    return true;
  });
}

// ── Registered database connections (db_query trust model) ───────────────────

/** All registered database connections. */
export function getConnections(): Record<string, DbConnection> {
  return getFetchConfig().connections ?? {};
}

/** Get a registered connection by name, or undefined. */
export function getConnection(name: string): DbConnection | undefined {
  return getConnections()[name];
}

/** List registered connection names. */
export function listConnectionNames(): string[] {
  return Object.keys(getConnections());
}

/**
 * Register (or overwrite) a database connection.
 * @param name - connection name
 * @param connection - connection definition containing an opaque secret reference
 * @param force - when false, throws on name collision (default false)
 */
export async function addConnection(
  name: string,
  connection: DbConnection,
  force = false
): Promise<void> {
  await updateRegistry(registry => {
    const connections = { ...(registry.connections ?? {}) };
    if (!force && name in connections) {
      throw new Error(`Connection "${name}" already exists. Use force=true to overwrite.`);
    }
    connections[name] = connection;
    registry.connections = connections;
  });
}

/** Remove a registered connection. Returns true when it existed. */
export async function removeConnection(name: string): Promise<boolean> {
  return updateRegistry(registry => {
    const connections = { ...(registry.connections ?? {}) };
    if (!(name in connections)) {
      return false;
    }
    delete connections[name];
    registry.connections = connections;
    return true;
  });
}

/** Credential-free summary for a single connection (never echoes the URL). */
export function getConnectionSummary(
  name: string
): { name: string; kind: 'secret_ref'; allow_writes: boolean; description?: string } | undefined {
  const conn = getConnection(name);
  if (!conn) {
    return undefined;
  }
  return {
    name,
    kind: 'secret_ref',
    allow_writes: conn.allow_writes === true,
    description: conn.description,
  };
}

/** Credential-free summary for a single service (safe to display). */
export function getServiceSummary(
  name: string
): { name: string; base_url: string; auth_type?: string; description?: string } | undefined {
  const service = getService(name);
  if (!service) {
    return undefined;
  }
  return {
    name,
    base_url: service.base_url,
    auth_type: service.auth_type,
    description: service.description,
  };
}

/** Credential-free summaries for every service (safe to display). */
export function getAllServiceSummaries(): Array<{
  name: string;
  base_url: string;
  auth_type?: string;
  description?: string;
}> {
  return Object.entries(getFetchServices()).map(([name, config]) => ({
    name,
    base_url: config.base_url,
    auth_type: config.auth_type,
    description: config.description,
  }));
}
