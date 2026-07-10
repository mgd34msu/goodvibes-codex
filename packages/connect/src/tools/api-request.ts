/**
 * `api_request` — the HTTP half of the v1 precision-fetch split (§4.4.4).
 *
 * REBUILT (not straight-ported): the page-reading stack retired (WebFetch won),
 * so this is a lean, honest HTTP client under the connect trust boundary. The
 * §1.8 fixes are wired in:
 *  - per-entry error isolation: one malformed spec fails only its own entry;
 *  - no automatic credential refresh or login network path exists;
 *  - response capping via the shared token budget;
 *  - honest extract names — json | text | headers | status, nothing called
 *    "summary";
 *  - a `mode: restricted|open` envelope stamp and a redaction pass that strips
 *    known secret values from echoed responses.
 *  - F8 lesson: a body carrying BOTH plain and base64 forms is accepted (base64
 *    preferred with a warning), never rejected.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  successEnvelope,
  toCallToolResult,
  startTimer,
  estimatePayloadTokens,
  utf8SafeSlice,
  type Envelope,
} from '@goodvibes/core/envelope';
import { loadConfig } from '@goodvibes/core/config';
import { withBudget } from '@goodvibes/core/proc';
import { buildRequest, type RequestBody, type RequestSpec } from '../fetch/request-builder.js';
import { rateLimitedFetch } from '../fetch/rate-limiter.js';
import { applyAuth } from '../fetch/auth/auth-orchestrator.js';
import { getFetchServices } from '../fetch/service-registry.js';
import { getAllowlist } from '../fetch/service-registry.js';
import { pinHttpDestination } from '../fetch/network-policy.js';
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from 'undici';
import {
  originOf,
  isDestinationAllowed,
  isMethodAllowed,
  isCredentialAttachAllowed,
  collectSecretValues,
  redactValue,
  type TrustMode,
} from '../trust.js';

/** Honest extract modes — each named for exactly what it returns. */
export type ExtractMode = 'json' | 'text' | 'headers' | 'status';

/** Body forms accepted for a request entry. */
export interface BodySpec {
  type: 'json' | 'form' | 'text' | 'multipart';
  data: Record<string, unknown> | string;
}

/** A single request entry in the batch. */
export interface RequestEntry {
  /** Result key. Falls back to the entry's array index when omitted. */
  id?: string;
  /** Registered service name (credentials pin to its origin). */
  service?: string;
  /** Path relative to the service base_url. */
  path?: string;
  /** Absolute URL for an unregistered target (allowlist applies). */
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  /** Structured body ({ type, data }). */
  body?: BodySpec;
  /** Legacy plain string body (F8 alternate of body_base64). */
  body_plain?: string;
  /** Base64 body (F8 alternate; preferred when both are present). */
  body_base64?: string;
  timeout_ms?: number;
  extract?: ExtractMode;
}

/** The input to `api_request`. */
export interface ApiRequestInput {
  requests: RequestEntry[];
  output?: { max_tokens?: number };
}

/** A single per-entry result. */
interface RequestOutcome {
  status: number | null;
  resolved_url: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  truncated: boolean;
  error: string | null;
  /** Advisory (e.g. the F8 both-body-forms notice). */
  warning?: string;
}

