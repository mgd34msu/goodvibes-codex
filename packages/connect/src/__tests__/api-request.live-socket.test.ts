import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@goodvibes/core/config';
import { globalRateLimiter, setFetchImplementationForTests } from '../fetch/rate-limiter.js';
import { addService } from '../fetch/service-registry.js';
import { handleApiRequest } from '../tools/api-request.js';

describe('api_request real undici transport', () => {
  let tmpDir: string;
  let server: Server;
  let priorDataRoot: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'connect-live-socket-'));
    priorDataRoot = process.env.GOODVIBES_DATA_ROOT;
    process.env.GOODVIBES_DATA_ROOT = path.join(tmpDir, '.goodvibes');
    await fs.promises.mkdir(process.env.GOODVIBES_DATA_ROOT, { recursive: true });
    await fs.promises.writeFile(
      path.join(process.env.GOODVIBES_DATA_ROOT, 'config.json'),
      JSON.stringify({ mode: 'restricted' }),
      { mode: 0o600 }
    );
    resetConfigCache();
    globalRateLimiter.reset();
    globalRateLimiter.updateConfig({ per_domain: 2, delay_ms: 0 });
    setFetchImplementationForTests();
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    }
    globalRateLimiter.reset();
    globalRateLimiter.updateConfig({ per_domain: 2, delay_ms: 500 });
    setFetchImplementationForTests();
    resetConfigCache();
    if (priorDataRoot === undefined) {
      delete process.env.GOODVIBES_DATA_ROOT;
    } else {
      process.env.GOODVIBES_DATA_ROOT = priorDataRoot;
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('uses the matching undici fetch and pinned dispatcher against a real loopback socket', async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, path: request.url }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    await addService('loopback', {
      base_url: `http://127.0.0.1:${port}`,
      allow_private_network: true,
    });

    const result = await handleApiRequest({
      requests: [{ id: 'live', service: 'loopback', path: '/health', extract: 'json' }],
    });
    const envelope = JSON.parse((result.content[0] as { type: 'text'; text: string }).text) as {
      data: { results: { live: { status: number; body: unknown; error: string | null } } };
    };

    expect(envelope.data.results.live).toMatchObject({
      status: 200,
      body: { ok: true, path: '/health' },
      error: null,
    });
  });
});
