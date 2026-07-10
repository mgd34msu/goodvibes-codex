/**
 * connect request builder — assembles fetch-ready requests from a spec + service.
 *
 * Assembles URL/query parameters, bounded body encodings, and non-credential
 * headers. Per-request authentication is deliberately absent; the api_request
 * tool attaches an origin/type-bound stored credential only after policy checks.
 */

import {
  resolveService,
  buildServiceHeaders,
  resolveBaseUrl,
  type ResolvedService,
} from './service-resolver.js';

/** Spec for a single fetch request. */
export interface RequestSpec {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  body_base64?: string;
  params?: Record<string, string | number | boolean>;
  body_type?: 'json' | 'form' | 'multipart' | 'raw';
  body_data?: Record<string, unknown> | string;
  service?: string;
  timeout_ms?: number;
}

/** Body forms supported without lossy coercion. */
export type RequestBody = string | Uint8Array;

/** A built request ready for `fetch()`. */
export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: RequestBody;
  timeout_ms: number;
  service?: ResolvedService;
}

const DEFAULT_TIMEOUT = 30000;

/** Build the full URL, appending query params. */
export function buildRequestUrl(spec: RequestSpec, service?: ResolvedService): string {
  let url = resolveBaseUrl(service ?? undefined, spec.url);

  if (spec.params && Object.keys(spec.params).length > 0) {
    const urlObj = new URL(url);
    for (const [key, value] of Object.entries(spec.params)) {
      urlObj.searchParams.set(key, String(value));
    }
    url = urlObj.toString();
  }

  return url;
}

/**
 * Build the request body from `body_type`/`body_data` (or legacy fields).
 * @returns `[body, contentType]` or `[undefined, undefined]` when no body.
 */
export function buildRequestBody(spec: RequestSpec): [RequestBody | undefined, string | undefined] {
  if (spec.body_data !== undefined) {
    const bodyType = spec.body_type ?? 'json';

    switch (bodyType) {
      case 'json': {
        const jsonBody =
          typeof spec.body_data === 'string' ? spec.body_data : JSON.stringify(spec.body_data);
        return [jsonBody, 'application/json'];
      }
      case 'form': {
        if (typeof spec.body_data === 'string') {
          return [spec.body_data, 'application/x-www-form-urlencoded'];
        }
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(spec.body_data)) {
          params.set(key, String(value));
        }
        return [params.toString(), 'application/x-www-form-urlencoded'];
      }
      case 'multipart': {
        if (typeof spec.body_data === 'string') {
          return [spec.body_data, 'multipart/form-data'];
        }
        const boundary = `----GoodvibesConnect${Date.now()}`;
        const parts: string[] = [];
        for (const [key, value] of Object.entries(spec.body_data)) {
          parts.push(
            `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}`
          );
        }
        parts.push(`--${boundary}--`);
        return [parts.join('\r\n'), `multipart/form-data; boundary=${boundary}`];
      }
      case 'raw': {
        const rawBody =
          typeof spec.body_data === 'string' ? spec.body_data : JSON.stringify(spec.body_data);
        return [rawBody, undefined];
      }
      default:
        return [undefined, undefined];
    }
  }

  if (spec.body_base64) {
    // Preserve arbitrary bytes. Decoding through UTF-8 corrupts binary payloads.
    return [new Uint8Array(Buffer.from(spec.body_base64, 'base64')), undefined];
  }

  if (spec.body) {
    return [spec.body, undefined];
  }

  return [undefined, undefined];
}

/** Build headers merging service/global defaults, auto content-type, and auth. */
export function buildRequestHeaders(
  spec: RequestSpec,
  service?: ResolvedService,
  autoContentType?: string
): Record<string, string> {
  const headers = buildServiceHeaders(service, spec.headers);

  const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
  if (autoContentType && !hasContentType) {
    headers['Content-Type'] = autoContentType;
  }

  return headers;
}

/** Build a complete request from a spec + resolved service context. */
export async function buildRequest(spec: RequestSpec): Promise<BuiltRequest> {
  let service: ResolvedService | undefined;
  if (spec.service) {
    service = await resolveService(spec.service);
  }

  const url = buildRequestUrl(spec, service);
  const [body, autoContentType] = buildRequestBody(spec);
  const headers = buildRequestHeaders(spec, service, autoContentType);

  return {
    url,
    method: spec.method ?? 'GET',
    headers,
    body,
    timeout_ms: spec.timeout_ms ?? service?.config.timeout_ms ?? DEFAULT_TIMEOUT,
    service,
  };
}
