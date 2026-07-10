import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRolloutFile, RolloutFileTooLargeError, scanSessions } from '../rollout.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))
  );
});

describe('Codex rollout parser', () => {
  it('keeps the latest cumulative token snapshot instead of summing snapshots', async () => {
    const session = await parseRolloutFile(join(FIXTURES, 'rollout-main.jsonl'));

    expect(session.id).toBe('session-main');
    expect(session.cwd).toBe('/workspace/demo');
    expect(session.cli_version).toBe('0.144.1');
    expect(session.models).toEqual(['gpt-5', 'gpt-5.1']);
    expect(session.turns).toBe(2);
    expect(session.usage).toEqual({
      input_tokens: 1300,
      cached_input_tokens: 400,
      output_tokens: 400,
      reasoning_output_tokens: 100,
      total_tokens: 1800,
    });
    expect(session.tool_calls).toEqual({ code_read: 1, web_search: 1 });
    expect(session.malformed_lines).toBe(1);
    expect(session.unknown_records).toBe(1);
  });

  it('retains no prompt, reasoning, tool-argument, or future-record payload text', async () => {
    const session = await parseRolloutFile(join(FIXTURES, 'rollout-main.jsonl'));
    const serialized = JSON.stringify(session);

    expect(serialized).not.toContain('SECRET_MESSAGE');
    expect(serialized).not.toContain('SECRET_TOOL_ARGUMENT');
    expect(serialized).not.toContain('SECRET_CUSTOM_TOOL_INPUT');
    expect(serialized).not.toContain('SECRET_FUTURE_PAYLOAD');
  });

  it('does not label an unknown-only future rollout as the supported v1 format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodvibes-rollout-future-'));
    temporaryRoots.push(root);
    const file = join(root, 'future.jsonl');
    await writeFile(
      file,
      `${Array.from({ length: 4 }, (_, index) =>
        JSON.stringify({
          timestamp: `2026-07-09T12:00:0${index}.000Z`,
          type: `future_record_${index}`,
          payload: { content: 'SECRET_FUTURE_CONTENT' },
        })
      ).join('\n')}\n`,
      'utf8'
    );

    const session = await parseRolloutFile(file);
    expect(session.format).toBe('codex-rollout-unknown');
    expect(session.unknown_records).toBe(4);
    expect(JSON.stringify(session)).not.toContain('SECRET_FUTURE_CONTENT');
  });

  it('recognizes Codex parent/subagent metadata without reading message content', async () => {
    const session = await parseRolloutFile(join(FIXTURES, 'rollout-subagent.jsonl'));

    expect(session.id).toBe('session-subagent');
    expect(session.root_session_id).toBe('session-main');
    expect(session.source).toBe('subagent:thread_spawn');
    expect(session.parent_thread_id).toBe('session-main');
    expect(session.agent_nickname).toBe('scout');
    expect(session.agent_path).toBe('/root/scout');
    expect(session.usage.total_tokens).toBe(1400);
  });

  it('discovers nested JSONL files, sorts by rollout timestamp, and reports scan bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodvibes-rollout-scan-'));
    temporaryRoots.push(root);
    const sessionsDir = join(root, 'sessions', '2026', '07', '09');
    await mkdir(sessionsDir, { recursive: true });
    await cp(join(FIXTURES, 'rollout-main.jsonl'), join(sessionsDir, 'main.jsonl'));
    await cp(join(FIXTURES, 'rollout-subagent.jsonl'), join(sessionsDir, 'subagent.jsonl'));
    await cp(join(FIXTURES, 'rollout-other-project.jsonl'), join(sessionsDir, 'other.jsonl'));

    const scan = await scanSessions(join(root, 'sessions'), {
      maxSessions: 2,
      maxFileBytes: 1024 * 1024,
      now: () => new Date('2026-07-09T13:00:00.000Z'),
    });

    expect(scan.discovered_files).toBe(3);
    expect(scan.scanned_files).toBe(2);
    expect(scan.truncated).toBe(true);
    expect(scan.issues.some(issue => issue.code === 'scan_limit')).toBe(true);
    expect(scan.sessions).toHaveLength(2);
  });

  it('subtracts copied parent token/tool prefixes without globally de-duplicating turn ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodvibes-rollout-attribution-'));
    temporaryRoots.push(root);
    const sessionsDir = join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await cp(join(FIXTURES, 'rollout-main.jsonl'), join(sessionsDir, 'main.jsonl'));
    await cp(join(FIXTURES, 'rollout-subagent.jsonl'), join(sessionsDir, 'subagent.jsonl'));

    const scan = await scanSessions(sessionsDir, {
      maxSessions: 10,
      maxFileBytes: 1024 * 1024,
      now: () => new Date('2026-07-09T13:00:00.000Z'),
    });
    const child = scan.sessions.find(session => session.id === 'session-subagent');

    expect(child?.usage.total_tokens).toBe(1400);
    expect(child?.attributed_usage.total_tokens).toBe(400);
    expect(child?.attribution).toBe('parent-prefix-subtracted');
    expect(child?.attributed_tool_calls).toEqual({ code_grep: 1 });
    expect(child?.attributed_turns).toBe(1);
  });

  it('marks a nonzero inherited baseline unattributed when its parent was not scanned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodvibes-rollout-unattributed-'));
    temporaryRoots.push(root);
    const sessionsDir = join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, 'orphan-child.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-07-09T12:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'orphan-child',
            session_id: 'missing-root',
            parent_thread_id: 'missing-parent',
            cwd: '/workspace/demo',
            cli_version: '0.144.1',
            source: { subagent: { thread_spawn: { parent_thread_id: 'missing-parent' } } },
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-09T12:01:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 500,
                cached_input_tokens: 100,
                output_tokens: 100,
                reasoning_output_tokens: 20,
                total_tokens: 600,
              },
              last_token_usage: {
                input_tokens: 300,
                cached_input_tokens: 50,
                output_tokens: 100,
                reasoning_output_tokens: 20,
                total_tokens: 400,
              },
            },
          },
        }),
        '',
      ].join('\n'),
      'utf8'
    );

    const scan = await scanSessions(sessionsDir, {
      maxSessions: 10,
      maxFileBytes: 1024 * 1024,
    });
    expect(scan.sessions[0]?.attribution).toBe('unattributed');
    expect(scan.sessions[0]?.attributed_usage.total_tokens).toBe(0);
  });

  it('rejects a rollout before reading when it exceeds the configured file bound', async () => {
    await expect(
      parseRolloutFile(join(FIXTURES, 'rollout-main.jsonl'), { maxFileBytes: 16 })
    ).rejects.toBeInstanceOf(RolloutFileTooLargeError);
  });
});
