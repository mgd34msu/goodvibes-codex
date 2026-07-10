import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { applyAuth, getAuthStatus } from '../../fetch/auth/auth-orchestrator.js';

vi.mock('../../fetch/auth/static-auth.js', () => ({ applyStaticAuth: vi.fn() }));
vi.mock('../../fetch/secrets-store.js', () => ({ getServiceSecrets: vi.fn() }));

import { applyStaticAuth } from '../../fetch/auth/static-auth.js';
import { getServiceSecrets } from '../../fetch/secrets-store.js';

describe('static service auth orchestrator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing without an explicitly named service', async () => {
    const headers: Record<string, string> = {};
    expect(await applyAuth(headers, 'https://api.example.test')).toBe(false);
    expect(getServiceSecrets).not.toHaveBeenCalled();
  });

  it('applies only the stored service credential', async () => {
    const auth = {
      type: 'bearer' as const,
      token: 'registered-token',
      service_origin: 'https://api.example.test',
    };
    (getServiceSecrets as Mock).mockResolvedValue(auth);
    (applyStaticAuth as Mock).mockImplementation((headers: Record<string, string>) => {
      headers.Authorization = 'Bearer registered-token';
      return true;
    });
    const headers: Record<string, string> = {};
    expect(
      await applyAuth(
        headers,
        'https://api.example.test/v1',
        'demo',
        'https://api.example.test',
        'bearer'
      )
    ).toBe(true);
    expect(applyStaticAuth).toHaveBeenCalledWith(headers, auth);
    expect(headers.Authorization).toBe('Bearer registered-token');
  });

  it('reports credential presence without exposing a value', async () => {
    (getServiceSecrets as Mock).mockResolvedValue({
      type: 'api-key',
      header: 'X-API-Key',
      key: 'secret',
      service_origin: 'https://api.example.test',
    });
    expect(await getAuthStatus('demo', 'https://api.example.test', 'api-key')).toBe('valid');
    (getServiceSecrets as Mock).mockResolvedValue({
      type: 'api-key',
      header: 'X-API-Key',
      service_origin: 'https://api.example.test',
    });
    expect(await getAuthStatus('demo', 'https://api.example.test', 'api-key')).toBe(
      'no_credentials'
    );
    (getServiceSecrets as Mock).mockResolvedValue(undefined);
    expect(await getAuthStatus('demo', 'https://api.example.test', 'api-key')).toBe(
      'no_auth_configured'
    );
  });

  it.each([
    [{ type: 'bearer', token: 'stale' }, 'https://api.example.test', 'bearer'],
    [
      { type: 'bearer', token: 'stale', service_origin: 'https://old.example.test' },
      'https://api.example.test',
      'bearer',
    ],
    [
      {
        type: 'api-key',
        header: 'X-Key',
        key: 'stale',
        service_origin: 'https://api.example.test',
      },
      'https://api.example.test',
      'bearer',
    ],
  ] as const)(
    'refuses an unbound, wrong-origin, or wrong-type credential',
    async (auth, baseUrl, type) => {
      (getServiceSecrets as Mock).mockResolvedValue(auth);
      expect(await applyAuth({}, `${baseUrl}/v1`, 'demo', baseUrl, type)).toBe(false);
      expect(applyStaticAuth).not.toHaveBeenCalled();
    }
  );

  it('refuses to send a correctly bound static credential over HTTP', async () => {
    (getServiceSecrets as Mock).mockResolvedValue({
      type: 'bearer',
      token: 'secret',
      service_origin: 'http://api.example.test',
    });
    expect(
      await applyAuth({}, 'http://api.example.test/v1', 'demo', 'http://api.example.test', 'bearer')
    ).toBe(false);
    expect(applyStaticAuth).not.toHaveBeenCalled();
  });

  it('fails closed when the secret store cannot be read', async () => {
    (getServiceSecrets as Mock).mockRejectedValue(new Error('unsafe permissions'));
    await expect(
      applyAuth({}, 'https://api.example.test', 'demo', 'https://api.example.test', 'bearer')
    ).rejects.toThrow('unsafe permissions');
    expect(await getAuthStatus('demo', 'https://api.example.test', 'bearer')).toBe(
      'no_auth_configured'
    );
  });
});