/** The tool descriptor (schema deferred by the client). */
export const apiRequestTool = {
  name: 'api_request',
  description:
    'Make one or more HTTP requests under the connect trust boundary. Credentials ' +
    'attach only to their registered service origin; unregistered destinations are ' +
    'gated by a default-on allowlist; write methods require a per-service opt-in. ' +
    'Results are keyed per entry with error isolation; extract is json | text | ' +
    'headers | status.',
  inputSchema: {
    type: 'object',
    properties: {
      requests: {
        type: 'array',
        description: 'The batch of requests. Each result is keyed by id (or array index).',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Result key (defaults to the array index).' },
            service: { type: 'string', description: 'Registered service name.' },
            path: { type: 'string', description: 'Path relative to the service base_url.' },
            url: { type: 'string', description: 'Absolute URL for an unregistered target.' },
            method: { type: 'string', description: 'HTTP method (default GET).' },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            params: { type: 'object', description: 'Query parameters.' },
            body: {
              type: 'object',
              description: 'Structured body.',
              properties: {
                type: { type: 'string', enum: ['json', 'form', 'text', 'multipart'] },
                data: {},
              },
              required: ['type', 'data'],
            },
            body_plain: { type: 'string', description: 'Plain body (alternate of body_base64).' },
            body_base64: {
              type: 'string',
              description: 'Base64 body (alternate of body_plain; preferred when both present).',
            },
            timeout_ms: { type: 'number' },
            extract: { type: 'string', enum: ['json', 'text', 'headers', 'status'] },
          },
        },
      },
      output: {
        type: 'object',
        properties: { max_tokens: { type: 'number' } },
      },
    },
    required: ['requests'],
  },
} as const;

interface TimedResponse {
  response: UndiciResponse;
  finish(): Promise<void>;
}

/** Fetch one validated/pinned hop with its own wall-clock deadline. */
async function fetchWithTimeout(
  url: string,
  options: UndiciRequestInit,
  timeoutMs: number,
  allowPrivateNetwork: boolean
): Promise<TimedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let pinned: Awaited<ReturnType<typeof pinHttpDestination>> | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () =>
          reject(
            Object.assign(new Error(`Request timed out after ${timeoutMs}ms`), {
              name: 'AbortError',
            })
          ),
        { once: true }
      );
    });
    const pendingPin = pinHttpDestination(url, allowPrivateNetwork);
    try {
      pinned = await Promise.race([pendingPin, aborted]);
    } catch (error) {
      // DNS itself is not abortable. If it finishes after the deadline, close
      // the newly-created dispatcher instead of leaking it into the MCP process.
      void pendingPin.then(late => late.close()).catch(() => {});
      throw error;
    }
    const response = await rateLimitedFetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'manual',
      dispatcher: pinned.dispatcher,
    });
    let finished = false;
    return {
      response,
      finish: async () => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        await pinned?.close();
      },
    };
  } catch (error) {
    clearTimeout(timer);
    await pinned?.close().catch(() => {});
    throw error;
  }
}

/** Map a request entry to the internal RequestSpec (F8 body handling). */
function toRequestSpec(entry: RequestEntry): { spec: RequestSpec; warning?: string } {
  const spec: RequestSpec = {
    url: entry.url ?? entry.path ?? '',
    method: entry.method,
    headers: entry.headers,
    params: entry.params,
    service: entry.service,
    timeout_ms: entry.timeout_ms,
  };

  let warning: string | undefined;

  // F8 lesson: plain and encoded body forms are mutually-exclusive alternates,
  // not a required-plus-escape-hatch pair. Accept both; prefer base64, warn.
  const hasPlain = typeof entry.body_plain === 'string';
  const hasBase64 = typeof entry.body_base64 === 'string';
  if (hasPlain && hasBase64) {
    spec.body_base64 = entry.body_base64;
    warning =
      'Both body_plain and body_base64 were provided; using body_base64 (the two are ' +
      'mutually-exclusive alternates).';
  } else if (hasBase64) {
    spec.body_base64 = entry.body_base64;
  } else if (hasPlain) {
    spec.body = entry.body_plain;
  }

  if (entry.body) {
    // Structured body wins over the legacy plain/base64 fields.
    spec.body_type = entry.body.type === 'text' ? 'raw' : entry.body.type;
    spec.body_data = entry.body.data;
    spec.body_base64 = undefined;
    spec.body = undefined;
  }

  return { spec, warning };
}

