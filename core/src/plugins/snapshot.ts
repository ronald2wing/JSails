/**
 * Managed plugin state snapshots: a deterministic, versioned JSON document that
 * captures the installed/enabled plugin state for export and import (Drupal
 * `cex`/`cim`, Magento `app:config:dump`).
 *
 * A snapshot is a pure-data projection of {@link PluginStateSource} state plus
 * best-effort provenance read from the installed bundles: for each plugin id it
 * records the active version, the enabled flag, the provenance source (always
 * `'bundle'` for a managed deployment — managed installs are bundles), and,
 * when the active version's bundle is present on disk, the checksum recorded in
 * that bundle's manifest. The document is a strict Zod schema
 * (`{ format: 'jsails.plugins', version: 1, plugins: [...] }`), sorted by id,
 * with no secrets, no absolute paths, and no timestamps, so two exports of the
 * same state are byte-identical apart from intentionally changed content.
 *
 * Import reconciles **database state only**: it never installs or removes
 * bundle files. Each snapshot entry is folded back into a
 * {@link PluginState} `plugins` record (`active`/`enabled`), preserving any
 * `settings` already persisted for that id. Import refuses to enable a plugin
 * whose bundle (the `<pluginsDir>/<id>/<version>/` directory) is missing, and
 * reports every rejected entry; `--force` may override the missing-bundle
 * enablement refusal but never fabricates the bundle itself. The operation is
 * idempotent: re-importing the same snapshot is a no-op.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { mapZodIssues } from '../internal/zod.js';
import {
  isValidSemverVersion,
  PLUGIN_ID_PATTERN,
  PLUGIN_MANIFEST_FILENAME,
  parsePluginManifest,
} from './manifest/index.js';
import type { PluginState } from './state-store.js';

/** The snapshot format discriminator. */
export const PLUGIN_SNAPSHOT_FORMAT = 'jsails.plugins';

/** The single supported snapshot format version. */
export const PLUGIN_SNAPSHOT_VERSION = 1;

/** Upper bound on the number of plugins a snapshot may hold. */
const MAX_SNAPSHOT_PLUGINS = 1000;

/** Upper bound on an `id`/`version`/`checksum` string length. */
const MAX_SNAPSHOT_STRING = 256;

/** A single plugin's entry in a snapshot. */
export interface PluginSnapshotEntry {
  /** Plugin id matching {@link PLUGIN_ID_PATTERN}. */
  readonly id: string;
  /** Active plugin version (valid semver). */
  readonly version: string;
  /** Whether the plugin is enabled. */
  readonly enabled: boolean;
  /** Provenance source; `bundle` for a managed deployment. */
  readonly source: 'bundle';
  /** The active bundle's checksum, when the bundle is present on disk. */
  readonly checksum?: string;
}

/** The parsed snapshot document. */
export interface PluginSnapshot {
  /** Format discriminator; always {@link PLUGIN_SNAPSHOT_FORMAT}. */
  readonly format: typeof PLUGIN_SNAPSHOT_FORMAT;
  /** Format version; always {@link PLUGIN_SNAPSHOT_VERSION}. */
  readonly version: typeof PLUGIN_SNAPSHOT_VERSION;
  /** Plugin entries sorted by id. */
  readonly plugins: readonly PluginSnapshotEntry[];
}

/** Raised for a malformed snapshot or an import refusing every entry. */
export class PluginSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginSnapshotError';
  }
}

/** A snapshot entry that import refused, with its value-free reason code. */
export interface RejectedSnapshotEntry {
  /** The plugin id; present when the entry itself was well-formed. */
  readonly id?: string;
  /** A value-free reason code, never an echoed id, version, or checksum. */
  readonly code: string;
}

/** The outcome of an import reconciliation. */
export interface ImportSnapshotResult {
  /** The reconciled state to persist (empty when every entry was refused). */
  readonly state: PluginState;
  /** Entries that were refused, each with a value-free reason. */
  readonly rejected: readonly RejectedSnapshotEntry[];
}

