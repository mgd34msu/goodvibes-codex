import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAnalyticsEngine } from '../engine.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const NOW = new Date('2026-07-09T13:00:00.000Z');

let root: string;
let codexHome: string;
let analyticsHome: string;
let engine: CodexAnalyticsEngine;

function payload(response: CallToolResult): Record<string, unknown> {
  const block = response.content.find((item): item is TextContent => item.type === 'text');
  if (!block) {
    throw new Error('response has no text block');
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'goodvibes-codex-analytics-'));
  codexHome = join(root, '.codex');
  analyticsHome = join(codexHome, 'goodvibes', 'analytics');
  const sessionsDir = join(codexHome, 'sessions', '2026', '07', '09');
  await mkdir(sessionsDir, { recursive: true });
  await cp(join(FIXTURES, 'rollout-main.jsonl'), join(sessionsDir, 'main.jsonl'));
  await cp(join(FIXTURES, 'rollout-subagent.jsonl'), join(sessionsDir, 'subagent.jsonl'));
  await cp(join(FIXTURES, 'rollout-other-project.jsonl'), join(sessionsDir, 'other.jsonl'));
  engine = new CodexAnalyticsEngine({
    codexHome,
    analyticsHome,
    sessionId: 'session-main',
    now: () => new Date(NOW),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('CodexAnalyticsEngine queries', () => {
  it('aggregates token, project, tool, and subagent metadata across projects', async () => {
    const tokens = payload(
      await engine.handleToolCall('analytics_query', {
        scope: 'tokens',
        data_scope: 'all_projects',
      })
    );
    expect((tokens.usage as { total_tokens: number }).total_tokens).toBe(2800);

    const commands = payload(
      await engine.handleToolCall('analytics_query', {
        scope: 'commands',
        data_scope: 'all_projects',
      })
    );
    expect(commands.tool_calls).toEqual({
      code_grep: 1,
      code_read: 1,
      exec_command: 1,
      web_search: 1,
    });

    const projects = payload(
      await engine.handleToolCall('analytics_query', {
        scope: 'project',
        data_scope: 'all_projects',
      })
    );
    expect(projects.projects).toHaveLength(2);

    const agents = payload(
      await engine.handleToolCall('analytics_query', {
        mode: 'agents',
        data_scope: 'all_projects',
      })
    );
    expect(agents.sessions).toBe(1);
  });

  it('reports token counters, never monetary values, for cost compatibility modes', async () => {
    const live = payload(
      await engine.handleToolCall('analytics_query', {
        mode: 'live_cost',
        data_scope: 'all_projects',
      })
    );
    expect(live.mode).toBe('live_tokens');
    expect(live.monetary_costs_available).toBe(false);
    expect((live.usage as { total_tokens: number }).total_tokens).toBe(2800);

    const cost = payload(
      await engine.handleToolCall('analytics_query', {
        scope: 'cost',
        data_scope: 'all_projects',
      })
    );
    expect(cost.available).toBe(false);
    expect(JSON.stringify(cost)).not.toMatch(/\$[0-9]/);
  });

  it('rejects query arguments that the sanitized adapter cannot implement', async () => {
    const response = await engine.handleToolCall('analytics_query', {
      group_by: 'tool',
      format: 'verbose',
      filters: { status: 'success', agent: 'scout' },
    });
    expect(response.isError).toBe(true);
    expect(payload(response).unsupported_arguments).toEqual([
      'group_by',
      'format',
      'filters.status',
      'filters.agent',
    ]);
  });
});

describe('CodexAnalyticsEngine local state', () => {
  it('supports token budgets and explicitly rejects monetary budgets', async () => {
    const rejected = await engine.handleToolCall('analytics_budget', {
      action: 'set',
      unit: 'dollars',
      amount: 10,
    });
    expect(rejected.isError).toBe(true);

    const set = payload(
      await engine.handleToolCall('analytics_budget', {
        action: 'set',
        unit: 'tokens',
        amount: 2000,
        warn_at: [0.5, 0.8, 1],
      })
    );
    expect(set.unit).toBe('tokens');

    const checked = payload(await engine.handleToolCall('analytics_budget', { action: 'check' }));
    expect(checked.used).toBe(1800);
    expect(checked.remaining).toBe(200);
    expect(checked.percentage).toBe(0.9);
    expect(checked.reached_thresholds).toEqual([0.5, 0.8]);
  });

  it('persists tags without modifying rollout files', async () => {
    const rolloutBefore = await readFile(
      join(codexHome, 'sessions', '2026', '07', '09', 'main.jsonl'),
      'utf8'
    );
    await engine.handleToolCall('analytics_tag', { action: 'add', value: 'release' });
    const listed = payload(await engine.handleToolCall('analytics_tag', { action: 'list' }));
    expect(listed.tags).toEqual(['release']);

    const suggested = payload(await engine.handleToolCall('analytics_tag', { action: 'auto' }));
    expect(suggested.suggestions).toContain('project:demo');
    expect(
      await readFile(join(codexHome, 'sessions', '2026', '07', '09', 'main.jsonl'), 'utf8')
    ).toBe(rolloutBefore);
  });

  it('requires an exact session for budget and tag mutations without host session context', async () => {
    const unbound = new CodexAnalyticsEngine({
      codexHome,
      analyticsHome,
      sessionId: '',
      now: () => new Date(NOW),
    });

    const budgetWithoutSession = await unbound.handleToolCall('analytics_budget', {
      action: 'set',
      amount: 2000,
    });
    expect(budgetWithoutSession.isError).toBe(true);
    expect(String(payload(budgetWithoutSession).error)).toContain('explicit session_id');
    const clearWithoutSession = await unbound.handleToolCall('analytics_budget', {
      action: 'clear',
    });
    expect(clearWithoutSession.isError).toBe(true);

    const tagWithoutSession = await unbound.handleToolCall('analytics_tag', {
      action: 'add',
      value: 'release',
    });
    expect(tagWithoutSession.isError).toBe(true);
    expect(String(payload(tagWithoutSession).error)).toContain('explicit session_id');
    const removeWithoutSession = await unbound.handleToolCall('analytics_tag', {
      action: 'remove',
      value: 'release',
    });
    expect(removeWithoutSession.isError).toBe(true);

    const budget = payload(
      await unbound.handleToolCall('analytics_budget', {
        action: 'set',
        session_id: 'session-main',
        amount: 2000,
      })
    );
    expect(budget.session_id).toBe('session-main');

    const tag = payload(
      await unbound.handleToolCall('analytics_tag', {
        action: 'add',
        session_id: 'session-main',
        value: 'release',
      })
    );
    expect(tag.session_id).toBe('session-main');

    const unknown = await unbound.handleToolCall('analytics_tag', {
      action: 'remove',
      session_id: 'session-does-not-exist',
      value: 'release',
    });
    expect(unknown.isError).toBe(true);
    expect(String(payload(unknown).error)).toContain('session-does-not-exist');
  });

  it('exposes bounded plugin-local config as non-authoritative for Codex', async () => {
    const set = payload(
      await engine.handleToolCall('analytics_config', {
        action: 'set',
        key: 'max_sessions',
        value: 250,
      })
    );
    expect(set.authoritative_for_codex).toBe(false);
    expect(set.value).toBe(250);

    const get = payload(
      await engine.handleToolCall('analytics_config', {
        action: 'get',
        key: 'max_sessions',
      })
    );
    expect(get.value).toBe(250);
    expect(get.authoritative_for_codex).toBe(false);
  });
});

describe('CodexAnalyticsEngine bounded artifacts', () => {
  it('writes a sanitized sync index under the analytics home', async () => {
    const synced = payload(await engine.handleToolCall('analytics_sync', { scope: 'all' }));
    expect(synced.indexed_sessions).toBe(3);
    expect(isAbsolute(String(synced.index_path))).toBe(true);
    expect(String(synced.index_path).startsWith(analyticsHome)).toBe(true);

    const content = await readFile(String(synced.index_path), 'utf8');
    expect(content).not.toContain('SECRET_MESSAGE');
    expect(content).not.toContain('SECRET_TOOL_ARGUMENT');
    expect(content).not.toContain('Anthropic');
  });

  it('confines fixed-schema exports to the analytics directory', async () => {
    const exported = payload(
      await engine.handleToolCall('analytics_export', {
        format: 'json',
        scope: 'all_projects',
        output_path: 'nested/sessions.json',
      })
    );
    expect(String(exported.path).startsWith(join(analyticsHome, 'exports'))).toBe(true);
    expect(exported.monetary_costs_included).toBe(false);
    const content = await readFile(String(exported.path), 'utf8');
    expect(content).not.toContain('SECRET_MESSAGE');
    expect(content).not.toMatch(/\$[0-9]/);

    const escaped = await engine.handleToolCall('analytics_export', {
      format: 'json',
      output_path: '../escape.json',
    });
    expect(escaped.isError).toBe(true);

    const sections = await engine.handleToolCall('analytics_export', {
      format: 'json',
      sections: ['tokens'],
    });
    expect(sections.isError).toBe(true);
    expect(payload(sections).unsupported_arguments).toEqual(['sections']);
  });

  it('rejects an export whose existing parent is a symlink outside the export root', async () => {
    const exportsDir = join(analyticsHome, 'exports');
    const outside = join(root, 'outside');
    await mkdir(exportsDir, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(exportsDir, 'linked'), 'dir');

    const escaped = await engine.handleToolCall('analytics_export', {
      format: 'json',
      output_path: 'linked/escape.json',
    });
    expect(escaped.isError).toBe(true);
    await expect(readFile(join(outside, 'escape.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('writes a bounded self-contained report and exposes status/doctor', async () => {
    const report = payload(
      await engine.handleToolCall('analytics_dashboard', {
        action: 'report',
        scope: 'all_projects',
      })
    );
    expect(String(report.path).startsWith(join(analyticsHome, 'reports'))).toBe(true);
    expect(report.monetary_costs_included).toBe(false);
    const reportHtml = await readFile(String(report.path), 'utf8');
    expect(reportHtml).toContain('GoodVibes Codex analytics');
    expect(reportHtml).not.toContain('SECRET_MESSAGE');
    expect(reportHtml).not.toContain('Anthropic');

    const status = payload(
      await engine.handleToolCall('analytics_dashboard', { action: 'status' })
    );
    expect(status.source).toBe('CODEX_HOME/sessions');
    expect(status.current_session).toBeTruthy();

    const doctor = payload(
      await engine.handleToolCall('analytics_dashboard', { action: 'doctor' })
    );
    expect(doctor.adapter).toBe('codex-rollout-v1');
    expect(doctor.status).toBe('degraded');
    expect(doctor.degradation_reasons).toEqual(
      expect.arrayContaining(['parser:malformed_lines', 'parser:unknown_records'])
    );
    expect((doctor.rollout_compatibility as { unknown_records: number }).unknown_records).toBe(1);
    expect(doctor.local_config_authoritative_for_codex).toBe(false);
  });

  it('marks future-record-heavy rollouts visibly degraded in doctor output', async () => {
    const sessionsDir = join(codexHome, 'sessions', '2026', '07', '09');
    const records = Array.from({ length: 12 }, (_, index) => ({
      timestamp: `2026-07-09T12:30:${String(index + 1).padStart(2, '0')}.000Z`,
      type: `future_record_${index}`,
      payload: { type: 'unsupported-shape' },
    }));
    await writeFile(
      join(sessionsDir, 'future-heavy.jsonl'),
      `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
      'utf8'
    );

    const doctor = payload(
      await engine.handleToolCall('analytics_dashboard', { action: 'doctor' })
    );
    const compatibility = doctor.rollout_compatibility as {
      unknown_records: number;
      unknown_record_ratio: number;
      unknown_format_sessions: number;
    };
    expect(doctor.status).toBe('degraded');
    expect(doctor.degradation_reasons).toContain('parser:unknown_records');
    expect(compatibility.unknown_records).toBeGreaterThanOrEqual(13);
    expect(compatibility.unknown_record_ratio).toBeGreaterThan(0.25);
    expect(compatibility.unknown_format_sessions).toBeGreaterThanOrEqual(1);
  });

  it('reports ok when every scanned record uses the supported format', async () => {
    const sessionsRoot = join(codexHome, 'sessions');
    await rm(sessionsRoot, { recursive: true, force: true });
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(
      join(sessionsRoot, 'known.jsonl'),
      `${[
        {
          timestamp: '2026-07-09T12:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'known', session_id: 'known', cwd: '/workspace/known' },
        },
        {
          timestamp: '2026-07-09T12:00:01.000Z',
          type: 'turn_context',
          payload: { turn_id: 'turn-known', model: 'gpt-5' },
        },
      ]
        .map(record => JSON.stringify(record))
        .join('\n')}\n`,
      'utf8'
    );

    const doctor = payload(
      await engine.handleToolCall('analytics_dashboard', { action: 'doctor' })
    );
    expect(doctor.status).toBe('ok');
    expect(doctor.degradation_reasons).toEqual([]);
    expect(doctor.rollout_compatibility).toMatchObject({
      unknown_records: 0,
      unknown_record_ratio: 0,
      unknown_format_sessions: 0,
    });
  });
});
