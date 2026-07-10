import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { handler as grepHandler } from '../tools/code_grep.js';
import { handler as globHandler } from '../tools/code_glob.js';
import { scaffoldTool } from '../tools/scaffold.js';
import { handler as dbSchemaHandler } from '../tools/db_schema.js';
import { handler as apiRoutesHandler } from '../tools/api_routes.js';
import { CompilerHost, detectEntryPoints } from '../host/index.js';

const priorEnv = { ...process.env };
const temporaryParents: string[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

function workspace(): { parent: string; root: string; sibling: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-intel-boundary-'));
  const root = path.join(parent, 'selected');
  const sibling = path.join(parent, 'sibling');
  fs.mkdirSync(root);
  fs.mkdirSync(sibling);
  temporaryParents.push(parent);
  process.env.GOODVIBES_TRUSTED_ROOTS = JSON.stringify([root]);
  process.env.GOODVIBES_ENFORCE_TRUSTED_ROOTS = '1';
  process.env.GOODVIBES_PLUGIN_ROOT = path.join(repoRoot, 'plugins', 'goodvibes');
  return { parent, root, sibling };
}

function responseText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find(item => item.type === 'text')?.text ?? '';
}

afterEach(() => {
  process.env = { ...priorEnv };
  for (const parent of temporaryParents.splice(0)) {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

describe('selected-workspace containment regressions', () => {
  it('rejects code_grep query.path traversal into a sibling workspace', async () => {
    const { root, sibling } = workspace();
    fs.writeFileSync(path.join(sibling, 'secret.txt'), 'BOUNDARY_SECRET');

    const result = await grepHandler({
      base_path: root,
      queries: [{ id: 'escape', pattern: 'BOUNDARY_SECRET', path: '../sibling/secret.txt' }],
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toMatch(/escapes the selected workspace root/i);
    expect(responseText(result)).not.toContain('BOUNDARY_SECRET');
  });

  it('rejects code_glob parent-segment patterns before listing', async () => {
    const { root, sibling } = workspace();
    fs.writeFileSync(path.join(sibling, 'secret.txt'), 'BOUNDARY_SECRET');

    const result = await globHandler({
      base_path: root,
      patterns: ['../sibling/secret.txt'],
      backend: 'fast-glob',
      output: { mode: 'with_preview' },
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toMatch(/may not escape/i);
    expect(responseText(result)).not.toContain('BOUNDARY_SECRET');
  });

  it.runIf(process.platform !== 'win32')('rejects code_glob symlink-follow escapes', async () => {
    const { root, sibling } = workspace();
    fs.writeFileSync(path.join(sibling, 'secret.txt'), 'BOUNDARY_SECRET');
    fs.symlinkSync(sibling, path.join(root, 'escape'));

    const result = await globHandler({
      base_path: root,
      patterns: ['escape/*.txt'],
      backend: 'fast-glob',
      follow_symlinks: true,
      output: { mode: 'with_preview' },
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toMatch(/escapes the selected workspace root/i);
    expect(responseText(result)).not.toContain('BOUNDARY_SECRET');
  });

  it('rejects scaffold template path traversal', async () => {
    const { root } = workspace();
    const result = await scaffoldTool.handler({
      template: '../../minimal/vite-react',
      output_dir: 'app',
      base_path: root,
      dry_run: true,
    });
    expect(result.isError).toBe(true);
    expect(responseText(result)).toMatch(/invalid template id/i);
  });

  it.runIf(process.platform !== 'win32')(
    'refuses to overwrite a scaffold destination symlink',
    async () => {
      const { root, sibling } = workspace();
      const output = path.join(root, 'app');
      const secret = path.join(sibling, 'secret.txt');
      fs.mkdirSync(output);
      fs.writeFileSync(secret, 'DO_NOT_OVERWRITE');
      fs.symlinkSync(secret, path.join(output, 'package.json'));

      const result = await scaffoldTool.handler({
        template: 'vite-react',
        output_dir: 'app',
        base_path: root,
        dry_run: false,
      });

      expect(result.isError).toBe(true);
      expect(fs.readFileSync(secret, 'utf8')).toBe('DO_NOT_OVERWRITE');
    }
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a conventional database schema symlink escape',
    async () => {
      const { root, sibling } = workspace();
      fs.mkdirSync(path.join(root, 'prisma'));
      const secretSchema = path.join(sibling, 'schema.prisma');
      fs.writeFileSync(secretSchema, 'model Secret { id Int @id }');
      fs.symlinkSync(secretSchema, path.join(root, 'prisma', 'schema.prisma'));

      const result = await dbSchemaHandler({ base_path: root, source: 'prisma' });
      expect(result.isError).toBe(true);
      expect(responseText(result)).toMatch(/escapes the selected workspace root/i);
      expect(responseText(result)).not.toContain('Secret');
    }
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a discovered API route symlink escape',
    async () => {
      const { root, sibling } = workspace();
      fs.mkdirSync(path.join(root, 'src'));
      const secretRoute = path.join(sibling, 'routes.ts');
      fs.writeFileSync(secretRoute, "app.get('/secret', handler);");
      fs.symlinkSync(secretRoute, path.join(root, 'src', 'routes.ts'));

      const result = await apiRoutesHandler({ base_path: root, framework: 'express' });
      expect(result.isError).toBe(true);
      expect(responseText(result)).toMatch(/escapes the selected workspace root/i);
      expect(responseText(result)).not.toContain('/secret');
    }
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a framework package.json symlink escape',
    async () => {
      const { root, sibling } = workspace();
      const outsidePackage = path.join(sibling, 'package.json');
      fs.writeFileSync(outsidePackage, JSON.stringify({ dependencies: { express: '1.0.0' } }));
      fs.symlinkSync(outsidePackage, path.join(root, 'package.json'));

      const result = await apiRoutesHandler({ base_path: root, framework: 'auto' });
      expect(result.isError).toBe(true);
      expect(responseText(result)).toMatch(/escapes the selected workspace root/i);
    }
  );
});

describe('TypeScript analysis-root containment', () => {
  it('rejects relative imports that leave the selected analysis root', () => {
    const { root, sibling } = workspace();
    const sourceDir = path.join(root, 'src');
    fs.mkdirSync(sourceDir);
    const source = path.join(sourceDir, 'index.ts');
    fs.writeFileSync(source, "import { secret } from '../../sibling/secret'; export { secret };");
    fs.writeFileSync(path.join(sibling, 'secret.ts'), "export const secret = 'BOUNDARY_SECRET';");

    const host = new CompilerHost();
    expect(() => host.getServiceForFile(source, root)).toThrow(/TypeScript import.*escapes/i);
    host.dispose();
  });

  it('rejects an escaping import in a transitively loaded source file', () => {
    const { root, sibling } = workspace();
    const sourceDir = path.join(root, 'src');
    fs.mkdirSync(sourceDir);
    const entry = path.join(sourceDir, 'index.ts');
    fs.writeFileSync(entry, "export { value } from './inside';");
    fs.writeFileSync(
      path.join(sourceDir, 'inside.ts'),
      "export { secret as value } from '../../sibling/secret';"
    );
    fs.writeFileSync(path.join(sibling, 'secret.ts'), "export const secret = 'BOUNDARY_SECRET';");

    const host = new CompilerHost();
    expect(() => host.getServiceForFile(entry, root)).toThrow(/TypeScript import.*escapes/i);
    host.dispose();
  });

  it('rejects tsconfig include globs outside the selected analysis root', () => {
    const { root, sibling } = workspace();
    const source = path.join(root, 'index.ts');
    fs.writeFileSync(source, 'export const inside = true;');
    fs.writeFileSync(path.join(sibling, 'secret.ts'), "export const secret = 'BOUNDARY_SECRET';");
    fs.writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ include: ['../sibling/*.ts', 'index.ts'] })
    );

    const host = new CompilerHost();
    expect(() => host.getServiceForFile(source, root)).toThrow(
      /escapes the selected workspace root/i
    );
    host.dispose();
  });

  it('rejects tsconfig extends outside the selected analysis root', () => {
    const { root, sibling } = workspace();
    const source = path.join(root, 'index.ts');
    fs.writeFileSync(source, 'export const inside = true;');
    fs.writeFileSync(
      path.join(sibling, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true } })
    );
    fs.writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ extends: '../sibling/tsconfig.json' })
    );

    const host = new CompilerHost();
    expect(() => host.getServiceForFile(source, root)).toThrow(
      /escapes the selected workspace root/i
    );
    host.dispose();
  });

  it('rejects package entry points outside the selected analysis root', async () => {
    const { root, sibling } = workspace();
    fs.writeFileSync(path.join(sibling, 'secret.ts'), 'export const secret = true;');
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ main: '../sibling/secret.ts' })
    );

    await expect(detectEntryPoints(root, root)).rejects.toThrow(
      /escapes the selected workspace root/i
    );
  });
});
