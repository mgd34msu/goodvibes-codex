/** Apply only user-registered, origin-pinned static service credentials. */

import { getServiceSecrets, type ServiceAuth } from '../secrets-store.js';
import { applyStaticAuth } from './static-auth.js';

export type AuthStatus = 'valid' | 'no_credentials' | 'no_auth_configured';

type StaticAuthType = Exclude<ServiceAuth['type'], 'none'>;

function origin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isUsableBinding(
  auth: ServiceAuth | undefined,
  requestUrl: string,
  serviceBaseUrl: string,
  expectedType: ServiceAuth['type'] | undefined
): auth is ServiceAuth {
  if (!auth || !expectedType || expectedType === 'none') {
    return false;
  }
  const requestOrigin = origin(requestUrl);
  const serviceOrigin = origin(serviceBaseUrl);
  return (
    requestOrigin !== null &&
    serviceOrigin !== null &&
    requestOrigin === serviceOrigin &&
    new URL(requestUrl).protocol === 'https:' &&
    auth.service_origin === serviceOrigin &&
    auth.type === (expectedType as StaticAuthType)
  );
}

/**
 * Apply a stored credential for a named service. Callers are responsible for
 * validating that `url` matches the registered service origin before invoking
 * this function. There is no per-request auth, cookie jar, browser flow, or
 * automatic network refresh path.
 */
export async function applyAuth(
  headers: Record<string, string>,
  url: string,
  serviceName?: string,
  serviceBaseUrl?: string,
  expectedType?: ServiceAuth['type']
): Promise<boolean> {
  if (!serviceName || !serviceBaseUrl) {
    return false;
  }
  const auth = await getServiceSecrets(serviceName);
  return isUsableBinding(auth, url, serviceBaseUrl, expectedType)
    ? applyStaticAuth(headers, auth)
    : false;
}

/** Report credential presence without returning any value. */
export async function getAuthStatus(
  serviceName: string,
  serviceBaseUrl: string,
  expectedType?: ServiceAuth['type']
): Promise<AuthStatus> {
  try {
    const auth = await getServiceSecrets(serviceName);
    if (!auth) {
      return 'no_auth_configured';
    }
    if (!isUsableBinding(auth, serviceBaseUrl, serviceBaseUrl, expectedType)) {
      return 'no_credentials';
    }
    switch (auth.type) {
      case 'bearer':
        return auth.token ? 'valid' : 'no_credentials';
      case 'basic':
        return auth.username && auth.password ? 'valid' : 'no_credentials';
      case 'api-key':
        return auth.header && auth.key ? 'valid' : 'no_credentials';
      case 'none':
        return 'valid';
    }
  } catch {
    return 'no_auth_configured';
  }
}
