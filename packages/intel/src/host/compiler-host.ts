/**
 * The one intel compiler host, a single wrapped TypeScript LanguageService /
 * Program per tsconfig scope, shared by every intel analyzer (§3.3, R4).
 *
 * Ported and rebuilt from project-engine `core/code-intel/language-service.ts`.
 * v2 changes:
 *  - No global `getProjectRoot()`: callers resolve `base_path` → absolute via
 *    `core/fsx` and hand the host absolute paths. The host does no path rewriting
 *    beyond slash-normalization for TS's own key space (`toTsPath`).
 *  - No background `setInterval` cleanup (field issue 9, a timer that keeps the
 *    event loop alive is exactly the orphaned-server bug). The cache is bounded
 *    by COUNT with least-recently-accessed eviction, and `dispose()` tears it
 *    all down on shutdown.
 *  - `getServiceForFiles([...])` adds every requested file to the program's root
 *    set, so `program.getSourceFile()` is deterministic for whole-directory
 *    analysis (code_surface) instead of depending on import reachability.
 *  - Robust default-lib resolution for the bundled runtime (see tsconfig.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

import { logger } from '@goodvibes/core/logging';
import {
  assertExistingPathWithinSelectedRoot,
  assertPathWithinSelectedRoot,
} from '@goodvibes/core/fsx';
import { toTsPath } from './paths.js';
import { TS_ANALYSIS_OPTIONS, MAX_CACHED_SERVICES } from './constants.js';
import { findTsConfigSync, parseTsConfigSync, findTypescriptLibDir } from './tsconfig.js';
import type { CachedService, HostServiceResult } from './types.js';

/**
 * Owns a bounded set of TypeScript LanguageService instances (one per tsconfig
 * scope) behind a shared document registry. Construct one and share it; the
 * module also exposes a process-wide singleton via {@link getCompilerHost}.
 */
export class CompilerHost {
  private readonly cache = new Map<string, CachedService>();
  private readonly documentRegistry = ts.createDocumentRegistry();

  /**
   * Get a LanguageService/Program that has `absoluteFilePath` loaded as a root.
   * @param absoluteFilePath - an absolute path (resolve via core/fsx first)
   */
  getServiceForFile(absoluteFilePath: string, analysisRoot: string): HostServiceResult {
    return this.getServiceForFiles([absoluteFilePath], analysisRoot);
  }

  /**
   * Get a single LanguageService/Program with every given file loaded as a root
   * of one program, so `program.getSourceFile()` resolves each deterministically.
   * The tsconfig scope is discovered from the FIRST file; all files are assumed
   * to belong to it (the analyzers call this per analyzed directory/package).
   * @param absoluteFilePaths - absolute paths (non-empty)
   */
  getServiceForFiles(absoluteFilePaths: string[], analysisRoot: string): HostServiceResult {
    if (absoluteFilePaths.length === 0) {
      throw new Error('getServiceForFiles requires at least one file');
    }

    const root = assertExistingPathWithinSelectedRoot(analysisRoot, analysisRoot);
    const safeFiles = absoluteFilePaths.map(filePath =>
      toTsPath(assertExistingPathWithinSelectedRoot(filePath, root))
    );
    const first = safeFiles[0];
    const configPath = findTsConfigSync(first, root);
    const cacheKey = `${toTsPath(root)}::${configPath ?? toTsPath(root)}`;

    let entry = this.cache.get(cacheKey);
    if (!entry) {
      entry = this.createLanguageService(root, configPath);
      this.cache.set(cacheKey, entry);
      this.evictIfNeeded();
    }
    entry.lastAccessed = Date.now();

    for (const filePath of safeFiles) {
      this.ensureFileLoaded(entry, filePath, root);
    }

    const program = entry.service.getProgram();
    if (!program) {
      throw new Error(`Failed to build a TypeScript program for ${first}`);
    }
    const compilerLibDir = path.dirname(ts.getDefaultLibFilePath(entry.compilerOptions));
    for (const sourceFile of program.getSourceFiles()) {
      const fileName = sourceFile.fileName;
      try {
        assertExistingPathWithinSelectedRoot(fileName, root);
      } catch {
        try {
          assertExistingPathWithinSelectedRoot(fileName, compilerLibDir);
        } catch {
          throw new Error(
            `TypeScript resolved '${fileName}' outside the selected analysis root '${root}'.`
          );
        }
      }
    }
    return { service: entry.service, program, configPath: entry.configPath };
  }

  /**
   * Get a loaded source file for an absolute path, or undefined. Convenience
   * over `getServiceForFile(p).program.getSourceFile(...)`.
   * @param absoluteFilePath - absolute path
   */
  getSourceFile(absoluteFilePath: string, analysisRoot: string): ts.SourceFile | undefined {
    const normalized = toTsPath(absoluteFilePath);
    const { program } = this.getServiceForFiles([absoluteFilePath], analysisRoot);
    return program.getSourceFile(normalized);
  }

