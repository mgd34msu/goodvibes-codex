import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetConfigCache } from '@goodvibes/core/config';
import { setNetworkResolverForTests } from '../fetch/network-policy.js';
import { globalRateLimiter, setFetchImplementationForTests } from '../fetch/rate-limiter.js';
import type { Response as UndiciResponse } from 'undici';
import * as registry from '../fetch/service-registry.js';
import { setServiceSecret } from '../fetch/secrets-store.js';
import { handleApiRequest } from '../tools/api-request.js';

interface ParsedResult {
  status: number | null;
  resolved_url: string | null;
  body?: unknown;
  truncated: boolean;
  error: string | null;
  warning?: string;
}

interface ParsedEnvelope {
  success: boolean;
  error?: string;
  data?: { mode: string; results: Record<string, ParsedResult> };
  meta: { truncated?: boolean; effective_caps?: Record<string, number> };
}

async function call(args: unknown): Promise<ParsedEnvelope> {
  const result = await handleApiRequest(args);
  const block = (result.content as Array<{ type: string; text: string }>)[0];
  return JSON.parse(block.text) as ParsedEnvelope;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  expect(init?.headers).toBeDefined();
  return init!.headers as Record<string, string>;
}

describe('api_request adversarial boundary', () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalDataRoot: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'api-request-security-'));
    originalDataRoot = process.env.GOODVIBES_DATA_ROOT;
    process.env.GOODVIBES_DATA_ROOT = path.join(tmpDir, '.goodvibes');
    await fs.promises.mkdir(process.env.GOODVIBES_DATA_ROOT, { recursive: true });
    await fs.promises.writeFile(
      path.join(process.env.GOODVIBES_DATA_ROOT, 'config.json'),
      JSON.stringify({ mode: 'restricted' })
    );
    resetConfigCache();
    originalFetch = globalThis.fetch;
    setNetworkResolverForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
    globalRateLimiter.reset();
    globalRateLimiter.updateConfig({ per_domain: 100, delay_ms: 0 });
    setFetchImplementationForTests(
      (url, options) =>
        globalThis.fetch(
          url,
          options as unknown as RequestInit
        ) as unknown as Promise<UndiciResponse>
    );
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    setFetchImplementationForTests();
    globalRateLimiter.reset();
    globalRateLimiter.updateConfig({ per_domain: 2, delay_ms: 500 });
    setNetworkResolverForTests();
    resetConfigCache();
    vi.restoreAllMocks();
    if (originalDataRoot === undefined) {
      delete process.env.GOODVIBES_DATA_ROOT;
    } else {
      process.env.GOODVIBES_DATA_ROOT = originalDataRoot;
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects duplicate result IDs before issuing any request', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ unexpected: true }));
    globalThis.fetch = fetchSpy as typeof fetch;

    const envelope = await call({
      requests: [
        { id: 'same', url: 'https://one.example.test/' },
        { id: 'same', url: 'https://two.example.test/' },
      ],
    });

    expect(envelope.success).toBe(false);
    expect(envelope.error).toMatch(/duplicate request id/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects per-request auth and caller-managed sensitive headers', async () => {
    await registry.addService('demo', { base_url: 'https://api.demo.test' });
    const fetchSpy = vi.fn(async () => jsonResponse({ unexpected: true }));
    globalThis.fetch = fetchSpy as typeof fetch;

    const envelope = await call({
      requests: [
        {
          id: 'inline-auth',
          service: 'demo',
          path: '/x',
          auth: { type: 'bearer', token: 'attacker-controlled' },
        },
        {
          id: 'authorization',
          service: 'demo',
          path: '/x',
          headers: { Authorization: 'Bearer leak' },
        },
        { id: 'cookie', service: 'demo', path: '/x', headers: { Cookie: 'session=leak' } },
        { id: 'host', service: 'demo', path: '/x', headers: { Host: 'evil.example' } },
        {
          id: 'proxy',
          service: 'demo',
          path: '/x',
          headers: { 'Proxy-Authorization': 'Basic leak' },
        },
        { id: 'api-key', service: 'demo', path: '/x', headers: { 'X-API-Key': 'caller-secret' } },
        {
          id: 'auth-token',
          service: 'demo',
          path: '/x',
          headers: { 'X-Auth-Token': 'caller-secret' },
        },
      ],
    });

    expect(envelope.success).toBe(true);
    expect(envelope.data!.results['inline-auth'].error).toMatch(/per-request authentication/i);
    for (const id of ['authorization', 'cookie', 'host', 'proxy', 'api-key', 'auth-token']) {
      expect(envelope.data!.results[id].error, `${id} must be rejected`).toEqual(
        expect.stringMatching(/control-plane managed/i)
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('revalidates every redirect destination after DNS resolution', async () => {
    await registry.addService('demo', { base_url: 'https://api.demo.test' });
    await registry.addAllowlistHost('redirect.example.test');
    setNetworkResolverForTests(async hostname =>
      hostname === 'redirect.example.test'
        ? [{ address: '10.0.0.7', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }]
    );
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://redirect.example.test/private' },
        })
    );
    globalThis.fetch = fetchSpy as typeof fetch;

    const envelope = await call({
      requests: [{ id: 'hop', service: 'demo', path: '/redirect', extract: 'status' }],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(envelope.data!.results.hop.resolved_url).toBe('https://redirect.example.test/private');
    expect(envelope.data!.results.hop.error).toMatch(/private|reserved/i);
  });

  it('strips credentials and non-safe headers on a cross-origin redirect', async () => {
    const secret = 'cross-origin-secret-token';
    await registry.addService('demo', {
      base_url: 'https://api.demo.test',
      auth_type: 'bearer',
      default_headers: { Accept: 'application/json', 'X-Trace': 'internal-trace' },
    });
    await registry.addAllowlistHost('other.example.test');
    await setServiceSecret('demo', {
      type: 'bearer',
      token: secret,
      service_origin: 'https://api.demo.test',
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://other.example.test/final' },
        });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const envelope = await call({
      requests: [{ id: 'hop', service: 'demo', path: '/redirect', extract: 'json' }],
    });

    expect(envelope.data!.results.hop.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(headerRecord(calls[0].init).Authorization).toBe(`Bearer ${secret}`);
    const redirectedHeaders = headerRecord(calls[1].init);
    expect(redirectedHeaders.Authorization).toBeUndefined();
    expect(redirectedHeaders['X-Trace']).toBeUndefined();
    expect(redirectedHeaders.Accept).toBe('application/json');
    expect(JSON.stringify(calls[1])).not.toContain(secret);
  });

  it('denies redirects for write requests', async () => {
    await registry.addService('demo', {
      base_url: 'https://api.demo.test',
      write_methods: ['POST'],
    });
    const fetchSpy = vi.fn(
      async () => new Response(null, { status: 307, headers: { location: '/elsewhere' } })
    );
    globalThis.fetch = fetchSpy as typeof fetch;

    const envelope = await call({
      requests: [{ id: 'write', service: 'demo', path: '/create', method: 'POST' }],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(envelope.data!.results.write.error).toMatch(/redirects for write requests/i);
  });

  it('stops after the bounded redirect limit', async () => {
    await registry.addService('demo', { base_url: 'https://api.demo.test' });
    const fetchSpy = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: '/again' } })
    );
    globalThis.fetch = fetchSpy as typeof fetch;

    const envelope = await call({
      requests: [{ id: 'loop', service: 'demo', path: '/start', extract: 'status' }],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect(envelope.data!.results.loop.error).toMatch(/redirect limit exceeded/i);
  });

  it('caps bytes while streaming an oversized response', async () => {
    await registry.addService('demo', { base_url: 'https://api.demo.test' });
    const source = 'x'.repeat(12_000);
    globalThis.fetch = vi.fn(async () => new Response(source)) as typeof fetch;

    const envelope = await call({
      requests: [{ id: 'large', service: 'demo', path: '/large', extract: 'text' }],
      output: { max_tokens: 1024 },
    });

    const result = envelope.data!.results.large;
    expect(result.truncated).toBe(true);
    expect(result.warning).toContain('capped at 4096 bytes');
    expect(Buffer.byteLength(result.body as string)).toBeLessThanOrEqual(4096);
  });

  it('preserves arbitrary request-body bytes decoded from base64', async () => {
    await registry.addService('demo', {
      base_url: 'https://api.demo.test',
      write_methods: ['POST'],
    });
    const expected = Uint8Array.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x00, 0x42]);
    let received: Uint8Array | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      received = init?.body as Uint8Array;
      return jsonResponse({ ok: true }, { status: 201 });
    }) as typeof fetch;

    const envelope = await call({
      requests: [
        {
          id: 'binary',
          service: 'demo',
          path: '/upload',
          method: 'POST',
          body_base64: Buffer.from(expected).toString('base64'),
        },
      ],
    });

    expect(envelope.data!.results.binary.status).toBe(201);
    expect(received).toBeInstanceOf(Uint8Array);
    expect([...received!]).toEqual([...expected]);
  });
});