/** The per-plugin snapshot entry schema. */
const pluginSnapshotEntrySchema = z
  .object({
    id: z.string().min(1).max(MAX_SNAPSHOT_STRING).regex(PLUGIN_ID_PATTERN),
    version: z.string().min(1).max(MAX_SNAPSHOT_STRING),
    enabled: z.boolean(),
    source: z.literal('bundle'),
    checksum: z.string().min(1).max(MAX_SNAPSHOT_STRING).optional(),
  })
  .strict();

/** The snapshot document schema. */
const pluginSnapshotSchema = z
  .object({
    format: z.literal(PLUGIN_SNAPSHOT_FORMAT),
    version: z.literal(PLUGIN_SNAPSHOT_VERSION),
    plugins: z.array(pluginSnapshotEntrySchema),
  })
  .strict();

/** Validate a raw value into a {@link PluginSnapshot}, throwing value-free errors. */
export function parsePluginSnapshot(raw: unknown): PluginSnapshot {
  const result = pluginSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new PluginSnapshotError(formatSnapshotIssues(result.error));
  }
  const { plugins } = result.data;
  if (plugins.length > MAX_SNAPSHOT_PLUGINS) {
    throw new PluginSnapshotError('plugin snapshot contains too many plugins');
  }
  const seen = new Set<string>();
  for (const entry of plugins) {
    if (!isValidSemverVersion(entry.version)) {
      throw new PluginSnapshotError('plugin snapshot contains an invalid version');
    }
    if (seen.has(entry.id)) {
      throw new PluginSnapshotError('plugin snapshot contains a duplicate plugin id');
    }
    seen.add(entry.id);
  }
  return { ...result.data, plugins: result.data.plugins.slice().sort(byId) };
}

/** Join value-free issue descriptions; no input value is ever echoed. */
function formatSnapshotIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const message = mapZodIssues([issue])[0]?.message ?? 'invalid value';
      const location = issue.path
        .filter((segment): segment is string | number => typeof segment !== 'symbol')
        .join('.');
      return location === '' ? `plugin snapshot: ${message}` : `${location}: ${message}`;
    })
    .join('; ');
}

/** Strategy for reading the bundle manifest checksums (injectable for tests). */
export interface SnapshotFs {
  /** Whether a path exists. */
  existsSync(path: string): boolean;
  /** Read a file as UTF-8; throws on failure. */
  readFileSync(path: string): string;
}

const defaultSnapshotFs: SnapshotFs = {
  existsSync,
  readFileSync: (path) => readFileSync(path, 'utf8'),
};

/** The options for {@link exportPluginSnapshot}. */
export interface ExportPluginSnapshotOptions {
  /** Directory holding installed bundles (`<pluginsDir>/<id>/<version>/`). */
  readonly pluginsDir: string;
  /** Injectable fs facade (tests); defaults to Node's `node:fs`. */
  readonly fs?: SnapshotFs;
}

/**
 * Project a {@link PluginState} into a deterministic {@link PluginSnapshot}.
 * Each id becomes a bundle-sourced entry; the active version's manifest
 * contributes its checksum when the bundle is present on disk. The result is
 * sorted by id and contains no secrets, absolute paths, or timestamps.
 */
export function exportPluginSnapshot(
  state: PluginState,
  options: ExportPluginSnapshotOptions,
): PluginSnapshot {
  const fs = options.fs ?? defaultSnapshotFs;
  const plugins: PluginSnapshotEntry[] = [];
  for (const [id, entry] of Object.entries(state.plugins)) {
    const checksum = readActiveChecksum(fs, options.pluginsDir, id, entry.active);
    plugins.push({
      id,
      version: entry.active,
      enabled: entry.enabled,
      source: 'bundle',
      ...(checksum === undefined ? {} : { checksum }),
    });
  }
  plugins.sort(byId);
  return { format: PLUGIN_SNAPSHOT_FORMAT, version: PLUGIN_SNAPSHOT_VERSION, plugins };
}