/** Extract the response into the honest requested representation. */
async function extractResponse(
  response: UndiciResponse,
  extract: ExtractMode,
  maxBytes: number
): Promise<{ body?: unknown; headers?: Record<string, string>; truncated: boolean }> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  switch (extract) {
    case 'status':
      await response.body?.cancel().catch(() => {});
      return { truncated: false };
    case 'headers':
      await response.body?.cancel().catch(() => {});
      return { headers, truncated: false };
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  if (reader) {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        const remaining = maxBytes - total;
        if (remaining <= 0) {
          truncated = true;
          await reader.cancel();
          break;
        }
        if (next.value.byteLength > remaining) {
          chunks.push(next.value.subarray(0, remaining));
          total += remaining;
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(next.value);
        total += next.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));

  switch (extract) {
    case 'text':
      return { body: text, truncated };
    case 'json':
    default: {
      try {
        return { body: JSON.parse(text) as unknown, truncated };
      } catch {
        return {
          body: {
            _parse_error: truncated
              ? `Response exceeded the ${maxBytes}-byte limit; returning the retained prefix.`
              : 'Response was not valid JSON; returning raw text.',
            text,
          },
          truncated,
        };
      }
    }
  }
}

type ServiceSnapshot = ReturnType<typeof getFetchServices>;

interface HttpPolicySnapshot {
  services: ServiceSnapshot;
  allowlist: string[];
}

const SENSITIVE_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'proxy-authorization',
  'proxy-authenticate',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function policyServiceForUrl(
  url: string,
  policy: HttpPolicySnapshot
): ServiceSnapshot[string] | undefined {
  const origin = originOf(url);
  if (!origin) {
    return undefined;
  }
  return Object.values(policy.services).find(service => originOf(service.base_url) === origin);
}

function joinWarning(...values: Array<string | undefined>): string | undefined {
  const messages = values.filter((value): value is string => !!value);
  return messages.length > 0 ? messages.join(' ') : undefined;
}

function bodyBytes(body: RequestBody | undefined): number {
  if (body === undefined || body === null) {
    return 0;
  }
  if (typeof body === 'string') {
    return Buffer.byteLength(body);
  }
  if (body instanceof Uint8Array) {
    return body.byteLength;
  }
  return Number.POSITIVE_INFINITY;
}

function stripCrossOriginHeaders(
  headers: Record<string, string>,
  secrets: string[]
): Record<string, string> {
  const safe = new Set(['accept', 'accept-language', 'user-agent']);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!safe.has(name.toLowerCase())) {
      continue;
    }
    if (secrets.some(secret => secret && value.includes(secret))) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

function collectAppliedCredentialValues(
  headers: Record<string, string>,
  secrets: Set<string>
): void {
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      lower === 'authorization' ||
      lower === 'cookie' ||
      lower.includes('api-key') ||
      lower.includes('token')
    ) {
      if (value.length >= 4) {
        secrets.add(value);
      }
      const space = value.indexOf(' ');
      if (space >= 0 && value.slice(space + 1).length >= 4) {
        secrets.add(value.slice(space + 1));
      }
    }
  }
}

