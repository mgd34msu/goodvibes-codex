import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPathTrusted,
  assertPathWithinSelectedRoot,
  isPathWithin,
  loadTrustedRoots,
  resolveTrustedBase,
} from '../workspace/index.js';

const prior = { ...process.env };

afterEach(() => {
  process.env = { ...prior };
});

describe('Codex trusted workspace boundary', () => {
  it('loads canonical roots and rejects an unregistered sibling', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-roots-'));
    const trusted = path.join(parent, 'trusted');
    const sibling = path.join(parent, 'sibling');
    fs.mkdirSync(trusted);
    fs.mkdirSync(sibling);
    process.env.GOODVIBES_TRUSTED_ROOTS = JSON.stringify([trusted]);
    process.env.GOODVIBES_ENFORCE_TRUSTED_ROOTS = '1';

    expect(loadTrustedRoots()).toEqual([fs.realpathSync(trusted)]);
    expect(resolveTrustedBase(trusted)).toBe(fs.realpathSync(trusted));
    expect(() => assertPathTrusted(path.join(trusted, 'new.ts'))).not.toThrow();
    expect(() => assertPathTrusted(path.join(sibling, 'secret.ts'))).toThrow(
      /outside every trusted/i
    );
  });

  it('does not confuse a sibling prefix with a child', () => {
    expect(isPathWithin('/repo/project-x/file', '/repo/project')).toBe(false);
    expect(isPathWithin('/repo/project/file', '/repo/project')).toBe(true);
  });

  it('rejects a symlink escape', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-symlink-'));
    const trusted = path.join(parent, 'trusted');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(trusted);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(trusted, 'escape'));
    process.env.GOODVIBES_TRUSTED_ROOTS = JSON.stringify([trusted]);
    process.env.GOODVIBES_ENFORCE_TRUSTED_ROOTS = '1';
    expect(() => assertPathTrusted(path.join(trusted, 'escape', 'file.ts'))).toThrow(
      /outside every trusted/i
    );
  });

  it('binds a request to its selected root even when a sibling root is also trusted', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-selected-root-'));
    const selected = path.join(parent, 'selected');
    const otherTrusted = path.join(parent, 'other');
    fs.mkdirSync(selected);
    fs.mkdirSync(otherTrusted);
    process.env.GOODVIBES_TRUSTED_ROOTS = JSON.stringify([selected, otherTrusted]);
    process.env.GOODVIBES_ENFORCE_TRUSTED_ROOTS = '1';

    expect(() =>
      assertPathWithinSelectedRoot(path.join(selected, 'new.ts'), selected)
    ).not.toThrow();
    expect(() =>
      assertPathWithinSelectedRoot(path.join(otherTrusted, 'secret.ts'), selected)
    ).toThrow(/escapes the selected workspace root/i);
  });

  it.runIf(process.platform !== 'win32')(
    'refuses symlinked and broadly readable authority files',
    () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-authority-'));
      const trusted = path.join(parent, 'trusted');
      fs.mkdirSync(trusted);
      const actual = path.join(parent, 'actual.json');
      fs.writeFileSync(actual, JSON.stringify({ version: 1, roots: [trusted] }), { mode: 0o600 });
      const authority = path.join(parent, 'roots.json');
      fs.symlinkSync(actual, authority);
      delete process.env.GOODVIBES_TRUSTED_ROOTS;
      process.env.GOODVIBES_TRUSTED_ROOTS_FILE = authority;
      expect(loadTrustedRoots()).toEqual([]);

      fs.unlinkSync(authority);
      fs.copyFileSync(actual, authority);
      fs.chmodSync(authority, 0o644);
      expect(loadTrustedRoots()).toEqual([]);
      fs.chmodSync(authority, 0o600);
      expect(loadTrustedRoots()).toEqual([fs.realpathSync(trusted)]);
    }
  );
});