  /** Dispose every cached service. Call on server shutdown / test cleanup. */
  dispose(): void {
    for (const [, cached] of this.cache) {
      try {
        cached.service.dispose();
      } catch {
        // best-effort teardown
      }
    }
    this.cache.clear();
  }

  /** Evict the least-recently-accessed service while over the count bound. */
  private evictIfNeeded(): void {
    while (this.cache.size > MAX_CACHED_SERVICES) {
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [key, cached] of this.cache) {
        if (cached.lastAccessed < oldest) {
          oldest = cached.lastAccessed;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) {
        break;
      }
      const victim = this.cache.get(oldestKey);
      try {
        victim?.service.dispose();
      } catch {
        // best-effort
      }
      this.cache.delete(oldestKey);
    }
  }

  /** Build a new LanguageService for a tsconfig scope. */
  private createLanguageService(analysisRoot: string, configPath: string | null): CachedService {
    // Parse the tsconfig for BOTH options and the project file set. The file set
    // seeds the program roots so cross-file reference searches (safe_delete) see
    // sibling files that never import the target.
    const parsed = configPath ? parseTsConfigSync(configPath, analysisRoot) : null;
    const compilerOptions = parsed ? parsed.options : { ...TS_ANALYSIS_OPTIONS };
    const currentDirectory = configPath ? path.dirname(configPath) : analysisRoot;
    // Resolve the target project's TypeScript lib dir once (bundled-runtime fix).
    const projectTsLibDir = findTypescriptLibDir(currentDirectory, analysisRoot);
    const runtimeTsLibDir = path.dirname(ts.getDefaultLibFilePath(compilerOptions));
    const tsLibDir = projectTsLibDir ?? runtimeTsLibDir;

    const resolveHostPath = (fileName: string): string =>
      path.isAbsolute(fileName) ? fileName : path.resolve(currentDirectory, fileName);
    const allowedPath = (fileName: string): string | null => {
      const candidate = resolveHostPath(fileName);
      try {
        return assertPathWithinSelectedRoot(candidate, analysisRoot);
      } catch {
        try {
          return assertPathWithinSelectedRoot(candidate, tsLibDir);
        } catch {
          return null;
        }
      }
    };

    const files = new Map<
      string,
      { version: number; content: string; snapshot: ts.IScriptSnapshot }
    >();
    const roots = new Set<string>((parsed?.fileNames ?? []).map(toTsPath));

    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => Array.from(new Set([...roots, ...files.keys()])),
      getScriptVersion: fileName => {
        const file = files.get(toTsPath(fileName));
        return file ? String(file.version) : '0';
      },
      getScriptSnapshot: fileName => {
        const allowed = allowedPath(fileName);
        if (!allowed) {
          return undefined;
        }
        const normalized = toTsPath(allowed);
        const cached = files.get(normalized);
        if (cached) {
          return cached.snapshot;
        }
        // Fall back to disk so TS can pull in imports / lib / node_modules types.
        try {
          const content = fs.readFileSync(allowed, 'utf-8');
          let insideAnalysisRoot = false;
          try {
            assertPathWithinSelectedRoot(allowed, analysisRoot);
            insideAnalysisRoot = true;
          } catch {
            // The only other allowed location is the compiler's standard lib.
          }
          if (insideAnalysisRoot) {
            this.assertRelativeImportsWithinRoot(content, allowed, analysisRoot);
          }
          const snapshot = ts.ScriptSnapshot.fromString(content);
          files.set(normalized, { version: 1, content, snapshot });
          return snapshot;
        } catch (error) {
          if (error instanceof Error && error.message.includes('TypeScript import')) {
            throw error;
          }
          return undefined;
        }
      },
      getCurrentDirectory: () => currentDirectory,
      getCompilationSettings: () => compilerOptions,
      getDefaultLibFileName: options => {
        const libFileName = ts.getDefaultLibFileName(options);
        return path.join(tsLibDir, libFileName);
      },
      fileExists: fileName => {
        const allowed = allowedPath(fileName);
        return allowed ? ts.sys.fileExists(allowed) : false;
      },
      readFile: fileName => {
        const allowed = allowedPath(fileName);
        return allowed ? ts.sys.readFile(allowed) : undefined;
      },
      readDirectory: (rootDir, extensions, excludes, includes, depth) => {
        const allowed = allowedPath(rootDir);
        if (!allowed) {
          return [];
        }
        return ts.sys
          .readDirectory(allowed, extensions, excludes, includes, depth)
          .filter(fileName => allowedPath(fileName) !== null);
      },
      directoryExists: dirName => {
        const allowed = allowedPath(dirName);
        return allowed ? ts.sys.directoryExists(allowed) : false;
      },
      getDirectories: dirName => {
        const allowed = allowedPath(dirName);
        return allowed ? ts.sys.getDirectories(allowed).filter(p => allowedPath(p) !== null) : [];
      },
      realpath: fileName => {
        const allowed = allowedPath(fileName);
        if (!allowed) {
          return fileName;
        }
        const real = ts.sys.realpath?.(allowed) ?? allowed;
        return allowedPath(real) ?? fileName;
      },
    };