/** Run one entry with full error isolation. Never throws. */
async function runEntry(
  entry: RequestEntry,
  mode: TrustMode,
  policy: HttpPolicySnapshot,
  hardTimeoutMs: number,
  maxResponseBytes: number
): Promise<RequestOutcome> {
  const { spec, warning } = toRequestSpec(entry);

  if (entry.service && (entry.url !== undefined || !entry.path)) {
    return {
      status: null,
      resolved_url: null,
      truncated: false,
      error: 'A registered-service request must use `service` plus a relative `path`, not `url`.',
      warning,
    };
  }
  if (entry.service && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(entry.path ?? '')) {
    return {
      status: null,
      resolved_url: null,
      truncated: false,
      error: 'A registered-service `path` must be relative so credentials cannot cross origins.',
      warning,
    };
  }
  if (entry.service && !policy.services[entry.service]) {
    return {
      status: null,
      resolved_url: null,
      truncated: false,
      error: `Service "${entry.service}" is not registered.`,
      warning,
    };
  }
  if ('auth' in (entry as object)) {
    return {
      status: null,
      resolved_url: null,
      truncated: false,
      error:
        'Per-request authentication is not accepted. Configure an opaque service credential through the control utility.',
      warning,
    };
  }
  for (const name of Object.keys(entry.headers ?? {})) {
    const normalized = name.toLowerCase();
    if (
      SENSITIVE_REQUEST_HEADERS.has(normalized) ||
      normalized.includes('api-key') ||
      normalized.includes('apikey') ||
      normalized.includes('auth-token') ||
      normalized.includes('access-token') ||
      normalized.includes('secret')
    ) {
      return {
        status: null,
        resolved_url: null,
        truncated: false,
        error: `Request header '${name}' is control-plane managed and cannot be supplied in an MCP call.`,
        warning,
      };
    }
  }

  if (!spec.url) {
    return {
      status: null,
      resolved_url: null,
      truncated: false,
      error: 'Each request needs a service+path or an absolute url.',
    };
  }

  let built;
  try {
    built = await buildRequest(spec);
  } catch (e) {
    return {
      status: null,
      resolved_url: null,
      truncated: false,
      error: e instanceof Error ? e.message : String(e),
      warning,
    };
  }

  const finalUrl = built.url;
  let method = built.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    return {
      status: null,
      resolved_url: finalUrl,
      truncated: false,
      error: `Invalid HTTP method '${built.method}'.`,
      warning,
    };
  }
  if (bodyBytes(built.body) > 4 * 1024 * 1024) {
    return {
      status: null,
      resolved_url: finalUrl,
      truncated: false,
      error: 'Request body exceeds the 4 MiB limit.',
      warning,
    };
  }

  const registeredOrigins = Object.values(policy.services)
    .map(s => originOf(s.base_url))
    .filter((o): o is string => o !== null);
  if (built.service && !isCredentialAttachAllowed(finalUrl, built.service.config.base_url)) {
    return {
      status: null,
      resolved_url: finalUrl,
      truncated: false,
      error: 'The resolved service URL left its registered origin.',
      warning,
    };
  }

  if (!Number.isFinite(built.timeout_ms) || built.timeout_ms <= 0) {
    return {
      status: null,
      resolved_url: finalUrl,
      truncated: false,
      error: '`timeout_ms` must be a positive number.',
      warning,
    };
  }
  const timeoutMs = Math.min(Math.floor(built.timeout_ms), hardTimeoutMs);
  const extract = entry.extract ?? 'json';
  const redactionSecrets = new Set(collectSecretValues(built.service?.auth));
  let currentUrl = finalUrl;
  let currentBody = built.body;
  let hops = 0;

  try {
    for (;;) {
      const destination = isDestinationAllowed(currentUrl, {
        mode,
        registeredOrigins,
        allowlist: policy.allowlist,
      });
      if (!destination.allowed) {
        return {
          status: null,
          resolved_url: currentUrl,
          truncated: false,
          error: destination.reason ?? 'Destination denied.',
          warning,
        };
      }

      const targetService = policyServiceForUrl(currentUrl, policy);
      const methodDecision = isMethodAllowed(method, {
        mode,
        hasService: !!targetService,
        writeMethods: targetService?.write_methods,
      });
      if (!methodDecision.allowed) {
        return {
          status: null,
          resolved_url: currentUrl,
          truncated: false,
          error: methodDecision.reason ?? 'Method denied.',
          warning,
        };
      }

      const sameCredentialOrigin =
        !!built.service && isCredentialAttachAllowed(currentUrl, built.service.config.base_url);
      const expectedAuthType = built.service?.config.auth_type;
      const headers = sameCredentialOrigin
        ? { ...built.headers }
        : stripCrossOriginHeaders(built.headers, [...redactionSecrets]);
      if (sameCredentialOrigin && expectedAuthType && expectedAuthType !== 'none') {
        if (new URL(currentUrl).protocol !== 'https:') {
          return {
            status: null,
            resolved_url: currentUrl,
            truncated: false,
            error: `Registered credentials for service '${built.service!.name}' require HTTPS.`,
            warning,
          };
        }
        try {
          const applied = await applyAuth(
            headers,
            currentUrl,
            built.service!.name,
            built.service!.config.base_url,
            expectedAuthType
          );
          if (!applied) {
            return {
              status: null,
              resolved_url: currentUrl,
              truncated: false,
              error: `Registered credentials for service '${built.service!.name}' are unavailable.`,
              warning,
            };
          }
        } catch {
          return {
            status: null,
            resolved_url: currentUrl,
            truncated: false,
            error: `Registered credentials for service '${built.service!.name}' could not be read safely.`,
            warning,
          };
        }
      }
      collectAppliedCredentialValues(headers, redactionSecrets);

      const options: UndiciRequestInit = { method, headers };
      if (method !== 'GET' && method !== 'HEAD' && currentBody !== undefined) {
        options.body = currentBody as UndiciRequestInit['body'];
      }

      const timed = await fetchWithTimeout(
        currentUrl,
        options,
        timeoutMs,
        targetService?.allow_private_network === true
      );
      const response = timed.response;

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        await timed.finish();
        if (!location) {
          return {
            status: response.status,
            resolved_url: currentUrl,
            truncated: false,
            error: 'Redirect response omitted Location.',
            warning,
          };
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          return {
            status: response.status,
            resolved_url: currentUrl,
            truncated: false,
            error: 'Redirects for write requests are not permitted.',
            warning,
          };
        }
        if (hops++ >= 5) {
          return {
            status: response.status,
            resolved_url: currentUrl,
            truncated: false,
            error: 'Redirect limit exceeded.',
            warning,
          };
        }
        currentUrl = new URL(location, currentUrl).toString();
        if (response.status === 303) {
          method = 'GET';
          currentBody = undefined;
        }
        continue;
      }

      try {
        const extracted = await extractResponse(response, extract, maxResponseBytes);
        const secrets = [...redactionSecrets];
        const body =
          extracted.body !== undefined ? redactValue(extracted.body, secrets) : undefined;
        const responseHeaders = extracted.headers
          ? (redactValue(extracted.headers, secrets) as Record<string, string>)
          : undefined;
        return {
          status: response.status,
          resolved_url: currentUrl,
          ...(body !== undefined ? { body } : {}),
          ...(responseHeaders ? { headers: responseHeaders } : {}),
          truncated: extracted.truncated,
          error: response.ok ? null : `HTTP ${response.status} ${response.statusText}`.trim(),
          warning: joinWarning(
            warning,
            extracted.truncated ? `Response was capped at ${maxResponseBytes} bytes.` : undefined
          ),
        };
      } finally {
        await timed.finish();
      }
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const isTimeout = err.name === 'AbortError';
    return {
      status: null,
      resolved_url: currentUrl,
      truncated: false,
      error: isTimeout ? `Request timed out after ${timeoutMs}ms` : err.message,
      warning,
    };
  }
}

