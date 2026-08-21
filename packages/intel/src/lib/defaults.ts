/**
 * Shared constants for the search/read trio (code_read, code_grep, code_glob).
 *
 * `DEFAULT_EXCLUDES` is un-anchored (`**\/x/**`, not `x/**`) so a nested
 * `node_modules`, for example `packages/app/node_modules`, is excluded on both
 * the ripgrep and fast-glob backends. Anchoring it lets nested matches leak
 * through.
 *
 * The read size-gate numbers (`MAX_FILE_BYTES`, `MAX_TOKEN_ESTIMATE`,
 * `PAGE_SIZE_LINES`) are deliberately NOT `@goodvibes/core/config` keys. That
 * module's `CONFIG_KEYS` covers process hygiene and trust; these are intel-local
 * read-pagination thresholds and stay local constants.
 */

/** Exclude globs applied by default to every search/glob (un-anchored, matches at any depth). */
export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/*.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
];

/** Maximum file size (bytes) read in full before the pre-read size gate pages it. */
export const MAX_FILE_BYTES = 524_288;

/** Maximum estimated tokens (bytes/4) before the pre-read size gate pages it. */
export const MAX_TOKEN_ESTIMATE = 50_000;

/** Lines per page when the size gate pages a large file's first page. */
export const PAGE_SIZE_LINES = 200;
