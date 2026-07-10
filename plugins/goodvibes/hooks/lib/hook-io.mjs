import { pathToFileURL } from 'node:url';

const JSON_REQUIRED_EVENTS = new Set(['SubagentStop', 'Stop']);
const CONTEXT_EVENTS = new Set(['SessionStart', 'SubagentStart', 'PreToolUse']);

export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function contextResponse(eventName, additionalContext, systemMessage) {
  if (!CONTEXT_EVENTS.has(eventName)) {
    throw new Error(`${eventName} does not accept hook-specific additional context.`);
  }
  const response = {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  };
  if (systemMessage) response.systemMessage = systemMessage;
  return response;
}

export function denyPreToolUse(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

export async function runHook(eventName, handler) {
  try {
    const input = await readHookInput();
    const response = await handler(input);
    if (response !== undefined && response !== null) {
      writeJson(response);
    } else if (JSON_REQUIRED_EVENTS.has(eventName)) {
      writeJson({});
    }
  } catch {
    if (JSON_REQUIRED_EVENTS.has(eventName)) writeJson({});
  }
}

export function isDirectModule(metaUrl) {
  return Boolean(process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href);
}
