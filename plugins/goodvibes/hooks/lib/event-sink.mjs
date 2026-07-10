import { appendFileSync, chmodSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ensurePrivateDir,
  hookDataRoot,
  readJson,
  workspaceKey,
  writeJsonAtomic,
} from './data-root.mjs';

function boundedString(value, max = 256) {
  return typeof value === 'string' && value ? value.slice(0, max) : undefined;
}

function eventFile(at = new Date()) {
  const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  return path.join(hookDataRoot(), 'events', `${month}.jsonl`);
}

export function messageMetadata(value) {
  if (typeof value !== 'string' || value.length === 0) return {};
  return {
    last_message_chars: value.length,
    last_message_sha256: createHash('sha256').update(value).digest('hex'),
  };
}

export function recordEvent(eventName, input = {}, details = {}) {
  try {
    const now = new Date();
    const entry = {
      schema_version: 1,
      event: eventName,
      at: now.toISOString(),
      workspace_key: workspaceKey(input.cwd || process.cwd()),
      session_id: boundedString(input.session_id),
      turn_id: boundedString(input.turn_id),
      source: boundedString(input.source, 32),
      trigger: boundedString(input.trigger, 32),
      permission_mode: boundedString(input.permission_mode, 32),
      agent_id: boundedString(input.agent_id),
      agent_type: boundedString(input.agent_type, 64),
      stop_hook_active:
        typeof input.stop_hook_active === 'boolean' ? input.stop_hook_active : undefined,
      ...details,
    };
    for (const key of Object.keys(entry)) {
      if (entry[key] === undefined) delete entry[key];
    }
    const file = eventFile(now);
    ensurePrivateDir(path.dirname(file));
    appendFileSync(file, `${JSON.stringify(entry)}\n`, {
      encoding: 'utf8',
      flag: 'a',
      mode: 0o600,
    });
    try {
      chmodSync(file, 0o600);
    } catch {
      // Best effort on platforms without POSIX modes.
    }
    return entry;
  } catch {
    return null;
  }
}

function trackingFile(agentId) {
  const key = createHash('sha256')
    .update(String(agentId || 'unknown'))
    .digest('hex');
  return path.join(hookDataRoot(), 'agents', `${key}.json`);
}

export function beginAgent(input) {
  if (!input.agent_id) return false;
  return writeJsonAtomic(trackingFile(input.agent_id), {
    agent_id: boundedString(input.agent_id),
    agent_type: boundedString(input.agent_type, 64),
    session_id: boundedString(input.session_id),
    turn_id: boundedString(input.turn_id),
    started_at: new Date().toISOString(),
  });
}

export function finishAgent(input) {
  if (!input.agent_id) return {};
  const file = trackingFile(input.agent_id);
  const tracking = readJson(file, null);
  try {
    unlinkSync(file);
  } catch {
    // Missing or already consumed tracking is harmless.
  }
  if (!tracking?.started_at) return {};
  const started = Date.parse(tracking.started_at);
  return {
    started_at: tracking.started_at,
    duration_ms: Number.isFinite(started) ? Math.max(0, Date.now() - started) : undefined,
  };
}
