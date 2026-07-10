#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { contextResponse, denyPreToolUse, isDirectModule, runHook } from './lib/hook-io.mjs';
import { hookDataRoot, readJson, workspaceKey, writeJsonAtomic } from './lib/data-root.mjs';
import { recordEvent } from './lib/event-sink.mjs';

export const PROTECTED_FILES = ['goodvibes.secrets.json', 'goodvibes.cookies.json'];
const WARNING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function analyzeCommitCommand(command) {
  const value = String(command || '');
  const isAdd = /\bgit\s+(?:-[^\s]+\s+)*?(?:add|stage)\b/i.test(value);
  const isCommit = /\bgit\s+(?:-[^\s]+\s+)*?commit\b/i.test(value);
  if (!isAdd && !isCommit) return { isGit: false, scan: 'none', explicitHits: [] };
  const explicitHits = PROTECTED_FILES.filter(name => value.includes(name));
  const broadAdd = isAdd && /(?:^|\s)(?:-A|--all|-u|--update|\.|\*)(?:\s|$)/i.test(value);
  return {
    isGit: true,
    scan: isCommit ? 'staged' : broadAdd ? 'all' : 'none',
    explicitHits,
  };
}

export function scanStatusForProtected(porcelain, { stagedOnly = false } = {}) {
  const hits = new Set();
  for (const line of String(porcelain || '').split('\n')) {
    if (line.length < 4) continue;
    const index = line[0];
    if (stagedOnly && (index === ' ' || index === '?')) continue;
    const rawPath = line.slice(3).trim().split(' -> ').pop();
    if (!rawPath) continue;
    const name = basename(rawPath.replace(/^"|"$/g, ''));
    if (PROTECTED_FILES.includes(name)) hits.add(name);
  }
  return [...hits];
}

export function decideCommitGuard({ hits, alreadyWarned }) {
  if (!hits.length) return { action: 'allow' };
  const files = hits.join(', ');
  if (!alreadyWarned) {
    return {
      action: 'warn',
      message:
        `This Git command can include ${files}, which contains GoodVibes credentials. ` +
        'It will continue this time; remove the file from the operation. Repeating the risky command within 24 hours will be denied.',
    };
  }
  return {
    action: 'deny',
    message: `Blocked a repeated Git command that can include GoodVibes credential file(s): ${files}. Unstage or exclude them before retrying.`,
  };
}

function markerFile(cwd) {
  return join(hookDataRoot(), 'commit-guard', `${workspaceKey(cwd)}.json`);
}

function wasRecentlyWarned(file) {
  if (!existsSync(file)) return false;
  const at = Date.parse(readJson(file, {}).warned_at);
  return Number.isFinite(at) && Date.now() - at <= WARNING_MAX_AGE_MS;
}

function gitStatus(cwd) {
  try {
    return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

export function evaluateCommit({ toolName, command, cwd, status = gitStatus }) {
  if (toolName !== 'Bash') return { action: 'allow' };
  const analysis = analyzeCommitCommand(command);
  if (!analysis.isGit) return { action: 'allow' };

  const hits = new Set(analysis.explicitHits);
  if (analysis.scan !== 'none') {
    for (const hit of scanStatusForProtected(status(cwd), {
      stagedOnly: analysis.scan === 'staged',
    })) {
      hits.add(hit);
    }
  }

  const marker = markerFile(cwd);
  const decision = decideCommitGuard({ hits: [...hits], alreadyWarned: wasRecentlyWarned(marker) });
  if (decision.action === 'warn') {
    writeJsonAtomic(marker, { warned_at: new Date().toISOString(), files: [...hits] });
  }
  return { ...decision, hits: [...hits] };
}

export async function handlePreToolUse(input) {
  const cwd = input.cwd || process.cwd();
  const decision = evaluateCommit({
    toolName: input.tool_name,
    command: input.tool_input?.command,
    cwd,
  });
  if (decision.action === 'allow') return undefined;

  recordEvent('commit_guard', input, {
    decision: decision.action,
    protected_files: decision.hits,
  });
  if (decision.action === 'deny') return denyPreToolUse(decision.message);
  return contextResponse('PreToolUse', decision.message, 'GoodVibes credential-file warning');
}

if (isDirectModule(import.meta.url)) {
  await runHook('PreToolUse', handlePreToolUse);
}
