/**
 * Config sync: export the active values to files you commit, and import them
 * back on another environment (Drupal's `config:export` / `config:import`).
 *
 * Each set is one file, `<sync dir>/<set name>.json`:
 *
 *   { "format": "jsails.config", "version": 1, "set": "blog.site", "values": { ... } }
 *
 * Keys are sorted at every depth and the file ends with a newline, so two
 * exports of the same values are byte-identical and a diff shows only what
 * changed. Export writes active values, never overrides: overrides already
 * live in code. Import is planned first: every file is parsed and checked, and
 * any unknown set, unknown key, or invalid value refuses the whole import
 * before anything is written. The writes then land in one store transaction.
 * A declared set with no file is left as it is.
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { JsonValue } from 'jsails/plugin-sdk';

import type { Config } from './config.js';
import { ConfigError } from './config-error.js';
import { checkValues, defaultValues } from './config-set.js';
import { isJsonValue } from './fields.js';

/** The `format` marker of a sync file. */
export const CONFIG_SYNC_FORMAT = 'jsails.config';
/** The sync file version this package reads and writes. */
export const CONFIG_SYNC_VERSION = 1;
/** The default sync directory, relative to the project root. */
export const DEFAULT_SYNC_DIR = 'config/sync';

/** One set's change in an import plan. */
export interface ConfigImportChange {
  readonly set: string;
  /** The keys whose active value the import changes, sorted. */
  readonly keys: readonly string[];
  /** The full values the import writes. */
  readonly values: Readonly<Record<string, JsonValue>>;
}

/** What an import would do. */
export interface ConfigImportPlan {
  readonly changes: readonly ConfigImportChange[];
  /** Declared sets with no sync file; left unchanged. */
  readonly missing: readonly string[];
}

/** The result of an export. */
export interface ConfigExportResult {
  /** Sets whose file was written or rewritten. */
  readonly written: readonly string[];
  /** Sets whose file already matched. */
  readonly unchanged: readonly string[];
  /** `.json` files in the directory that name no declared set; left in place. */
  readonly stale: readonly string[];
}

/** Sort object keys at every depth, so serialization is deterministic. */
function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonical(value[key] as JsonValue);
    return sorted;
  }
  return value;
}

/** The exact text of one set's sync file. */
export function serializeSyncFile(
  set: string,
  values: Readonly<Record<string, JsonValue>>,
): string {
  const document = {
    format: CONFIG_SYNC_FORMAT,
    version: CONFIG_SYNC_VERSION,
    set,
    values: canonical(values),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Parse one sync file's text; refuses anything that is not a version-1 config file. */
export function parseSyncFile(
  text: string,
  file: string,
): { readonly set: string; readonly values: Readonly<Record<string, JsonValue>> } {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ConfigError('invalid_snapshot', `${file} is not valid JSON`);
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new ConfigError('invalid_snapshot', `${file} is not a config sync file`);
  }
  const { format, version, set, values } = document as Record<string, unknown>;
  const keys = Object.keys(document).sort().join(',');
  if (format !== CONFIG_SYNC_FORMAT || keys !== 'format,set,values,version') {
    throw new ConfigError('invalid_snapshot', `${file} is not a config sync file`);
  }
  if (version !== CONFIG_SYNC_VERSION) {
    throw new ConfigError('invalid_snapshot', `${file} has an unsupported version`);
  }
  if (typeof set !== 'string' || `${set}.json` !== file) {
    throw new ConfigError('invalid_snapshot', `${file} must name its own set`);
  }
  if (
    values === null ||
    typeof values !== 'object' ||
    Array.isArray(values) ||
    !isJsonValue(values)
  ) {
    throw new ConfigError('invalid_snapshot', `${file} values must be a JSON object`, set);
  }
  return { set, values: values as Record<string, JsonValue> };
}

/** Write a file atomically: a sibling temporary file renamed over the target. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function jsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Export every declared set's active values into `dir`. */
export async function exportConfig(config: Config, dir: string): Promise<ConfigExportResult> {
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const set of config.sets) {
    const path = join(dir, `${set.name}.json`);
    // Resolved values are JSON-safe: every one passed its field's check.
    const text = serializeSyncFile(
      set.name,
      (await config.active(set)) as Record<string, JsonValue>,
    );
    if ((await readExisting(path)) === text) {
      unchanged.push(set.name);
      continue;
    }
    await writeAtomic(path, text);
    written.push(set.name);
  }
  const declared = new Set(config.sets.map((set) => `${set.name}.json`));
  const stale = (await jsonFiles(dir)).filter((file) => !declared.has(file));
  return { written, unchanged, stale };
}

/** Read and check every sync file in `dir` and compare it with the active values. */
export async function planImport(config: Config, dir: string): Promise<ConfigImportPlan> {
  const files = await jsonFiles(dir);
  const changes: ConfigImportChange[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const parsed = parseSyncFile(await readFile(join(dir, file), 'utf8'), file);
    const set = config.find(parsed.set);
    if (set === undefined) {
      throw new ConfigError('unknown_set', `${file} names a set that is not declared`, parsed.set);
    }
    seen.add(set.name);
    const incoming: Record<string, JsonValue> = {
      ...(defaultValues(set) as Record<string, JsonValue>),
      ...checkValues(set, parsed.values),
    };
    const current = (await config.active(set)) as Record<string, JsonValue>;
    const keys = Object.keys(incoming)
      .filter((key) => serialize(incoming[key]) !== serialize(current[key]))
      .sort();
    if (keys.length > 0) changes.push({ set: set.name, keys, values: incoming });
  }
  const missing = config.sets.map((set) => set.name).filter((name) => !seen.has(name));
  return { changes, missing };
}

function serialize(value: JsonValue | undefined): string {
  return value === undefined ? '' : JSON.stringify(canonical(value));
}

/** Apply a plan's changes in one store write. */
export async function applyImport(config: Config, plan: ConfigImportPlan): Promise<void> {
  await config.replace(plan.changes.map((change) => ({ name: change.set, values: change.values })));
}
