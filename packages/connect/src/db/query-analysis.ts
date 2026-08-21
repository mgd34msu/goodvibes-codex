/**
 * SQL query analysis, ported verbatim from v1 project-engine
 * `core/database/query-analysis.ts` (read/write classification, LIMIT handling,
 * CTE-with-write detection). This is what enforces the connect read-only
 * default before a query ever reaches an executor.
 */

const CONTROL_OR_UNSAFE = new Set([
  'ANALYZE',
  'ATTACH',
  'BEGIN',
  'CALL',
  'COPY',
  'DETACH',
  'DO',
  'EXEC',
  'EXECUTE',
  'INSTALL',
  'LOAD',
  'LOCK',
  'PRAGMA',
  'REINDEX',
  'SET',
  'UNLOAD',
  'VACUUM',
]);
const WRITE_ALLOWLIST = new Set<string>([
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'REPLACE',
  'UPSERT',
  'MERGE',
]);

/**
 * Remove comments and quoted content while preserving statement punctuation.
 * This is deliberately a conservative lexer, not an SQL parser: anything it
 * cannot classify is rejected before reaching a driver.
 */
export function sanitizeSql(query: string): string {
  let out = '';
  for (let i = 0; i < query.length;) {
    const ch = query[i];
    const next = query[i + 1];

    if (ch === '-' && next === '-') {
      while (i < query.length && query[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (ch === '#') {
      while (i < query.length && query[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      let depth = 1;
      while (i < query.length && depth > 0) {
        if (query[i] === '/' && query[i + 1] === '*') {
          depth++;
          out += '  ';
          i += 2;
        } else if (query[i] === '*' && query[i + 1] === '/') {
          depth--;
          out += '  ';
          i += 2;
        } else {
          out += query[i] === '\n' ? '\n' : ' ';
          i++;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ' ';
      i++;
      while (i < query.length) {
        if (query[i] === quote) {
          if (query[i + 1] === quote) {
            out += '  ';
            i += 2;
            continue;
          }
          out += ' ';
          i++;
          break;
        }
        if (query[i] === '\\' && i + 1 < query.length) {
          out += '  ';
          i += 2;
        } else {
          out += query[i] === '\n' ? '\n' : ' ';
          i++;
        }
      }
      continue;
    }

    if (ch === '$') {
      const match = query.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        const tag = match[0];
        out += ' '.repeat(tag.length);
        i += tag.length;
        const end = query.indexOf(tag, i);
        const stop = end < 0 ? query.length : end + tag.length;
        while (i < stop) {
          out += query[i] === '\n' ? '\n' : ' ';
          i++;
        }
        continue;
      }
    }

    out += ch;
    i++;
  }
  return out;
}

export interface StatementClassification {
  allowed: boolean;
  kind: 'read' | 'write' | 'unknown';
  verb?: string;
  reason: string;
}

/** Classify one conservative, dialect-neutral statement. */
export function classifyStatement(query: string): StatementClassification {
  const clean = sanitizeSql(query).trim();
  if (!clean) {
    return { allowed: false, kind: 'unknown', reason: 'SQL statement is empty.' };
  }

  const semicolons = [...clean.matchAll(/;/g)].map(match => match.index ?? -1);
  if (semicolons.length > 1 || (semicolons.length === 1 && clean.slice(semicolons[0] + 1).trim())) {
    return {
      allowed: false,
      kind: 'unknown',
      reason: 'Multiple or stacked SQL statements are not permitted.',
    };
  }

  const normalized = clean.replace(/;\s*$/, '').trim().toUpperCase();
  const tokens = normalized.match(/[A-Z_]+/g) ?? [];
  const first = tokens[0];
  if (!first) {
    return { allowed: false, kind: 'unknown', reason: 'SQL statement could not be classified.' };
  }

  const present = new Set(tokens);
  const writeVerb = tokens.find(token => WRITE_ALLOWLIST.has(token));
  const unsafe = [...CONTROL_OR_UNSAFE].find(
    word =>
      present.has(word) && !(word === 'SET' && (writeVerb === 'UPDATE' || writeVerb === 'MERGE'))
  );
  if (unsafe) {
    // A small, explicit set of read-only SQLite introspection pragmas is safe.
    const safePragma =
      /^PRAGMA\s+(TABLE_INFO|TABLE_XINFO|INDEX_INFO|INDEX_XINFO|INDEX_LIST|FOREIGN_KEY_LIST|DATABASE_LIST|COMPILE_OPTIONS|PRAGMA_LIST|FUNCTION_LIST|MODULE_LIST)\s*(\([^)]*\))?\s*$/i;
    if (first === 'PRAGMA' && safePragma.test(normalized)) {
      return {
        allowed: true,
        kind: 'read',
        verb: first,
        reason: 'Read-only introspection statement.',
      };
    }
    return {
      allowed: false,
      kind: 'unknown',
      verb: first,
      reason: `SQL statement class ${unsafe} is not supported by GoodVibes.`,
    };
  }

  if (writeVerb) {
    return {
      allowed: true,
      kind: 'write',
      verb: writeVerb,
      reason: 'Explicitly classified write statement.',
    };
  }

  if (first === 'SELECT' || first === 'VALUES') {
    if (present.has('INTO') || (present.has('FOR') && present.has('UPDATE'))) {
      return {
        allowed: false,
        kind: 'unknown',
        verb: first,
        reason: 'Locking and SELECT INTO forms are not permitted.',
      };
    }
    return { allowed: true, kind: 'read', verb: first, reason: 'Read-only query.' };
  }

  if (first === 'WITH') {
    if (!present.has('SELECT') && !present.has('VALUES')) {
      return {
        allowed: false,
        kind: 'unknown',
        verb: first,
        reason: 'WITH statements must resolve to an approved read or write class.',
      };
    }
    return { allowed: true, kind: 'read', verb: first, reason: 'Read-only CTE query.' };
  }

  if (first === 'EXPLAIN') {
    if (present.has('ANALYZE') || (!present.has('SELECT') && !present.has('WITH'))) {
      return {
        allowed: false,
        kind: 'unknown',
        verb: first,
        reason: 'Only non-ANALYZE EXPLAIN of a read query is permitted.',
      };
    }
    return { allowed: true, kind: 'read', verb: first, reason: 'Read-only query plan.' };
  }

  return {
    allowed: false,
    kind: 'unknown',
    verb: first,
    reason: `Unknown or unsupported SQL statement class ${first}.`,
  };
}

/** True when the query modifies data or schema (incl. CTE-with-write). */
export function isWriteOperation(query: string): boolean {
  return classifyStatement(query).kind === 'write';
}

/** True when the query is a pure read (SELECT/EXPLAIN/read PRAGMA/read CTE). */
export function isReadOnlyQuery(query: string): boolean {
  const classification = classifyStatement(query);
  return classification.allowed && classification.kind === 'read';
}

/** True when a LIMIT clause is already present. */
export function hasLimitClause(query: string): boolean {
  const normalizedQuery = sanitizeSql(query).trim().toUpperCase();
  return (
    /\bLIMIT\s+\d+/i.test(normalizedQuery) ||
    /\bLIMIT\s+\$\d+/i.test(normalizedQuery) ||
    /\bLIMIT\s+\?/i.test(normalizedQuery)
  );
}

/** Add a LIMIT to a SELECT/CTE query that lacks one; otherwise return unchanged. */
export function addLimitClause(query: string, limit: number): string {
  const trimmedQuery = query.trim();
  const statement = classifyStatement(trimmedQuery);
  if (
    !statement.allowed ||
    statement.kind !== 'read' ||
    !['SELECT', 'WITH'].includes(statement.verb ?? '')
  ) {
    return trimmedQuery;
  }
  if (hasLimitClause(trimmedQuery)) {
    return trimmedQuery;
  }
  const withoutSemicolon = trimmedQuery.replace(/;\s*$/, '');
  return `${withoutSemicolon} LIMIT ${limit}`;
}

/** Classify a query (write / select / has-limit). */
export function analyzeQuery(sql: string): {
  isWrite: boolean;
  isSelect: boolean;
  hasLimit: boolean;
} {
  return {
    isWrite: isWriteOperation(sql),
    isSelect: isReadOnlyQuery(sql),
    hasLimit: hasLimitClause(sql),
  };
}
