/**
 * Curated plugin directory: the inert, in-repo catalog model that backs the
 * admin plugin manager's install surface.
 *
 * A {@link PluginDirectoryEntry} is a plain-data description of one published
 * plugin: its id, human-facing name/description, category membership, a
 * featured flag, the latest published version, the semver range of framework
 * versions it supports, and the specifier the installer would use to fetch it.
 * Entries are validated once by {@link createPluginDirectory}, which dedupes by
 * id and freezes the result, so a directory is a read-only, deterministic query
 * surface — no network, no filesystem, no subprocess, and no evaluation of
 * plugin code.
 *
 * The directory has no data of its own: the caller supplies the entry list
 * (typically a hand-maintained in-repo catalog), and this module owns only the
 * shape, the validation, and the deterministic query/ordering behavior.
 */

import { isRecord } from 'jsails/plugin-sdk';
import {
  isValidSemverRange,
  isValidSemverVersion,
  PLUGIN_ID_PATTERN,
  satisfiesRange,
} from 'jsails/plugins';
import { compareVersions } from './versions.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Upper bound on directory entries (defends against pathological input). */
const MAX_ENTRIES = 1000;
/** Upper bound on categories per entry. */
const MAX_CATEGORIES = 20;
/** Upper bound on screenshots per entry. */
const MAX_SCREENSHOTS = 20;
/** Upper bound on an entry id length (matches the manifest id bound). */
const MAX_ID_LENGTH = 214;
/** Upper bound on a display/label-eq string length. */
const MAX_NAME_LENGTH = 200;
const MAX_CATEGORY_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_SUMMARY_LENGTH = 1000;
const MAX_SCREENSHOT_LENGTH = 1024;
const MAX_SPECIFIER_LENGTH = 256;

// ---------------------------------------------------------------------------
// Entry contract and its error
// ---------------------------------------------------------------------------

/** Stable machine code carried by every {@link DirectoryError}. */
export type DirectoryErrorCode =
  | 'invalid_entry'
  | 'duplicate_id'
  | 'unknown_category'
  | 'invalid_framework'
  | 'incompatible_version';

/** Raised for an invalid entry, a duplicate id, or an incompatible version. */
export class DirectoryError extends Error {
  readonly code: DirectoryErrorCode;

  constructor(code: DirectoryErrorCode, message: string) {
    super(message);
    this.name = 'DirectoryError';
    this.code = code;
  }
}

/** One validated plugin directory entry. */
export interface PluginDirectoryEntry {
  /** Unique plugin id matching {@link PLUGIN_ID_PATTERN}. */
  readonly id: string;
  /** Human-facing display name. */
  readonly name: string;
  /** Short human-facing description. */
  readonly description: string;
  /** Category membership, unique per entry, sorted. */
  readonly categories: readonly string[];
  /** Whether the entry is surfaced in the featured list. */
  readonly featured: boolean;
  /** The latest published plugin version (valid semver). */
  readonly latestVersion: string;
  /** Semver range of framework versions this plugin supports. */
  readonly frameworkRange: string;
  /** Optional one-line summary; defaults to absent. */
  readonly summary?: string;
  /** Optional screenshot URLs captured verbatim. */
  readonly screenshots?: readonly string[];
  /** The install specifier the installer uses to fetch the plugin. */
  readonly specifier: string;
  /** Opaque settings schema (a JSON object when present); never interpreted here. */
  readonly settingsSchema?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Entry parsing
// ---------------------------------------------------------------------------

const ENTRY_FIELDS = new Set([
  'id',
  'name',
  'description',
  'categories',
  'featured',
  'latestVersion',
  'frameworkRange',
  'summary',
  'screenshots',
  'specifier',
  'settingsSchema',
]);

/**
 * Validate and parse one raw entry. Throws a value-free {@link DirectoryError}
 * (`invalid_entry`) for a shape/format failure; raw input values are never
 * echoed and never mutated.
 */
export function parsePluginDirectoryEntry(raw: unknown): PluginDirectoryEntry {
  if (!isRecord(raw)) {
    throw new DirectoryError('invalid_entry', 'directory entry must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (!ENTRY_FIELDS.has(key)) {
      throw new DirectoryError('invalid_entry', 'directory entry has an unknown field');
    }
  }

  const id = requireString(raw['id'], 'id', MAX_ID_LENGTH, PLUGIN_ID_PATTERN);
  const name = requireName(raw['name']);
  const description = requireText(raw['description'], 'description', MAX_DESCRIPTION_LENGTH);
  const categories = parseCategories(raw['categories']);
  const featured = raw['featured'] === undefined ? false : requireBoolean(raw['featured']);
  const latestVersion = requireVersion(raw['latestVersion']);
  const frameworkRange = requireRange(raw['frameworkRange']);
  const summary = optionalText(raw['summary'], 'summary', MAX_SUMMARY_LENGTH);
  const screenshots = parseScreenshots(raw['screenshots']);
  const specifier = requireText(raw['specifier'], 'specifier', MAX_SPECIFIER_LENGTH);
  const settingsSchema = parseSettingsSchema(raw['settingsSchema']);

  return Object.freeze({
    id,
    name,
    description,
    categories: Object.freeze(categories),
    featured,
    latestVersion,
    frameworkRange,
    ...(summary === undefined ? {} : { summary }),
    ...(screenshots === undefined ? {} : { screenshots: Object.freeze(screenshots) }),
    specifier,
    ...(settingsSchema === undefined ? {} : { settingsSchema: Object.freeze(settingsSchema) }),
  });
}

/** Require a trimmed, non-empty string matching `pattern` and bounded by `max`. */
function requireString(value: unknown, field: string, max: number, pattern: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new DirectoryError('invalid_entry', `${field} is invalid`);
  }
  if (!pattern.test(value)) {
    throw new DirectoryError('invalid_entry', `${field} is invalid`);
  }
  return value;
}

