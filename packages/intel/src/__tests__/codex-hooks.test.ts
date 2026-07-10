import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '../../../../plugins/goodvibes');
const hooksRoot = path.join(pluginRoot, 'hooks');
const temporary: string[] = [];

function tempDir(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'goodvibes-codex-hook-'));
  temporary.push(value);
  return value;
}

function runHook(file: string, input: unknown, dataRoot = tempDir()): string {
  return execFileSync(process.execPath, [path.join(hooksRoot, file)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: path.join(dataRoot, 'hook-private'),
      GOODVIBES_DATA_ROOT: path.join(dataRoot, 'shared'),
    },
    timeout: 10_000,
  });
}

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Codex plugin hooks', () => {
  it('declares only the six supported events with portable plugin-root commands', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(hooksRoot, 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; commandWindows: string }> }>>;
    };
    expect(Object.keys(manifest.hooks).sort()).toEqual([
      'PreCompact',
      'PreToolUse',
      'SessionStart',
      'Stop',
      'SubagentStart',
      'SubagentStop',
    ]);
    for (const registrations of Object.values(manifest.hooks)) {
      for (const registration of registrations) {
        for (const hook of registration.hooks) {
          expect(hook.command).toContain('$PLUGIN_ROOT');
          expect(hook.commandWindows).toContain('%PLUGIN_ROOT%');
        }
      }
    }
  });

  it('keeps safe lifecycle paths silent except for events that require JSON', () => {
    const cwd = tempDir();
    expect(
      runHook('commit-guard.mjs', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        cwd,
      })
    ).toBe('');
    expect(runHook('pre-compact.mjs', { hook_event_name: 'PreCompact', cwd })).toBe('');
    expect(JSON.parse(runHook('stop.mjs', { hook_event_name: 'Stop', cwd }))).toEqual({});
    expect(
      JSON.parse(runHook('subagent-stop.mjs', { hook_event_name: 'SubagentStop', cwd }))
    ).toEqual({});
  });

  it('returns Codex hook-specific context for a starting subagent', () => {
    const parsed = JSON.parse(
      runHook('subagent-start.mjs', {
        hook_event_name: 'SubagentStart',
        cwd: tempDir(),
        agent_id: 'agent-test',
      })
    ) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SubagentStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('permission boundary');
  });

  it('resets non-persistent global open mode before MCP servers read it', () => {
    const root = tempDir();
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(
      path.join(shared, 'config.json'),
      JSON.stringify({ mode: 'open', dangerously_persist_across_sessions: false }),
      { mode: 0o600 }
    );
    const output = runHook(
      'session-start.mjs',
      {
        hook_event_name: 'SessionStart',
        cwd: tempDir(),
      },
      root
    );
    const response = JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } };
    expect(response.hookSpecificOutput.additionalContext).toContain('reset to restricted');
    const config = JSON.parse(fs.readFileSync(path.join(shared, 'config.json'), 'utf8')) as {
      mode: string;
      dangerously_persist_across_sessions: boolean;
    };
    expect(config).toMatchObject({
      mode: 'restricted',
      dangerously_persist_across_sessions: false,
    });
  });
});
