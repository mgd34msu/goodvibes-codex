import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getRegistry, registryPath, saveRegistry } from '../fetch/registry-store.js';
import { loadSecrets, saveSecrets } from '../fetch/secrets-store.js';

describe('connect state-file hardening', () => {
  let tmpDir: string;
  let dataRoot: string;
  let originalDataRoot: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'connect-persistence-security-'));
    dataRoot = path.join(tmpDir, '.goodvibes');
    originalDataRoot = process.env.GOODVIBES_DATA_ROOT;
    process.env.GOODVIBES_DATA_ROOT = dataRoot;
    await fs.promises.mkdir(dataRoot, { recursive: true });
  });

  afterEach(async () => {
    if (originalDataRoot === undefined) {
      delete process.env.GOODVIBES_DATA_ROOT;
    } else {
      process.env.GOODVIBES_DATA_ROOT = originalDataRoot;
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'refuses to read an over-permissive registry file',
    async () => {
      await saveRegistry({ services: { demo: { base_url: 'https://api.demo.test' } } });
      await fs.promises.chmod(registryPath(), 0o644);

      expect(getRegistry()).toEqual({});
    }
  );

  it.skipIf(process.platform === 'win32')(
    'refuses to read an over-permissive secrets file',
    async () => {
      await saveSecrets({ services: { demo: { type: 'bearer', token: 'secret' } }, global: {} });
      const file = path.join(dataRoot, 'goodvibes.secrets.json');
      await fs.promises.chmod(file, 0o644);

      await expect(loadSecrets()).rejects.toThrow(/permissions broader than 0600/i);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a registry symlink without modifying its target',
    async () => {
      const victim = path.join(tmpDir, 'registry-victim.json');
      const original = '{"sentinel":"unchanged"}\n';
      await fs.promises.writeFile(victim, original, { mode: 0o600 });
      await fs.promises.symlink(victim, registryPath());

      expect(getRegistry()).toEqual({});
      await expect(saveRegistry({ services: {} })).rejects.toThrow(/unsafe registry path/i);
      expect(await fs.promises.readFile(victim, 'utf8')).toBe(original);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a secrets symlink without reading or modifying its target',
    async () => {
      const victim = path.join(tmpDir, 'secrets-victim.json');
      const original = JSON.stringify({
        services: { stolen: { type: 'bearer', token: 'do-not-read' } },
        global: {},
      });
      await fs.promises.writeFile(victim, original, { mode: 0o600 });
      const secretsPath = path.join(dataRoot, 'goodvibes.secrets.json');
      await fs.promises.symlink(victim, secretsPath);

      await expect(loadSecrets()).rejects.toThrow(/unsafe secrets path/i);
      await expect(saveSecrets({ services: {}, global: {} })).rejects.toThrow(
        /unsafe secrets path/i
      );
      expect(await fs.promises.readFile(victim, 'utf8')).toBe(original);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'writes both state files with owner-only permissions',
    async () => {
      await saveRegistry({ services: {} });
      await saveSecrets({ services: {}, global: {} });

      expect((await fs.promises.stat(registryPath())).mode & 0o777).toBe(0o600);
      expect(
        (await fs.promises.stat(path.join(dataRoot, 'goodvibes.secrets.json'))).mode & 0o777
      ).toBe(0o600);
    }
  );
});
