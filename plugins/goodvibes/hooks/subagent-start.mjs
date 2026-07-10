#!/usr/bin/env node

import { contextResponse, isDirectModule, runHook } from './lib/hook-io.mjs';
import { beginAgent, recordEvent } from './lib/event-sink.mjs';

const AUTHORITY_REMINDER =
  'GoodVibes: inherit the parent task scope and permission boundary; pass a canonical trusted base_path to filesystem MCP tools.';

export async function handleSubagentStart(input) {
  beginAgent(input);
  recordEvent('subagent_start', input);
  return contextResponse('SubagentStart', AUTHORITY_REMINDER);
}

if (isDirectModule(import.meta.url)) {
  await runHook('SubagentStart', handleSubagentStart);
}