    const service = ts.createLanguageService(host, this.documentRegistry);
    return {
      service: this.wrapService(service),
      host,
      configPath,
      compilerOptions,
      files,
      roots,
      lastAccessed: Date.now(),
    };
  }

  /**
   * Wrap the service so a diagnostic call for a not-yet-loaded file returns []
   * instead of throwing "Could not find source file".
   */
  private wrapService(service: ts.LanguageService): ts.LanguageService {
    return new Proxy(service, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        if (
          typeof value === 'function' &&
          (prop === 'getSemanticDiagnostics' ||
            prop === 'getSyntacticDiagnostics' ||
            prop === 'getSuggestionDiagnostics')
        ) {
          return (fileName: string) => {
            try {
              return value.call(target, fileName);
            } catch (error) {
              if (error instanceof Error && error.message.includes('Could not find source file')) {
                return [];
              }
              throw error;
            }
          };
        }
        return value;
      },
    });
  }

  /** Load (or refresh) a file into a service's root set. Synchronous by design. */
  private ensureFileLoaded(
    cached: CachedService,
    tsNormalizedPath: string,
    analysisRoot: string
  ): void {
    const safePath = toTsPath(assertExistingPathWithinSelectedRoot(tsNormalizedPath, analysisRoot));
    // An explicitly-requested file is always a program root (covers no-tsconfig
    // scopes and files outside the tsconfig include set).
    cached.roots.add(safePath);
    try {
      const content = fs.readFileSync(safePath, 'utf-8');
      this.assertRelativeImportsWithinRoot(content, safePath, analysisRoot);
      const existing = cached.files.get(safePath);
      if (!existing || existing.content !== content) {
        cached.files.set(safePath, {
          version: (existing?.version ?? 0) + 1,
          content,
          snapshot: ts.ScriptSnapshot.fromString(content),
        });
      }
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('escapes the selected workspace root') ||
          err.message.includes('TypeScript import'))
      ) {
        throw err;
      }
      logger.warn(`Compiler host could not read file ${safePath}`, String(err));
    }
  }

  /** Reject explicit relative/absolute module specifiers that cross the analysis root. */
  private assertRelativeImportsWithinRoot(
    content: string,
    sourcePath: string,
    analysisRoot: string
  ): void {
    const imports = ts.preProcessFile(content, true, true).importedFiles;
    for (const imported of imports) {
      const specifier = imported.fileName;
      if (
        !specifier.startsWith('.') &&
        !path.isAbsolute(specifier) &&
        !path.win32.isAbsolute(specifier)
      ) {
        continue;
      }
      if (path.isAbsolute(specifier) || path.win32.isAbsolute(specifier)) {
        throw new Error(
          `TypeScript import '${specifier}' from '${sourcePath}' escapes the selected analysis root '${analysisRoot}'.`
        );
      }
      const unresolved = path.resolve(path.dirname(sourcePath), specifier);
      try {
        assertPathWithinSelectedRoot(unresolved, analysisRoot);
        for (const candidate of [
          unresolved,
          `${unresolved}.ts`,
          `${unresolved}.tsx`,
          `${unresolved}.js`,
          `${unresolved}.jsx`,
          `${unresolved}.mjs`,
          `${unresolved}.cjs`,
          `${unresolved}.json`,
          path.join(unresolved, 'index.ts'),
          path.join(unresolved, 'index.tsx'),
          path.join(unresolved, 'index.js'),
        ]) {
          if (fs.existsSync(candidate)) {
            assertExistingPathWithinSelectedRoot(candidate, analysisRoot);
          }
        }
      } catch {
        throw new Error(
          `TypeScript import '${specifier}' from '${sourcePath}' escapes the selected analysis root '${analysisRoot}'.`
        );
      }
    }
  }
}

/** Process-wide shared host (created lazily). */
let sharedHost: CompilerHost | null = null;

/** Get the shared compiler host, creating it on first use. */
export function getCompilerHost(): CompilerHost {
  return (sharedHost ??= new CompilerHost());
}

/** Dispose and drop the shared host (test isolation / shutdown). */
export function disposeCompilerHost(): void {
  sharedHost?.dispose();
  sharedHost = null;
}
