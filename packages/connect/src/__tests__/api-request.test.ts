/**
 * `api_request` tool tests — the §1.8/§4.4.4 behaviors and the F8 lesson.
 *
 * fetch is stubbed on globalThis so no network is touched; the rate limiter is
 * reset per test to avoid inter-test delay. Config is pinned via a project
 * config file so `mode` is deterministic regardless of the host's user config.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleApiRequest } from '../tools/api-request.js';
import * as registry from '../fetch/service-registry.js';
import { setServiceSecret } from '../fetch/secrets-store.js';
import { globalRateLimiter, setFetchImplementationForTests } from '../fetch/rate-limiter.js';
import type { Response as UndiciResponse } from 'undici';
import { setNetworkResolverForTests } from '../fetch/network-policy.js';
import { resetConfigCache } from '@goodvibes/core/config';

const STATE = ['.goodvibes'];

interface ParsedEnvelope {
  success: boolean;
  error?: string;
  data?: { mode: string; results: Record<string, ParsedResult> };
  meta: { mode?: string; truncated?: boolean; effective_caps?: Record<string, number> };
}
interface ParsedResult {
  status: number | null;
  resolved_url: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  truncated: boolean;
  error: string | null;
  warning?: string;
}

async function call(args: unknown): Promise<ParsedEnvelope> {
  const res = await handleApiRequest(args);
  const block = (res.content as { type: string; text: string }[])[0];
  return JSON.parse(block.text) as ParsedEnvelope;
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('api_request', () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;
  const originalDataRoot = process.env.GOODVIBES_DATA_ROOT;

  async function setMode(mode: 'restricted' | 'open'): Promise<void> {
    await fs.promises.writeFile(
      path.join(tmpDir, ...STATE, 'config.json'),
      JSON.stringify({ mode }),
      'utf-8'
    );
    resetConfigCache();
  }

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'api-request-test-'));
    await fs.promises.mkdir(path.join(tmpDir, ...STATE), { recursive: true });
    process.env.GOODVIBES_DATA_ROOT = path.join(tmpDir, ...STATE);
    await setMode('restricted');
    setNetworkResolverForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
    globalRateLimiter.reset();
    originalFetch = globalThis.fetch;
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

  it('runs a registered-service request and stamps restricted mode', async () => {
    await registry.addService('demo', { base_url: 'https://api.demo.test' });
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true, id: 42 })) as typeof fetch;

    const env = await call({
      requests: [{ id: 'get1', service: 'demo', path: '/v1/thing', extract: 'json' }],
    });

    expect(env.success).toBe(true);
    expect(env.meta.mode).toBe('restricted');
    expect(env.data!.mode).toBe('restricted');
    const r = env.data!.results.get1;
    expect(r.status).toBe(200);
    expect(r.resolved_url).toBe('https://api.demo.test/v1/thing');
    expect(r.error).toBeNull();
    expect(r.body).toEqual({ ok: true, id: 42 });
  });

  it('isolates a malformed entry — the rest of the batch still runs', async () => {
    await registry.addService('demo', { base_url: 'https://api.demo.test' });
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true })) as typeof fetch;

    const env = await call({
      requests: [
        { id: 'good', service: 'demo', path: '/ok' },
        { id: 'bad' }, // neither service+path nor url
      ],
    });

    expect(env.success).toBe(true);
    expect(env.data!.results.good.status).toBe(200);
    expect(env.data!.results.bad.status).toBeNull();
    expect(env.data!.results.bad.error).toContain('service+path or an absolute url');
  });

  it('denies an unregistered destination in restricted mode (allowlist default-on)', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ nope: true }));
    globalThis.fetch = fetchSpy as typeof fetch;

    const env = await call({ requests: [{ id: 'x', url: 'https://evil.test/steal' }] });

    const r = env.data!.results.x;
    expect(r.error).toContain('not a registered service origin');
    expect(fetchSpy).not.toHaveBeenCalled(); // never left the boundary
  });

  it('reaches an allowlisted host in restricted mode', async () => {
    await registry.addAllowlistHost('cdn.demo.test');
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true })) as typeof fetch;

    const env = await call({ requests: [{ id: 'x', url: 'https://cdn.demo.test/file.json' }] });
    expect(env.data!.results.x.status).toBe(200);
  });

  it('blocks a write on a read-only service, allows it after write_methods opt-in', async () => {
    await registry.addService('demo', { base_url: 'https://api.demo.test' });
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ created: true }, { status: 201 })
    ) as typeof fetch;

    const blocked = await call({
      requests: [{ id: 'w', service: 'demo', path: '/things', method: 'POST' }],
    });
    expect(blocked.data!.results.w.error).toContain('read-only by default');

    await registry.addService(
      'demo',
      { base_url: 'https://api.demo.test', write_methods: ['POST'] },
      true
    );
    const allowed = await call({
      requests: [{ id: 'w', service: 'demo', path: '/things', method: 'POST', extract: 'status' }],
    });
    expect(allowed.data!.results.w.status).toBe(201);
    expect(allowed.data!.results.w.body).toBeUndefined(); // status extract carries no body
  });

  it('redacts known secret values from echoed responses', async () => {
    const token = 'sk_live_supersecrettoken';
    await registry.addService('demo', { base_url: 'https://api.demo.test', auth_type: 'bearer' });
    await setServiceSecret('demo', {
      type: 'bearer',
      token,
      service_origin: 'https://api.demo.test',
    });
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ reflected: token, note: `auth was Bearer ${token}` })
    ) as typeof fetch;

    const env = await call({
      requests: [{ id: 'x', service: 'demo', path: '/echo', extract: 'json' }],
    });
    const body = env.data!.results.x.body as { reflected: string; note: string };
    expect(body.reflected).toBe('***REDACTED***');
    expect(body.note).not.toContain(token);
  });

  it('does not attach an orphan credential when the registry has no matching auth type', async () => {
    await registry.addService('demo', { base_url: 'https://api.demo.test' });
    await setServiceSecret('demo', {
      type: 'bearer',
      token: 'orphan-token',
      service_origin: 'https://api.demo.test',
    });
    let seenHeaders: Record<string, string> | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      seenHeaders = options?.headers as Record<string, string>;
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const env = await call({
      requests: [{ id: 'x', service: 'demo', path: '/', extract: 'json' }],
    });
    expect(env.data!.results.x.status).toBe(200);
    expect(seenHeaders?.Authorization).toBeUndefined();
  });

  it('refuses registered static credentials over plaintext HTTP before fetching', async () => {
    await registry.addService('demo', {
      base_url: 'http://api.demo.test',
      auth_type: 'bearer',
    });
    await setServiceSecret('demo', {
      type: 'bearer',
      token: 'plaintext-token',
      service_origin: 'http://api.demo.test',
    });
    const fetchSpy = vi.fn(async () => jsonResponse({ unexpected: true }));
    globalThis.fetch = fetchSpy as typeof fetch;

    const env = await call({ requests: [{ id: 'x', service: 'demo', path: '/' }] });
    expect(env.data!.results.x.error).toMatch(/require HTTPS/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honors extract modes (text and headers)', async () => {
    await registry.addService('demo', { base_url: 'https://api.demo.test' });
    globalThis.fetch = vi.fn(
      async () => new Response('plain body', { status: 200, headers: { 'x-demo': 'yes' } })
    ) as typeof fetch;

    const textEnv = await call({
      requests: [{ id: 't', service: 'demo', path: '/x', extract: 'text' }],
    });
    expect(textEnv.data!.results.t.body).toBe('plain body');

    const headersEnv = await call({
      requests: [{ id: 'h', service: 'demo', path: '/x', extract: 'headers' }],
    });
    expect(headersEnv.data!.results.h.headers?.['x-demo']).toBe('yes');
    expect(headersEnv.data!.results.h.body).toBeUndefined();
  });

  it('F8 lesson: accepts both plain and base64 body forms, preferring base64 with a warning', async () => {
    await registry.addService('demo', {
      base_url: 'https://api.demo.test',
      write_methods: ['POST'],
    });
    let seenBody: string | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, opts?: RequestInit) => {
      seenBody = opts?.body as string;
      return jsonResponse({ ok: true }, { status: 201 });
    }) as typeof fetch;

    const env = await call({
      requests: [
        {
          id: 'w',
          service: 'demo',
          path: '/things',
          method: 'POST',
          body_plain: 'PLAIN',
          body_base64: Buffer.from('FROM_BASE64').toString('base64'),
        },
      ],
    });

    expect(env.data!.results.w.status).toBe(201);
    expect(env.data!.results.w.warning).toContain('body_base64');
    expect(Buffer.from(seenBody as unknown as Uint8Array).toString('utf8')).toBe('FROM_BASE64');
  });

  it('caps oversized response bodies to the token budget', async () => {
    await registry.addService('demo', { base_url: 'https://api.demo.test' });
    const big = 'x'.repeat(20000);
    globalThis.fetch = vi.fn(async () => new Response(big, { status: 200 })) as typeof fetch;

    const env = await call({
      requests: [{ id: 'big', service: 'demo', path: '/blob', extract: 'text' }],
      output: { max_tokens: 200 },
    });

    expect(env.meta.truncated).toBe(true);
    expect(env.meta.effective_caps?.max_tokens).toBe(200);
    expect(env.data!.results.big.truncated).toBe(true);
    expect((env.data!.results.big.body as string).length).toBeLessThan(big.length);
  });

  it('rejects an empty batch', async () => {
    const env = await call({ requests: [] });
    expect(env.success).toBe(false);
    expect(env.error).toContain('non-empty');
    expect(env.meta.mode).toBe('restricted');
  });
});
