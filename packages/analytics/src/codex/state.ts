import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AnalyticsLocalConfig, AnalyticsState } from './types.js';

export const DEFAULT_LOCAL_CONFIG: Readonly<AnalyticsLocalConfig> = Object.freeze({
  max_sessions: 500,
  max_file_bytes: 64 * 1024 * 1024,
  max_export_bytes: 1024 * 1024,
  max_report_sessions: 200,
});

const CONFIG_RANGES: Record<keyof AnalyticsLocalConfig, readonly [number, number]> = {
  max_sessions: [1, 5_000],
  max_file_bytes: [1024 * 1024, 256 * 1024 * 1024],
  max_export_bytes: [4 * 1024, 8 * 1024 * 1024],
  max_report_sessions: [1, 1_000],
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function configValue(key: keyof AnalyticsLocalConfig, value: unknown): number {
  const [minimum, maximum] = CONFIG_RANGES[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_LOCAL_CONFIG[key];
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

export function validateConfigKey(key: string): key is keyof AnalyticsLocalConfig {
  return Object.hasOwn(CONFIG_RANGES, key);
}

export function validateConfigValue(
  key: keyof AnalyticsLocalConfig,
  value: unknown
): number | null {
  const [minimum, maximum] = CONFIG_RANGES[key];
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return null;
  }
  return value;
}

export function configRange(key: keyof AnalyticsLocalConfig): readonly [number, number] {
  return CONFIG_RANGES[key];
}

function normalizeState(value: unknown, now: string): AnalyticsState {
  const raw = object(value) ?? {};
  const rawConfig = object(raw.config) ?? {};
  const rawBudgets = object(raw.budgets) ?? {};
  const rawTags = object(raw.tags) ?? {};

  const budgets: AnalyticsState['budgets'] = {};
  for (const [sessionId, candidate] of Object.entries(rawBudgets)) {
    const budget = object(candidate);
    const amount = budget?.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      continue;
    }
    const thresholds = Array.isArray(budget?.warn_at)
      ? budget.warn_at.filter(
          (item): item is number => typeof item === 'number' && item >= 0 && item <= 1
        )
      : [0.5, 0.8, 1];
    budgets[sessionId.slice(0, 200)] = {
      amount: Math.floor(amount),
      warn_at: [...new Set(thresholds)].sort((a, b) => a - b).slice(0, 10),
      updated_at: typeof budget?.updated_at === 'string' ? budget.updated_at : now,
    };
  }

  const tags: AnalyticsState['tags'] = {};
  for (const [sessionId, candidate] of Object.entries(rawTags)) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const values = candidate
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim().slice(0, 100))
      .filter(Boolean);
    if (values.length > 0) {
      tags[sessionId.slice(0, 200)] = [...new Set(values)].slice(0, 50);
    }
  }

  return {
    version: 1,
    config: {
      max_sessions: configValue('max_sessions', rawConfig.max_sessions),
      max_file_bytes: configValue('max_file_bytes', rawConfig.max_file_bytes),
      max_export_bytes: configValue('max_export_bytes', rawConfig.max_export_bytes),
      max_report_sessions: configValue('max_report_sessions', rawConfig.max_report_sessions),
    },
    budgets,
    tags,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : now,
  };
}

export async function readState(
  stateFile: string,
  now: () => Date = () => new Date()
): Promise<AnalyticsState> {
  const timestamp = now().toISOString();
  try {
    return normalizeState(JSON.parse(await readFile(stateFile, 'utf8')), timestamp);
  } catch {
    return normalizeState({}, timestamp);
  }
}

/** Write text through a same-directory temporary and keep the resulting file private. */
export async function atomicWriteText(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(temporary, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await unlink(file).catch(() => undefined);
    await rename(temporary, file);
  }
}

/** Write JSON through a same-directory temporary and keep the resulting file private. */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function acquireLock(lockFile: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const handle = await open(lockFile, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.close();
      return async () => unlink(lockFile).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      try {
        const lockStat = await stat(lockFile);
        if (Date.now() - lockStat.mtimeMs > 30_000) {
          await unlink(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error('Timed out waiting for the local analytics state lock.');
}

/** Serialize read-modify-write state updates across concurrent analytics servers. */
export async function updateState(
  stateFile: string,
  updater: (state: AnalyticsState) => void,
  now: () => Date = () => new Date()
): Promise<AnalyticsState> {
  const release = await acquireLock(`${stateFile}.lock`);
  try {
    const state = await readState(stateFile, now);
    updater(state);
    state.updated_at = now().toISOString();
    await atomicWriteJson(stateFile, state);
    return state;
  } finally {
    await release();
  }
}
