/**
 * SQL write keywords.
 *
 * Query-execution constants only. Schema-side Prisma constants belong to intel's
 * `db_schema` rather than here.
 */

/** Write SQL keywords that indicate a mutation query. */
export const WRITE_KEYWORDS: readonly string[] = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'REPLACE',
  'UPSERT',
  'MERGE',
  'GRANT',
  'REVOKE',
  'VACUUM',
];
