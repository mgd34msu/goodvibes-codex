/**
 * `scaffold`, create a new project from a template.
 *
 * Template content lives under `plugins/goodvibes/templates/` (see its README).
 * Template dependencies are pinned to tested versions rather than `latest`.
 *
 * Contract:
 *  - Paths go through the `base_path`/`resolved_path` contract, so a scaffold
 *    destination is checked against the registered workspace rather than read
 *    from an ambient environment variable.
 *  - Runs under `core/proc` `withBudget`, so a hung install command degrades to
 *    a partial, honestly-accounted result instead of hanging the client.
 *  - `dry_run` is the default: it reports what would be created and run without
 *    touching disk or spawning a shell.
 *  - The copy takes whatever is physically present in the template's `files/`
 *    tree. The `template.yaml` `files:` list is documentation and is never
 *    consulted for the copy itself, so a per-template consistency test in
 *    `src/__tests__/scaffold.test.ts` guards against manifest/tree drift.
 */

import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import * as yaml from 'js-yaml';

import {
  errorEnvelope,
  successEnvelope,
  toCallToolResult,
  startTimer,
} from '@goodvibes/core/envelope';
import {
  assertExistingPathWithinSelectedRoot,
  assertPathWithinSelectedRoot,
  resolveBaseDir,
  resolveInputPath,
} from '@goodvibes/core/fsx';
import { withBudget } from '@goodvibes/core/proc';
import type { ToolDefinition } from './types.js';

/** Scaffold may shell out to `npm install`, so it gets a longer budget than the
 * analyzers. This value is fixed rather than config-overridable: changing it
 * would need its own config key, and no caller has needed one. */
const SCAFFOLD_BUDGET_MS = 90_000;
/** Hard ceiling for any single post-create shell command (install/git init). */
const POST_CREATE_TIMEOUT_MS = 60_000;

interface TemplateVariable {
  name: string;
  default?: string;
}

interface TemplateConfig {
  name?: string;
  required_skills?: string[];
  variables?: TemplateVariable[];
  post_create?: Array<{ command: string; description: string }>;
}

interface PostCreateResult {
  command: string;
  success: boolean;
  output: string;
}

interface ScaffoldArgs {
  template: string;
  output_dir: string;
  base_path?: string;
  variables?: Record<string, string>;
  run_install?: boolean;
  run_git_init?: boolean;
  package_manager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  dry_run?: boolean;
  output?: { max_tokens?: number };
}

interface ScaffoldData {
  content: string; // envelope enforceMaxTokens contract; human-readable summary
  template: string;
  output_dir: string;
  resolved_path: string;
  dry_run: boolean;
  created_files: string[];
  variables_applied: Record<string, string>;
  post_create_results: PostCreateResult[];
  recommended_skills: string[];
  next_steps: string[];
}

/** Every template directory this server ships, relative to the plugin root. */
const TEMPLATE_CATEGORIES = ['minimal', 'full'] as const;

function templatesRoot(): string {
  // The launcher resolves the installed plugin root independently of the
  // target workspace. Tests may continue to provide PLUGIN_ROOT explicitly.
  const pluginRoot = process.env.GOODVIBES_PLUGIN_ROOT ?? process.env.PLUGIN_ROOT ?? process.cwd();
  return path.join(pluginRoot, 'templates');
}

/** Locate a named template under minimal/ or full/. */
function findTemplateDir(templatesDir: string, template: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(template)) {
    return null;
  }
  for (const category of TEMPLATE_CATEGORIES) {
    const candidate = path.join(templatesDir, category, template);
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const canonical = assertExistingPathWithinSelectedRoot(candidate, templatesDir);
      if (fs.statSync(canonical).isDirectory()) {
        return canonical;
      }
    } catch {
      // Invalid or escaping installed template; never treat it as available.
    }
  }
  return null;
}

