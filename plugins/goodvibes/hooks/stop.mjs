#!/usr/bin/env node

import { isDirectModule, runHook } from './lib/hook-io.mjs';
import { messageMetadata, recordEvent } from './lib/event-sink.mjs';

export async function handleStop(input) {
  recordEvent('stop', input, messageMetadata(input.last_assistant_message));
  return {};
}

if (isDirectModule(import.meta.url)) {
  await runHook('Stop', handleStop);
}
