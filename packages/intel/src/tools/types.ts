/**
 * Shared tool-registration shape for the goodvibes-intel server.
 *
 * One module per tool under `src/tools/` exports a `ToolDefinition`, and
 * `src/index.ts` registers it in the public MCP inventory.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

/** A single registered tool: its MCP schema plus the handler that serves it. */
export interface ToolDefinition {
  /** The MCP `tools/list` entry (name, description, inputSchema). */
  definition: Tool;
  /** Serves a `tools/call` for this tool. Never throws — errors become an error envelope. */
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}