/** Require a trimmed, non-empty display name bounded by {@link MAX_NAME_LENGTH}. */
function requireName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DirectoryError('invalid_entry', 'name is invalid');
  }
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) {
    throw new DirectoryError('invalid_entry', 'name is invalid');
  }
  return name;
}

/** Require a non-empty (after trim) text value bounded by `max`. */
function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new DirectoryError('invalid_entry', `${field} is invalid`);
  }
  return value;
}

/** Require a boolean field. */
function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new DirectoryError('invalid_entry', 'featured must be a boolean');
  }
  return value;
}

/** Validate a semantic version string value-free. */
function requireVersion(value: unknown): string {
  if (typeof value !== 'string' || !isValidSemverVersion(value)) {
    throw new DirectoryError('invalid_entry', 'latestVersion is invalid');
  }
  return value;
}

/** Validate a semver range string value-free. */
function requireRange(value: unknown): string {
  if (typeof value !== 'string' || !isValidSemverRange(value)) {
    throw new DirectoryError('invalid_entry', 'frameworkRange is invalid');
  }
  return value;
}

/** Validate and dedupe the categories array (sorted for determinism). */
function parseCategories(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new DirectoryError('invalid_entry', 'categories must be an array');
  }
  if (value.length > MAX_CATEGORIES) {
    throw new DirectoryError('invalid_entry', 'categories has too many entries');
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.trim() === '' || raw.trim().length > MAX_CATEGORY_LENGTH) {
      throw new DirectoryError('invalid_entry', 'categories has an invalid entry');
    }
    const category = raw.trim();
    if (!seen.has(category)) {
      seen.add(category);
      result.push(category);
    }
  }
  return result.sort();
}

/** Validate optional text; `undefined` passes through, otherwise bounded. */
function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new DirectoryError('invalid_entry', `${field} is invalid`);
  }
  return value;
}

/** Validate the screenshots array; non-empty strings captured verbatim. */
function parseScreenshots(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new DirectoryError('invalid_entry', 'screenshots must be an array');
  }
  if (value.length > MAX_SCREENSHOTS) {
    throw new DirectoryError('invalid_entry', 'screenshots has too many entries');
  }
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SCREENSHOT_LENGTH) {
      throw new DirectoryError('invalid_entry', 'screenshots has an invalid entry');
    }
    result.push(raw);
  }
  return result;
}

/** Validate the opaque settings schema as a non-null record (values untouched). */
function parseSettingsSchema(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new DirectoryError('invalid_entry', 'settingsSchema must be an object');
  }
  // Copy rather than share so a later mutation of the caller's object cannot
  // leak into the frozen directory entry.
  return { ...value };
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

/** Deterministic sort orders the directory exposes. */
export type DirectorySort = 'name' | 'featured' | 'version';

/** Options for {@link PluginDirectory.list}. */
export interface DirectoryListOptions {
  /** Restrict to entries carrying this category (must exist in the directory). */
  readonly category?: string;
  /** When set, restrict to featured (`true`) or non-featured (`false`) entries. */
  readonly featured?: boolean;
  /** Result ordering; defaults to `'name'`. */
  readonly sort?: DirectorySort;
}

/** A validated, frozen catalog of plugin directory entries. */
export interface PluginDirectory {
  /** Every entry in canonical order (name, then id). */
  readonly entries: readonly PluginDirectoryEntry[];
  /** The sorted union of all entries' categories. */
  readonly categories: readonly string[];
  /** Featured entries in canonical order. */
  readonly featured: readonly PluginDirectoryEntry[];
  /** Look up one entry by id, or `undefined` when absent. */
  get(id: string): PluginDirectoryEntry | undefined;
  /** Filter and sort entries per {@link DirectoryListOptions}. */
  list(options?: DirectoryListOptions): readonly PluginDirectoryEntry[];
  /** Case-insensitive substring search across id/name/description/summary/categories. */
  search(term: string): readonly PluginDirectoryEntry[];
}

