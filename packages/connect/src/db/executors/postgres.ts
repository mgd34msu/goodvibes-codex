/**
 * PostgreSQL query executor.
 *
 * The `pg` driver loads lazily from the plugin's prepared dependency directory
 * and requires verified TLS.
 */

import type { DatabaseConnectionInfo, ColumnInfo, ExecutionResult } from '../types.js';
import { loadPostgresDriver } from '../drivers.js';
import { ConnectionError, QueryError } from '../errors.js';

/** Map a PostgreSQL type OID to a human-readable type name. */
export function getPostgresTypeName(oid: number): string {
  const typeMap: Record<number, string> = {
    16: 'boolean',
    20: 'bigint',
    21: 'smallint',
    23: 'integer',
    25: 'text',
    114: 'json',
    700: 'real',
    701: 'double precision',
    1043: 'varchar',
    1082: 'date',
    1083: 'time',
    1114: 'timestamp',
    1184: 'timestamptz',
    1700: 'numeric',
    1186: 'interval',
    2950: 'uuid',
    3802: 'jsonb',
    2277: 'anyarray',
  };
  return typeMap[oid] || 'unknown';
}

/** Execute a SQL query against PostgreSQL using a single isolated client. */
export async function executePostgres(
  connectionInfo: DatabaseConnectionInfo,
  query: string,
  params: unknown[] = [],
  readonly = true
): Promise<ExecutionResult> {
  if (connectionInfo.tls?.rejectUnauthorized !== true) {
    throw new ConnectionError('PostgreSQL verified TLS policy is missing.');
  }
  const pg = await loadPostgresDriver();
  if (!pg) {
    throw new Error(
      'PostgreSQL driver (pg) is unavailable. GoodVibes launchers and $goodvibes-maintenance automatically retry the locked dependency repair; dependency-free Connect surfaces remain usable if repair cannot complete.'
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Client } = pg as any;
  const client = new Client({
    host: connectionInfo.host,
    port: connectionInfo.port,
    database: connectionInfo.database,
    user: connectionInfo.user,
    password: connectionInfo.password,
    ssl: connectionInfo.tls,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  });

  try {
    await client.connect();
  } catch (cause) {
    throw new ConnectionError(
      `Failed to connect to PostgreSQL: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause
    );
  }

  try {
    await client.query(readonly ? 'BEGIN READ ONLY' : 'BEGIN');
    const result = await client.query(query, params);
    await client.query('COMMIT');
    const columns: ColumnInfo[] =
      result.fields?.map((field: { name: string; dataTypeID: number }) => ({
        name: field.name,
        type: getPostgresTypeName(field.dataTypeID),
      })) || [];
    return { rows: result.rows, columns };
  } catch (cause) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be closed */
    }
    throw new QueryError(
      `PostgreSQL query failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause
    );
  } finally {
    await client.end();
  }
}