/**
 * Trim result bodies until the rendered envelope fits `maxTokens`. Over-budget
 * bodies collapse to a (truncated) string form with the entry's `truncated`
 * flag set; within-budget bodies keep their natural shape.
 */
function capToBudget(
  results: Record<string, RequestOutcome>,
  mode: TrustMode,
  maxTokens: number
): { truncated: boolean } {
  const render = (): number => estimatePayloadTokens(JSON.stringify({ mode, results }));

  if (render() <= maxTokens) {
    return { truncated: false };
  }

  let trimmedAny = false;
  for (let i = 0; i < 64; i++) {
    const est = render();
    if (est <= maxTokens) {
      break;
    }

    // Pick the entry whose serialized body is largest.
    let pickKey: string | null = null;
    let pickLen = 0;
    for (const [key, r] of Object.entries(results)) {
      if (r.body === undefined) {
        continue;
      }
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      if (text.length > pickLen) {
        pickLen = text.length;
        pickKey = key;
      }
    }
    if (pickKey === null || pickLen === 0) {
      break;
    }

    const r = results[pickKey];
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const over = est - maxTokens;
    const cutChars = Math.max(Math.ceil(over * 3.5), 16);
    const newLen = Math.max(0, text.length - cutChars);
    r.body = utf8SafeSlice(text, newLen);
    r.truncated = true;
    trimmedAny = true;
  }

  return { truncated: trimmedAny };
}