/**
 * Build a {@link PluginDirectory} from raw entries. Each entry is parsed with
 * {@link parsePluginDirectoryEntry}, duplicate ids are rejected value-free, and
 * the result is frozen with deterministic ordering. Throws a
 * {@link DirectoryError} on any invalid entry.
 */
export function createPluginDirectory(entries: readonly unknown[]): PluginDirectory {
  if (!Array.isArray(entries)) {
    throw new DirectoryError('invalid_entry', 'directory entries must be an array');
  }
  if (entries.length > MAX_ENTRIES) {
    throw new DirectoryError('invalid_entry', 'directory has too many entries');
  }

  const parsed = entries.map(parsePluginDirectoryEntry);
  const byId = new Map<string, PluginDirectoryEntry>();
  for (const entry of parsed) {
    if (byId.has(entry.id)) {
      throw new DirectoryError('duplicate_id', 'directory has a duplicate plugin id');
    }
    byId.set(entry.id, entry);
  }

  const ordered = [...parsed].sort(compareByNameThenId);
  const categories = Object.freeze(
    [...new Set(parsed.flatMap((entry) => entry.categories))].sort(),
  );
  const featured = Object.freeze(ordered.filter((entry) => entry.featured));

  const directory: PluginDirectory = {
    entries: Object.freeze(ordered),
    categories,
    featured,
    get: (id) => byId.get(id),
    list: (options) => listEntries(ordered, categories, options),
    search: (term) => searchEntries(ordered, term),
  };
  return Object.freeze(directory);
}

/** Filter and sort `entries` per `options`, throwing on an unknown category. */
function listEntries(
  entries: readonly PluginDirectoryEntry[],
  categories: readonly string[],
  options: DirectoryListOptions | undefined,
): readonly PluginDirectoryEntry[] {
  const category = options?.category;
  if (category !== undefined) {
    if (typeof category !== 'string' || category.trim() === '') {
      throw new DirectoryError('unknown_category', 'category is invalid');
    }
    if (!categories.includes(category.trim())) {
      throw new DirectoryError('unknown_category', 'category is not in the directory');
    }
  }
  const sort = options?.sort ?? 'name';
  if (sort !== 'name' && sort !== 'featured' && sort !== 'version') {
    throw new DirectoryError('invalid_entry', 'sort is invalid');
  }
  const featuredFilter = options?.featured;

  const filtered = entries.filter(
    (entry) =>
      (category === undefined || entry.categories.includes(category.trim())) &&
      (featuredFilter === undefined || entry.featured === featuredFilter),
  );

  return Object.freeze([...filtered].sort(comparatorFor(sort)));
}

/** The comparator for a {@link DirectorySort}, always tie-broken by name/id. */
function comparatorFor(
  sort: DirectorySort,
): (a: PluginDirectoryEntry, b: PluginDirectoryEntry) => number {
  switch (sort) {
    case 'version':
      return (a, b) => {
        const comparison = compareVersions(a.latestVersion, b.latestVersion);
        return comparison !== 0 ? -comparison : compareByNameThenId(a, b);
      };
    case 'featured':
      return (a, b) => {
        if (a.featured !== b.featured) return a.featured ? -1 : 1;
        return compareByNameThenId(a, b);
      };
    case 'name':
      return compareByNameThenId;
  }
}

/** Canonical ordering: name ascending, then id ascending. */
function compareByNameThenId(a: PluginDirectoryEntry, b: PluginDirectoryEntry): number {
  const names = a.name.localeCompare(b.name);
  return names !== 0 ? names : a.id.localeCompare(b.id);
}

/** Case-insensitive substring search across the searchable text fields. */
function searchEntries(
  entries: readonly PluginDirectoryEntry[],
  term: string,
): readonly PluginDirectoryEntry[] {
  if (typeof term !== 'string') return Object.freeze([]);
  const needle = term.trim().toLowerCase();
  if (needle === '') return Object.freeze([]);

  const matches = entries.filter((entry) => {
    const haystacks = [
      entry.id,
      entry.name,
      entry.description,
      entry.summary ?? '',
      ...entry.categories,
    ];
    return haystacks.some((value) => value.toLowerCase().includes(needle));
  });
  return Object.freeze(matches);
}

/**
 * Assert that `entry` is compatible with `frameworkVersion`: the version must
 * be valid semver and satisfy the entry's `frameworkRange`. Throws a value-free
 * {@link DirectoryError} (`invalid_framework` or `incompatible_version`) on
 * failure.
 */
export function assertCompatible(entry: PluginDirectoryEntry, frameworkVersion: string): void {
  if (!isValidSemverVersion(frameworkVersion)) {
    throw new DirectoryError('invalid_framework', 'framework version is not valid semver');
  }
  if (!satisfiesRange(frameworkVersion, entry.frameworkRange)) {
    throw new DirectoryError(
      'incompatible_version',
      'plugin is not compatible with this framework',
    );
  }
}
