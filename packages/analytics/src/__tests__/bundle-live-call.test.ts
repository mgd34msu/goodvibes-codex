/** Bundle-level gate for the committed Codex analytics server over stdio. */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const BUNDLE = path.join(REPO, 'plugins', 'goodvibes', 'server', 'analytics', 'index.cjs');

describe('analytics bundle — real tool call over stdio', () => {
  it.skipIf(!existsSync(BUNDLE))(
    'answers a token query from a clean Codex home and remains alive',
    async () => {
      const stateDir = mkdtempSync(path.join(tmpdir(), 'gv-bundle-test-'));
      // The child must NOT inherit VITEST: the bundle's entry guard skips
      // main() under it, and the server would silently never start.
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        CODEX_HOME: path.join(stateDir, 'codex'),
        GOODVIBES_ANALYTICS_HOME: path.join(stateDir, 'analytics'),
      };
      delete childEnv.VITEST;
      const child = spawn('node', [BUNDLE], {
        cwd: stateDir,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      try {
        const responses = new Map<number, unknown>();
        let buffer = '';
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let idx: number;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) {
              continue;
            }
            try {
              const msg = JSON.parse(line) as { id?: number };
              if (typeof msg.id === 'number') {
                responses.set(msg.id, msg);
              }
            } catch {
              /* non-JSON noise is not this test's concern */
            }
          }
        });

        const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + '\n');
        const waitFor = (id: number, ms: number) =>
          new Promise<unknown>((resolve, reject) => {
            const started = Date.now();
            const poll = setInterval(() => {
              if (responses.has(id)) {
                clearInterval(poll);
                resolve(responses.get(id));
              } else if (Date.now() - started > ms) {
                clearInterval(poll);
                reject(new Error(`no response for id ${id} within ${ms}ms`));
              }
            }, 50);
            poll.unref?.();
          });

        send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'bundle-test', version: '0.0.0' },
          },
        });
        await waitFor(1, 10_000);
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });

        send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'query', arguments: { scope: 'tokens' } },
        });
        const reply = (await waitFor(2, 20_000)) as {
          result?: { content?: Array<{ text?: string }> };
          error?: { message?: string };
        };

        // A clean home yields a bounded, successful empty token result.
        const text = JSON.stringify(reply);
        expect(text).not.toContain('sql-wasm.wasm');
        expect(text).not.toContain('.claude');
        const payload = JSON.parse(reply.result?.content?.[0]?.text ?? '{}') as {
          success?: boolean;
        };
        expect(payload.success).toBe(true);

        // Invariant 2: the server survived answering it.
        expect(child.exitCode).toBeNull();
        expect(() => process.kill(child.pid!, 0)).not.toThrow();
      } finally {
        child.kill('SIGTERM');
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
    30_000
  );
});