/** Execute the `api_request` batch and return an MCP result. */
export async function handleApiRequest(args: unknown): Promise<CallToolResult> {
  const elapsed = startTimer();
  const cfg = loadConfig();
  const mode = cfg.mode;
  const input = (args ?? {}) as Partial<ApiRequestInput>;

  if (!input.requests || !Array.isArray(input.requests) || input.requests.length === 0) {
    const env: Envelope = {
      success: false,
      error: 'api_request requires a non-empty `requests` array.',
      meta: { token_estimate: 0, mode, execution_ms: elapsed() },
    };
    return toCallToolResult(env);
  }

  const entries = input.requests;
  const maxTokens = input.output?.max_tokens ?? cfg.max_tokens_default;
  if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 100_000) {
    return toCallToolResult({
      success: false,
      error: '`output.max_tokens` must be an integer from 64 through 100000.',
      meta: { token_estimate: 0, mode, execution_ms: elapsed() },
    });
  }
  if (entries.length > 50) {
    return toCallToolResult({
      success: false,
      error: 'api_request accepts at most 50 entries per batch.',
      meta: { token_estimate: 0, mode, execution_ms: elapsed() },
    });
  }
  const keys = entries.map((entry, index) => entry.id ?? String(index));
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate !== undefined) {
    return toCallToolResult({
      success: false,
      error: `Duplicate request id '${duplicate}' is not permitted.`,
      meta: { token_estimate: 0, mode, execution_ms: elapsed() },
    });
  }

  // Snapshot authority once for the batch. The next tool call reads the files
  // again, so revocation takes effect without a server restart.
  const policy: HttpPolicySnapshot = {
    services: structuredClone(getFetchServices()),
    allowlist: [...getAllowlist()],
  };
  const maxResponseBytes = Math.min(4 * 1024 * 1024, Math.max(4096, maxTokens * 4));
  const budgetMs = cfg.budgets.http_max_ms + 5000;

  const outcome = await withBudget(budgetMs, async () => {
    // Each entry is isolated: a rejection in one cannot fail the batch.
    const settled = await Promise.all(
      entries.map(
        entry =>
          runEntry(entry, mode, policy, cfg.budgets.http_max_ms, maxResponseBytes).catch(e => ({
            status: null,
            resolved_url: null,
            truncated: false,
            error: e instanceof Error ? e.message : String(e),
          })) as Promise<RequestOutcome>
      )
    );
    const results: Record<string, RequestOutcome> = {};
    settled.forEach((res, i) => {
      const key = entries[i].id ?? String(i);
      results[key] = res;
    });
    return results;
  });

  const results = outcome.value;
  const cap = capToBudget(results, mode, maxTokens);

  const env = successEnvelope(
    { mode, results },
    {
      mode,
      execution_ms: elapsed(),
      budget_exceeded: outcome.budget_exceeded || undefined,
      truncated: cap.truncated || undefined,
      effective_caps: cap.truncated ? { max_tokens: maxTokens } : undefined,
    }
  );
  return toCallToolResult(env);
}