/** Read the active bundle's manifest checksum, or `undefined` when unavailable. */
function readActiveChecksum(
  fs: SnapshotFs,
  pluginsDir: string,
  id: string,
  version: string,
): string | undefined {
  const manifestPath = join(pluginsDir, id, version, PLUGIN_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }
  let text: string;
  try {
    text = fs.readFileSync(manifestPath);
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  try {
    // `checksums` is an artifact-name -> checksum map; the active bundle's
    // canonical artifact is `<id>-<version>.tgz`. Fall back to any single
    // checksum when the canonical key is absent, keeping the import provenance
    // best-effort rather than authoritative.
    const manifest = parsePluginManifest(parsed);
    const checksums = manifest.checksums;
    if (checksums === undefined) {
      return undefined;
    }
    return checksums[`${id}-${version}.tgz`] ?? Object.values(checksums)[0];
  } catch {
    return undefined;
  }
}

/** The options for {@link importPluginSnapshot}. */
export interface ImportPluginSnapshotOptions {
  /** Directory holding installed bundles, checked before enabling a plugin. */
  readonly pluginsDir: string;
  /** Injectable fs facade (tests); defaults to Node's `node:fs`. */
  readonly fs?: SnapshotFs;
  /** Whether a missing bundle may still be enabled. Defaults to `false`. */
  readonly force?: boolean;
}

/**
 * Fold a {@link PluginSnapshot} back into database state, refusing any entry
 * whose bundle/version is missing (unless `force`). Existing `settings` in the
 * current state are preserved; entries that fail validation are reported as
 * {@link RejectedSnapshotEntry} values instead of thrown, and the result state
 * contains only the accepted entries merged over the current state.
 *
 * Import never installs or removes bundle files: it reconciles the persisted
 * state only, so a missing bundle is a report, not a fabricated install.
 */
export function importPluginSnapshot(
  snapshot: PluginSnapshot,
  current: PluginState,
  options: ImportPluginSnapshotOptions,
): ImportSnapshotResult {
  const fs = options.fs ?? defaultSnapshotFs;
  const rejected: RejectedSnapshotEntry[] = [];
  const force = options.force === true;

  // An invalid version or a missing bundle is reported per entry, never thrown,
  // so a single bad entry does not abort a batch import. `force` skips only the
  // missing-bundle refusal; an invalid version is always rejected.
  for (const entry of snapshot.plugins) {
    if (!isValidSemverVersion(entry.version)) {
      rejected.push({ id: entry.id, code: 'invalid_version' });
    } else if (!force && !bundlePresent(fs, options.pluginsDir, entry.id, entry.version)) {
      rejected.push({ id: entry.id, code: 'missing_bundle' });
    }
  }

  const refusedIds = new Set(rejected.map((entry) => entry.id));
  const plugins: Record<
    string,
    { active: string; enabled: boolean; settings?: Record<string, unknown> }
  > = {};

  for (const entry of snapshot.plugins) {
    if (refusedIds.has(entry.id)) {
      continue;
    }
    // Import only reconciles the persisted `active`/`enabled`/`settings` triple:
    // `source` and `checksum` are provenance captured at export time and are
    // never written back (the database schema has no such columns).
    const existing = current.plugins[entry.id];
    plugins[entry.id] = {
      active: entry.version,
      enabled: entry.enabled,
      ...(existing?.settings === undefined ? {} : { settings: existing.settings }),
    };
  }

  return {
    state: { version: current.version, plugins },
    rejected,
  };
}

/** Whether `<pluginsDir>/<id>/<version>/` exists as an installed bundle. */
function bundlePresent(fs: SnapshotFs, pluginsDir: string, id: string, version: string): boolean {
  return fs.existsSync(join(pluginsDir, id, version, PLUGIN_MANIFEST_FILENAME));
}

/** Sort snapshot entries by id for a deterministic document. */
function byId(a: PluginSnapshotEntry, b: PluginSnapshotEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
