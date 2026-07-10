#!/usr/bin/env node

import * as path from 'node:path';
import { isDirectModule, runHook } from './lib/hook-io.mjs';
import { hookDataRoot, workspaceKey, writeJsonAtomic } from './lib/data-root.mjs';
import { recordEvent } from './lib/event-sink.mjs';

export async function handlePreCompact(input) {
  const checkpoint = {
    schema_version: 1,
    session_id: typeof input.session_id === 'string' ? input.session_id : undefined,
    turn_id: typeof input.turn_id === 'string' ? input.turn_id : undefined,
    trigger: input.trigger === 'manual' ? 'manual' : 'auto',
    checkpointed_at: new Date().toISOString(),
  };
  writeJsonAtomic(
    path.join(hookDataRoot(), 'checkpoints', `${workspaceKey(input.cwd || process.cwd())}.json`),
    checkpoint
  );
  recordEvent('pre_compact', input, { trigger: checkpoint.trigger });
  return undefined;
}

if (isDirectModule(import.meta.url)) {
  await runHook('PreCompact', handlePreCompact);
}