/** Recursively list every file under `dir`, relative to `dir`. */
async function listFilesRecursive(dir: string, relBase = ''): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = relBase ? path.join(relBase, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`Template contains unsupported symbolic link: ${rel}`);
    }
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(path.join(dir, entry.name), rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/** Strip a trailing `.hbs` extension (handlebars-templated files render without it). */
function destName(name: string): string {
  return name.endsWith('.hbs') ? name.slice(0, -4) : name;
}

/** Substitute `{{key}}` variables in file content. */
function substitute(content: string, variables: Record<string, string>): string {
  let out = content;
  for (const [key, value] of Object.entries(variables)) {
    out = out.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return out;
}

function destinationRelativePath(sourceRelativePath: string): string {
  return sourceRelativePath.split(path.sep).map(destName).join(path.sep);
}

async function rejectExistingDestination(candidate: string, selectedRoot: string): Promise<void> {
  assertPathWithinSelectedRoot(candidate, selectedRoot);
  try {
    const stat = await fsp.lstat(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symbolic-link destination: ${candidate}`);
    }
    throw new Error(`Refusing to overwrite existing scaffold destination: ${candidate}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function ensureSafeDirectory(candidate: string, selectedRoot: string): Promise<void> {
  const canonicalRoot = assertExistingPathWithinSelectedRoot(selectedRoot, selectedRoot);
  const safeCandidate = assertPathWithinSelectedRoot(candidate, canonicalRoot);
  if (safeCandidate === canonicalRoot) {
    return;
  }

  try {
    const stat = await fsp.lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Scaffold destination component is not a regular directory: ${candidate}`);
    }
    assertExistingPathWithinSelectedRoot(candidate, canonicalRoot);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await ensureSafeDirectory(path.dirname(candidate), canonicalRoot);
  try {
    await fsp.mkdir(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const created = await fsp.lstat(candidate);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`Scaffold destination component is not a regular directory: ${candidate}`);
  }
  assertExistingPathWithinSelectedRoot(candidate, canonicalRoot);
}

/** Run a shell command with a hard timeout; never throws, reports failure in the result. */
function runShell(command: string, cwd: string, timeoutMs: number): Promise<PostCreateResult> {
  return new Promise(resolve => {
    const [cmd, ...args] = command.split(' ');
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        command,
        success: !err,
        output: (err ? stderr || err.message : stdout).slice(0, 200),
      });
    });
  });
}

function installCommand(pm: NonNullable<ScaffoldArgs['package_manager']>): string {
  return pm === 'npm' ? 'npm install' : `${pm} install`;
}

async function runScaffold(args: ScaffoldArgs): Promise<ScaffoldData> {
  const templatesDir = templatesRoot();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.template)) {
    throw new Error(`Invalid template id: '${args.template}'.`);
  }
  const templateDir = findTemplateDir(templatesDir, args.template);
  if (!templateDir) {
    const available = TEMPLATE_CATEGORIES.flatMap(c => {
      const dir = path.join(templatesDir, c);
      return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    });
    throw new Error(
      `Template not found: '${args.template}'. Available: ${available.join(', ') || '(none installed)'}.`
    );
  }

  const templateYamlPath = path.join(templateDir, 'template.yaml');
  if (!fs.existsSync(templateYamlPath)) {
    throw new Error(`Template config not found: ${args.template}/template.yaml`);
  }
  const safeTemplateYamlPath = assertExistingPathWithinSelectedRoot(templateYamlPath, templateDir);
  const templateConfig = yaml.load(
    await fsp.readFile(safeTemplateYamlPath, 'utf-8')
  ) as TemplateConfig;

  const variables: Record<string, string> = {};
  for (const v of templateConfig.variables ?? []) {
    variables[v.name] = args.variables?.[v.name] ?? v.default ?? '';
  }
  Object.assign(variables, args.variables ?? {});

  const selectedRoot = resolveBaseDir(args.base_path);
  const lexicalOutputPath = path.isAbsolute(args.output_dir)
    ? path.resolve(args.output_dir)
    : path.resolve(selectedRoot, args.output_dir);
  try {
    const outputStat = await fsp.lstat(lexicalOutputPath);
    if (outputStat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link scaffold output directory: ${lexicalOutputPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const { resolved_path: outputPath } = resolveInputPath(args.output_dir, selectedRoot);
  const filesDir = path.join(templateDir, 'files');
  const dryRun = args.dry_run !== false;

  let createdFiles: string[];
  if (dryRun) {
    createdFiles = fs.existsSync(filesDir)
      ? (await listFilesRecursive(filesDir)).map(destinationRelativePath)
      : [];
  } else {
    const sourceFiles = fs.existsSync(filesDir) ? await listFilesRecursive(filesDir) : [];
    const plan = sourceFiles.map(sourceRelativePath => {
      const sourcePath = assertExistingPathWithinSelectedRoot(
        path.join(filesDir, sourceRelativePath),
        filesDir
      );
      const destinationRelative = destinationRelativePath(sourceRelativePath);
      const destinationPath = assertPathWithinSelectedRoot(
        path.join(outputPath, destinationRelative),
        selectedRoot
      );
      return { sourcePath, destinationPath, destinationRelative };
    });

    // Preflight every file before the first write so an existing file or
    // symlink cannot produce a partially-overwritten scaffold.
    for (const item of plan) {
      await rejectExistingDestination(item.destinationPath, selectedRoot);
    }

    await ensureSafeDirectory(outputPath, selectedRoot);
    createdFiles = [];
    if (fs.existsSync(filesDir)) {
      for (const item of plan) {
        await ensureSafeDirectory(path.dirname(item.destinationPath), selectedRoot);
        const content = await fsp.readFile(item.sourcePath, 'utf-8');
        await fsp.writeFile(item.destinationPath, substitute(content, variables), {
          encoding: 'utf-8',
          flag: 'wx',
        });
        createdFiles.push(item.destinationRelative);
      }
    }
  }

  const postCreateResults: PostCreateResult[] = [];
  const pm = args.package_manager ?? 'npm';
  if (!dryRun && args.run_install === true) {
    postCreateResults.push(await runShell(installCommand(pm), outputPath, POST_CREATE_TIMEOUT_MS));
  } else if (dryRun && args.run_install === true) {
    postCreateResults.push({
      command: installCommand(pm),
      success: true,
      output: '(dry run, not executed)',
    });
  }
  if (!dryRun && args.run_git_init === true) {
    postCreateResults.push(await runShell('git init', outputPath, 10_000));
  } else if (dryRun && args.run_git_init === true) {
    postCreateResults.push({
      command: 'git init',
      success: true,
      output: '(dry run, not executed)',
    });
  }

  const nextSteps: string[] = [`cd ${args.output_dir}`];
  if (args.template === 'next-saas') {
    nextSteps.push('cp .env.example .env');
    nextSteps.push('Configure environment variables in .env');
    nextSteps.push('npx prisma db push');
  }
  nextSteps.push('npm run dev');

  const summaryLines = [
    `Scaffolded '${args.template}' ${dryRun ? '(dry run) ' : ''}into ${args.output_dir}`,
    `${createdFiles.length} file(s)${dryRun ? ' would be created' : ' created'}.`,
  ];

  return {
    content: summaryLines.join(' '),
    template: args.template,
    output_dir: args.output_dir,
    resolved_path: outputPath,
    dry_run: dryRun,
    created_files: createdFiles,
    variables_applied: variables,
    post_create_results: postCreateResults,
    recommended_skills: templateConfig.required_skills ?? [],
    next_steps: nextSteps,
  };
}

function validate(raw: Record<string, unknown>): ScaffoldArgs | string {
  if (typeof raw.template !== 'string' || raw.template.length === 0) {
    return 'template (string) is required.';
  }
  if (typeof raw.output_dir !== 'string' || raw.output_dir.length === 0) {
    return 'output_dir (string) is required.';
  }
  return {
    template: raw.template,
    output_dir: raw.output_dir,
    base_path: typeof raw.base_path === 'string' ? raw.base_path : undefined,
    variables:
      raw.variables && typeof raw.variables === 'object'
        ? (raw.variables as Record<string, string>)
        : undefined,
    run_install: typeof raw.run_install === 'boolean' ? raw.run_install : undefined,
    run_git_init: typeof raw.run_git_init === 'boolean' ? raw.run_git_init : undefined,
    package_manager:
      raw.package_manager === 'npm' ||
      raw.package_manager === 'pnpm' ||
      raw.package_manager === 'yarn' ||
      raw.package_manager === 'bun'
        ? raw.package_manager
        : undefined,
    dry_run: typeof raw.dry_run === 'boolean' ? raw.dry_run : undefined,
    output:
      raw.output && typeof raw.output === 'object'
        ? (raw.output as { max_tokens?: number })
        : undefined,
  };
}

export const scaffoldTool: ToolDefinition = {
  definition: {
    name: 'scaffold',
    description:
      'Use to start a new app from a vetted template instead of hand-assembling boilerplate. Create a new project from a bundled template (minimal: vite-react, next-app; full: next-saas). ' +
      'Copies template files with {{variable}} substitution, then optionally runs an install and `git init`. ' +
      'Set dry_run: true to preview created files and commands without touching disk or a shell.',
    inputSchema: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          description: "Template id, e.g. 'vite-react', 'next-app', 'next-saas'.",
        },
        output_dir: {
          type: 'string',
          description: 'Directory to scaffold into (relative to base_path, or cwd with a warning).',
        },
        base_path: { type: 'string', description: 'Base directory output_dir resolves against.' },
        variables: {
          type: 'object',
          description: 'Template variable overrides (defaults come from template.yaml).',
        },
        run_install: {
          type: 'boolean',
          description: 'Run the package manager install after copying files (default false).',
        },
        run_git_init: {
          type: 'boolean',
          description: "Run 'git init' after copying files (default false).",
        },
        package_manager: {
          type: 'string',
          enum: ['npm', 'pnpm', 'yarn', 'bun'],
          description: 'Defaults to npm.',
        },
        dry_run: {
          type: 'boolean',
          description:
            'Preview only: no filesystem writes or shell commands (default true; set false explicitly to create files).',
        },
        output: {
          type: 'object',
          properties: { max_tokens: { type: 'number' } },
          description: 'Response token cap.',
        },
      },
      required: ['template', 'output_dir'],
    },
  },
  handler: async rawArgs => {
    const parsed = validate(rawArgs);
    if (typeof parsed === 'string') {
      return toCallToolResult(errorEnvelope(`Invalid arguments: ${parsed}`));
    }

    const elapsed = startTimer();
    const outcome = await withBudget(SCAFFOLD_BUDGET_MS, async signal => {
      try {
        const data = await runScaffold(parsed);
        return { ok: true as const, data };
      } catch (err) {
        void signal.aborted; // scaffold's file/shell steps are not cooperative-cancelable; budget still bounds wall time
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    });

    const meta = { execution_ms: elapsed(), budget_exceeded: outcome.budget_exceeded };
    if (!outcome.value.ok) {
      return toCallToolResult(errorEnvelope(outcome.value.error, meta));
    }

    const env = successEnvelope(outcome.value.data, meta);
    return toCallToolResult(env);
  },
};
