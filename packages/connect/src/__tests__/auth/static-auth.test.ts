/**
 * Ported verbatim (import path only) from v1 precision-engine
 * `__tests__/utils/auth/static-auth.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  applyBearerAuth,
  applyBasicAuth,
  applyApiKeyAuth,
  applyStaticAuth,
} from '../../fetch/auth/static-auth.js';

describe('static-auth', () => {
  describe('applyBearerAuth', () => {
    it('should set Authorization header with token', () => {
      const headers: Record<string, string> = {};
      expect(applyBearerAuth(headers, 'my-token')).toBe(true);
      expect(headers['Authorization']).toBe('Bearer my-token');
    });

    it('should refuse inherited env refs', () => {
      process.env.TEST_AUTH_TOKEN = 'env-token';
      try {
        const headers: Record<string, string> = {};
        expect(applyBearerAuth(headers, { $env: 'TEST_AUTH_TOKEN' })).toBe(false);
        expect(headers['Authorization']).toBeUndefined();
      } finally {
        delete process.env.TEST_AUTH_TOKEN;
      }
    });

    it('should return false for missing env var', () => {
      const headers: Record<string, string> = {};
      expect(applyBearerAuth(headers, { $env: 'NONEXISTENT_VAR_12345' })).toBe(false);
      expect(headers['Authorization']).toBeUndefined();
    });

    it('should reject whitespace-only token', () => {
      const headers: Record<string, string> = {};
      expect(applyBearerAuth(headers, '   ')).toBe(false);
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('applyBasicAuth', () => {
    it('should set Authorization header with base64 credentials', () => {
      const headers: Record<string, string> = {};
      expect(applyBasicAuth(headers, 'admin', 'secret')).toBe(true);
      expect(headers['Authorization']).toBe(
        'Basic ' + Buffer.from('admin:secret', 'utf-8').toString('base64')
      );
    });

    it('should return false if username missing', () => {
      const headers: Record<string, string> = {};
      expect(applyBasicAuth(headers, { $env: 'NOPE_12345' }, 'pass')).toBe(false);
    });

    it('should return false if password missing', () => {
      const headers: Record<string, string> = {};
      expect(applyBasicAuth(headers, 'user', { $env: 'NOPE_12345' })).toBe(false);
    });

    it('should reject whitespace-only credentials', () => {
      const headers: Record<string, string> = {};
      expect(applyBasicAuth(headers, 'user', '  \t  ')).toBe(false);
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('applyApiKeyAuth', () => {
    it('should set custom header with key', () => {
      const headers: Record<string, string> = {};
      expect(applyApiKeyAuth(headers, 'X-API-Key', 'key-123')).toBe(true);
      expect(headers['X-API-Key']).toBe('key-123');
    });

    it('should refuse inherited env refs', () => {
      process.env.TEST_API_KEY = 'env-key-456';
      try {
        const headers: Record<string, string> = {};
        expect(applyApiKeyAuth(headers, 'X-API-Key', { $env: 'TEST_API_KEY' })).toBe(false);
        expect(headers['X-API-Key']).toBeUndefined();
      } finally {
        delete process.env.TEST_API_KEY;
      }
    });

    it('should reject whitespace-only key', () => {
      const headers: Record<string, string> = {};
      expect(applyApiKeyAuth(headers, 'X-API-Key', '\t\t')).toBe(false);
      expect(headers['X-API-Key']).toBeUndefined();
    });
  });

  describe('applyStaticAuth', () => {
    it('should route bearer type', () => {
      const headers: Record<string, string> = {};
      expect(applyStaticAuth(headers, { type: 'bearer', token: 'tok' })).toBe(true);
      expect(headers['Authorization']).toBe('Bearer tok');
    });

    it('should route basic type', () => {
      const headers: Record<string, string> = {};
      expect(applyStaticAuth(headers, { type: 'basic', username: 'u', password: 'p' })).toBe(true);
      expect(headers['Authorization']).toContain('Basic');
    });

    it('should route api-key type', () => {
      const headers: Record<string, string> = {};
      expect(applyStaticAuth(headers, { type: 'api-key', header: 'X-Key', key: 'k' })).toBe(true);
      expect(headers['X-Key']).toBe('k');
    });

    it('should return true for none type', () => {
      const headers: Record<string, string> = {};
      expect(applyStaticAuth(headers, { type: 'none' })).toBe(true);
    });

    it('should return false for missing credentials', () => {
      const headers: Record<string, string> = {};
      expect(applyStaticAuth(headers, { type: 'bearer' })).toBe(false);
    });

    it('should return false for unknown auth type', () => {
      const headers: Record<string, string> = {};
      expect(applyStaticAuth(headers, { type: 'unsupported' as unknown as 'bearer' })).toBe(false);
    });
  });
});
