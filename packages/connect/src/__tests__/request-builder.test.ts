/**
 * Ported from v1 precision-engine `__tests__/utils/request-builder.test.ts`
 * (assertions intact; import paths + v2 persistence). This is one of the two
 * fetch assembly suite retained for the Codex data plane.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as builder from '../fetch/request-builder.js';
import * as registry from '../fetch/service-registry.js';

describe('request-builder', () => {
  let tmpDir: string;
  const originalDataRoot = process.env.GOODVIBES_DATA_ROOT;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'request-builder-test-'));
    process.env.GOODVIBES_DATA_ROOT = path.join(tmpDir, '.goodvibes');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalDataRoot === undefined) {
      delete process.env.GOODVIBES_DATA_ROOT;
    } else {
      process.env.GOODVIBES_DATA_ROOT = originalDataRoot;
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe('buildRequestUrl', () => {
    it('should return absolute URL as-is', () => {
      expect(builder.buildRequestUrl({ url: 'https://example.com/api' })).toBe(
        'https://example.com/api'
      );
    });

    it('should append query params', () => {
      const url = builder.buildRequestUrl({
        url: 'https://example.com/search',
        params: { q: 'test', page: 1, active: true },
      });
      expect(url).toContain('q=test');
      expect(url).toContain('page=1');
      expect(url).toContain('active=true');
    });

    it('should override existing query params', () => {
      const url = builder.buildRequestUrl({
        url: 'https://example.com/search?q=old',
        params: { q: 'new' },
      });
      expect(url).toContain('q=new');
      expect(url).not.toContain('q=old');
    });
  });

  describe('buildRequestBody', () => {
    it('should encode JSON body', () => {
      const [body, contentType] = builder.buildRequestBody({
        url: 'https://example.com',
        body_type: 'json',
        body_data: { key: 'value', num: 42 },
      });
      expect(body).toBe('{"key":"value","num":42}');
      expect(contentType).toBe('application/json');
    });

    it('should encode form body', () => {
      const [body, contentType] = builder.buildRequestBody({
        url: 'https://example.com',
        body_type: 'form',
        body_data: { username: 'admin', password: 'secret' },
      });
      expect(body).toContain('username=admin');
      expect(body).toContain('password=secret');
      expect(contentType).toBe('application/x-www-form-urlencoded');
    });

    it('should handle multipart body', () => {
      const [body, contentType] = builder.buildRequestBody({
        url: 'https://example.com',
        body_type: 'multipart',
        body_data: { field1: 'value1' },
      });
      expect(body).toContain('field1');
      expect(body).toContain('value1');
      expect(contentType).toContain('multipart/form-data');
    });

    it('should pass raw body through', () => {
      const [body, contentType] = builder.buildRequestBody({
        url: 'https://example.com',
        body_type: 'raw',
        body_data: 'raw content here',
      });
      expect(body).toBe('raw content here');
      expect(contentType).toBeUndefined();
    });

    it('should default to json when body_data provided without body_type', () => {
      const [, contentType] = builder.buildRequestBody({
        url: 'https://example.com',
        body_data: { key: 'value' },
      });
      expect(contentType).toBe('application/json');
    });

    it('should handle legacy body_base64', () => {
      const [body] = builder.buildRequestBody({
        url: 'https://example.com',
        body_base64: Buffer.from('hello').toString('base64'),
      });
      expect(Buffer.from(body as Uint8Array).toString('utf8')).toBe('hello');
    });

    it('should handle legacy body string', () => {
      const [body] = builder.buildRequestBody({ url: 'https://example.com', body: 'raw body' });
      expect(body).toBe('raw body');
    });

    it('should return undefined for no body', () => {
      const [body, contentType] = builder.buildRequestBody({ url: 'https://example.com' });
      expect(body).toBeUndefined();
      expect(contentType).toBeUndefined();
    });
  });

  describe('buildRequestHeaders', () => {
    it('should set auto content-type', () => {
      const headers = builder.buildRequestHeaders(
        { url: 'https://example.com' },
        undefined,
        'application/json'
      );
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should not override existing content-type', () => {
      const headers = builder.buildRequestHeaders(
        { url: 'https://example.com', headers: { 'Content-Type': 'text/xml' } },
        undefined,
        'application/json'
      );
      expect(headers['Content-Type']).toBe('text/xml');
    });
  });

  describe('buildRequest', () => {
    it('should build a basic request', async () => {
      const built = await builder.buildRequest({
        url: 'https://example.com/api',
        method: 'POST',
        body_data: { test: true },
      });
      expect(built.url).toBe('https://example.com/api');
      expect(built.method).toBe('POST');
      expect(built.body).toBe('{"test":true}');
      expect(built.headers['Content-Type']).toBe('application/json');
    });

    it('should resolve service and use its timeout', async () => {
      await registry.addService('fast-api', {
        base_url: 'https://fast.example.com',
        timeout_ms: 5000,
      });
      const built = await builder.buildRequest({
        url: 'https://fast.example.com/test',
        service: 'fast-api',
      });
      expect(built.timeout_ms).toBe(5000);
      expect(built.service).toBeDefined();
      expect(built.service!.name).toBe('fast-api');
    });
  });

  describe('string body_data with body_type', () => {
    it('should handle string body_data with body_type: json', () => {
      const [body, contentType] = builder.buildRequestBody({
        url: 'https://example.com',
        body_type: 'json',
        body_data: '{"already":"json"}',
      });
      expect(body).toBe('{"already":"json"}');
      expect(contentType).toBe('application/json');
    });

    it('should handle string body_data with body_type: form', () => {
      const [body, contentType] = builder.buildRequestBody({
        url: 'https://example.com',
        body_type: 'form',
        body_data: 'key=value&another=test',
      });
      expect(body).toBe('key=value&another=test');
      expect(contentType).toBe('application/x-www-form-urlencoded');
    });
  });

  describe('multipart boundary validation', () => {
    it('should generate valid multipart boundary format', () => {
      const [, contentType] = builder.buildRequestBody({
        url: 'https://example.com',
        body_type: 'multipart',
        body_data: { field: 'value' },
      });
      expect(contentType).toMatch(/^multipart\/form-data; boundary=----/);
      const boundary = contentType!.split('boundary=')[1];
      expect(boundary).toMatch(/^----[a-zA-Z0-9]+$/);
    });
  });

  describe('URL with params edge cases', () => {
    it('should handle invalid/malformed URL with params gracefully', () => {
      expect(() => builder.buildRequestUrl({ url: 'not-a-url', params: { q: 'test' } })).toThrow();
    });
  });

  describe('buildRequest defaults', () => {
    it('should default to GET method when not specified', async () => {
      const built = await builder.buildRequest({ url: 'https://example.com/api' });
      expect(built.method).toBe('GET');
    });
  });
});
