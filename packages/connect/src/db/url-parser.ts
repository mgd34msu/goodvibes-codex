/**
 * Database connection URL parser for PostgreSQL, MySQL, and SQLite, covering
 * in-memory and bare file paths.
 */

import type { DatabaseConnectionInfo } from './types.js';

const MIN_PORT = 1;
const MAX_PORT = 65535;

function validatePort(port: number, context: string): void {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `Invalid port ${port} in ${context} URL. Port must be an integer between ${MIN_PORT} and ${MAX_PORT}.`
    );
  }
}

function decodeComponent(value: string, context: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Invalid percent-encoding in ${context} connection URL.`);
  }
}

function requireVerifiedTls(
  parsed: URL,
  context: 'PostgreSQL' | 'MySQL',
  parameter: 'sslmode' | 'ssl-mode',
  expectedValue: 'verify-full' | 'VERIFY_IDENTITY'
): void {
  if (parsed.hash) {
    throw new Error(`${context} connection URLs may not contain a fragment.`);
  }
  const keys = [...parsed.searchParams.keys()];
  const values = parsed.searchParams.getAll(parameter);
  const normalized = context === 'PostgreSQL' ? values[0]?.toLowerCase() : values[0]?.toUpperCase();
  if (
    keys.length !== 1 ||
    keys[0] !== parameter ||
    values.length !== 1 ||
    normalized !== expectedValue
  ) {
    throw new Error(
      `${context} connections require the sole URL parameter ` +
        `${parameter}=${expectedValue}; insecure or ignored connection options are refused.`
    );
  }
}

function validateHostname(hostname: string, context: string): void {
  if (!hostname || hostname.trim() === '') {
    throw new Error(`Invalid or empty hostname in ${context} URL.`);
  }
}

/**
 * Parse a database connection URL into structured connection info.
 * @param url - a connection URL or a bare SQLite file path
 * @returns parsed info, or `{ type: 'unknown' }` when unrecognised
 */
export function parseConnectionUrl(url: string): DatabaseConnectionInfo {
  if (url === ':memory:' || url === 'sqlite::memory:' || url === 'sqlite://:memory:') {
    return { type: 'sqlite', database: ':memory:', filepath: ':memory:' };
  }

  if (url.startsWith('sqlite:') || url.startsWith('file:')) {
    let filepath = url.replace(/^sqlite:(\/\/)?/, '').replace(/^file:/, '');

    if (filepath === ':memory:' || filepath === '/:memory:') {
      return { type: 'sqlite', database: ':memory:', filepath: ':memory:' };
    }

    if (
      !filepath.startsWith('/') &&
      !filepath.startsWith('./') &&
      !filepath.match(/^[A-Za-z]:[/\\]/)
    ) {
      filepath = './' + filepath;
    }

    return { type: 'sqlite', database: filepath, filepath };
  }

  if (url.match(/\.(db|sqlite|sqlite3)$/i)) {
    let filepath = url;
    if (
      !filepath.startsWith('/') &&
      !filepath.startsWith('./') &&
      !filepath.match(/^[A-Za-z]:[/\\]/)
    ) {
      filepath = './' + filepath;
    }
    return { type: 'sqlite', database: filepath, filepath };
  }

  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid PostgreSQL connection URL.');
    }
    const host = parsed.hostname;
    const port = parsed.port ? parseInt(parsed.port, 10) : 5432;
    validateHostname(host, 'PostgreSQL');
    validatePort(port, 'PostgreSQL');
    requireVerifiedTls(parsed, 'PostgreSQL', 'sslmode', 'verify-full');
    return {
      type: 'postgresql',
      host,
      port,
      database: decodeComponent(parsed.pathname.replace(/^\//, ''), 'PostgreSQL') || 'postgres',
      user: parsed.username ? decodeComponent(parsed.username, 'PostgreSQL') : undefined,
      password: parsed.password ? decodeComponent(parsed.password, 'PostgreSQL') : undefined,
      tls: { rejectUnauthorized: true },
    };
  }

  if (url.startsWith('mysql://')) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid MySQL connection URL.');
    }
    const host = parsed.hostname;
    const port = parsed.port ? parseInt(parsed.port, 10) : 3306;
    validateHostname(host, 'MySQL');
    validatePort(port, 'MySQL');
    requireVerifiedTls(parsed, 'MySQL', 'ssl-mode', 'VERIFY_IDENTITY');
    return {
      type: 'mysql',
      host,
      port,
      database: decodeComponent(parsed.pathname.replace(/^\//, ''), 'MySQL') || 'mysql',
      user: parsed.username ? decodeComponent(parsed.username, 'MySQL') : undefined,
      password: parsed.password ? decodeComponent(parsed.password, 'MySQL') : undefined,
      tls: { rejectUnauthorized: true },
    };
  }

  return { type: 'unknown', database: '' };
}
