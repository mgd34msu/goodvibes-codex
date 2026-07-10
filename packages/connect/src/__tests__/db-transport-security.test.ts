import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMockDrivers, setMockDriver } from '../db/drivers.js';
import { executeMysql } from '../db/executors/mysql.js';
import { executePostgres } from '../db/executors/postgres.js';
import { parseConnectionUrl } from '../db/url-parser.js';

describe('database transport policy', () => {
  afterEach(() => {
    clearMockDrivers();
    vi.restoreAllMocks();
  });

  it.each([
    'postgresql://user:pass@db.example.test/app',
    'postgresql://user:pass@db.example.test/app?sslmode=disable',
    'postgresql://user:pass@db.example.test/app?sslmode=require',
    'postgresql://user:pass@db.example.test/app?sslmode=verify-full&application_name=goodvibes',
    'mysql://user:pass@db.example.test/app',
    'mysql://user:pass@db.example.test/app?ssl-mode=DISABLED',
    'mysql://user:pass@db.example.test/app?ssl-mode=VERIFY_CA',
    'mysql://user:pass@db.example.test/app?ssl-mode=VERIFY_IDENTITY&charset=utf8mb4',
  ])('rejects an insecure or partially ignored TCP database URL: %s', url => {
    expect(() => parseConnectionUrl(url)).toThrow(/require|refused/i);
  });

  it('accepts only PostgreSQL verify-full and decodes URL components', () => {
    expect(
      parseConnectionUrl(
        'postgresql://user%40example.test:p%40ss@db.example.test:5433/my%20db?sslmode=verify-full'
      )
    ).toEqual({
      type: 'postgresql',
      host: 'db.example.test',
      port: 5433,
      database: 'my db',
      user: 'user@example.test',
      password: 'p@ss',
      tls: { rejectUnauthorized: true },
    });
  });

  it('accepts only MySQL VERIFY_IDENTITY', () => {
    expect(
      parseConnectionUrl('mysql://user:pass@db.example.test/app?ssl-mode=VERIFY_IDENTITY')
    ).toMatchObject({
      type: 'mysql',
      host: 'db.example.test',
      port: 3306,
      database: 'app',
      tls: { rejectUnauthorized: true },
    });
  });

  it('passes verified TLS to the PostgreSQL driver', async () => {
    let clientConfig: Record<string, unknown> | undefined;
    class Client {
      constructor(config: Record<string, unknown>) {
        clientConfig = config;
      }
      async connect(): Promise<void> {}
      async query(sql: string): Promise<{ rows: unknown[]; fields: unknown[] }> {
        return sql === 'SELECT 1'
          ? { rows: [{ value: 1 }], fields: [{ name: 'value', dataTypeID: 23 }] }
          : { rows: [], fields: [] };
      }
      async end(): Promise<void> {}
    }
    setMockDriver('pg', { Client });

    await executePostgres(
      parseConnectionUrl('postgresql://user:pass@db.example.test/app?sslmode=verify-full'),
      'SELECT 1'
    );

    expect(clientConfig?.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('passes verified TLS to the MySQL driver', async () => {
    let connectionConfig: Record<string, unknown> | undefined;
    const connection = {
      query: vi.fn(async () => undefined),
      execute: vi.fn(async () => [[{ value: 1 }], [{ name: 'value', type: 3 }]]),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
    };
    setMockDriver('mysql2/promise', {
      createConnection: vi.fn(async (config: Record<string, unknown>) => {
        connectionConfig = config;
        return connection;
      }),
    });

    await executeMysql(
      parseConnectionUrl('mysql://user:pass@db.example.test/app?ssl-mode=VERIFY_IDENTITY'),
      'SELECT 1'
    );

    expect(connectionConfig?.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('makes executors fail closed if called without a verified TLS marker', async () => {
    await expect(
      executePostgres(
        {
          type: 'postgresql',
          host: 'db.example.test',
          port: 5432,
          database: 'app',
        },
        'SELECT 1'
      )
    ).rejects.toThrow(/verified TLS/i);
    await expect(
      executeMysql(
        {
          type: 'mysql',
          host: 'db.example.test',
          port: 3306,
          database: 'app',
        },
        'SELECT 1'
      )
    ).rejects.toThrow(/verified TLS/i);
  });
});
