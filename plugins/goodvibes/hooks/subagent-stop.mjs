#!/usr/bin/env node

import { isDirectModule, runHook } from './lib/hook-io.mjs';
import { finishAgent, messageMetadata, recordEvent } from './lib/event-sink.mjs';

export async function handleSubagentStop(input) {
  recordEvent('subagent_stop', input, {
    ...finishAgent(input),
    ...messageMetadata(input.last_assistant_message),
  });
  return {};
}

if (isDirectModule(import.meta.url)) {
  await runHook('SubagentStop', handleSubagentStop);
}
