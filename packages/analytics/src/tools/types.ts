/**
 * Tool-module contract for the goodvibes-analytics server.
 *
 * Per R13 the MCP tool names drop the `analytics_` prefix (the server key is the
 * namespace): `query`, `dashboard`, `budget`, `export`, `tag`, `sync`, `config`.
 * Each module carries the external name, the engine's internal handler key,
 * a description, and the JSON input schema surfaced to the client. The active
 * Codex adapter validates untrusted input again at the handler boundary.
 */

export interface ToolModule {
  /** External MCP tool name, `analytics_` prefix dropped (R13). */
  name: string;
  /** The engine handler-registry key (keeps the `analytics_` prefix). */
  engineTool: string;
  /** One-line description surfaced in the tool list. */
  description: string;
  /** JSON Schema for the tool input; the runtime also validates untrusted values. */
  inputSchema: Record<string, unknown>;
}
