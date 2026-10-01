/**
 * Declarative plugin resolver: turn `plugins.use` entries into constructed
 * `JsailsPlugin` objects. This is the third slice of the declarative boot
 * pipeline — it imports module specifiers and invokes their default-export
 * factories, but never runs `setup` (the extension runner does that later).
 *
 * First-party subpaths export factories (`authPlugin(options)`, etc.), so the
 * primary convention is that a module's default export is a factory function.
 * A module whose default export is already a `JsailsPlugin` object is accepted
 * as-is for forward-compatibility.
 *
 * This module is pure: it only imports module code. It never opens a
 * connection, reads the filesystem, or calls `setup`.
 */

import type { JsailsPlugin } from '../extensions/plugin-contract.js';
import { isJsailsPlugin } from './plugin-guard.js';
import type { PluginUseEntry } from '../app/config/schema.js';
import type { PluginIssue } from './discovery/index.js';

/** Input to {@link resolvePluginUse}. */
export interface ResolvePluginUseInput {
  /** Declarative plugin entries from the app config. */
  readonly entries: readonly PluginUseEntry[];
  /** Bypass module dependency/conflict validation (Magento `--force`). */
  readonly force?: boolean;
}

/** The result of resolving declarative plugin entries. */
export interface ResolvePluginUseResult {
  /** Constructed plugins, in the same order as the entries. One bad entry never aborts the rest. */
  readonly plugins: readonly JsailsPlugin[];
  /** Value-free issues for entries that failed to import, had an invalid export, or threw. */
  readonly issues: readonly PluginIssue[];
}

/**
 * Resolve `plugins.use` entries into constructed `JsailsPlugin` objects.
 *
 * Per entry:
 * 1. Normalize: a string becomes `[specifier, {}]`; a tuple stays as-is.
 * 2. `await import(specifier)` — the specifier is imported directly, so it
 *    must be a bare package name or a `file://` URL resolvable by Node.
 * 3. If the module's default export is already a `JsailsPlugin` (object with
 *    a non-empty `name` and a `setup` function), accept it as-is.
 * 4. Otherwise, the default export must be a function (the factory). Call it
 *    with `options` and await the result. The result must be a `JsailsPlugin`.
 * 5. On any failure — import error, missing/invalid default export, factory
 *    throw, or invalid result — push a value-free `PluginIssue` and continue.
 *    One bad entry never aborts the rest.
 * 6. Preserve entry order in `plugins` — the caller decides ordering.
 */
export async function resolvePluginUse(
  input: ResolvePluginUseInput,
): Promise<ResolvePluginUseResult> {
  const plugins: JsailsPlugin[] = [];
  const issues: PluginIssue[] = [];
  const entries = input.entries.map(normalizeUseEntry);

  const byId = new Map<string, NormalizedPluginUseEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      issues.push({
        source: 'package',
        code: 'duplicate_plugin_id',
        message: `plugins.use declares duplicate module id "${entry.id}"`,
        pluginId: entry.id,
      });
      continue;
    }
    byId.set(entry.id, entry);
  }

  if (issues.length === 0 && input.force !== true) {
    for (const entry of entries) {
      if (!entry.enabled) continue;
      for (const requiredId of entry.requires) {
        const required = byId.get(requiredId);
        if (required === undefined) {
          issues.push({
            source: 'package',
            code: 'required_plugin_missing',
            message: `enabled plugin "${entry.id}" requires missing module "${requiredId}"`,
            pluginId: entry.id,
          });
        } else if (!required.enabled) {
          issues.push({
            source: 'package',
            code: 'required_plugin_disabled',
            message: `enabled plugin "${entry.id}" requires disabled module "${requiredId}"`,
            pluginId: entry.id,
          });
        }
      }
      for (const conflictId of entry.conflicts) {
        const conflict = byId.get(conflictId);
        if (conflict !== undefined && conflict.enabled) {
          issues.push({
            source: 'package',
            code: 'plugin_conflict',
            message: `enabled plugins "${entry.id}" and "${conflictId}" conflict`,
            pluginId: entry.id,
          });
        }
      }
    }
  }

  if (issues.length > 0) {
    return Object.freeze({ plugins: Object.freeze([]), issues: Object.freeze([...issues]) });
  }

  for (const entry of entries) {
    if (!entry.enabled) {
      continue;
    }
    const { specifier, options } = entry;

    let namespace: unknown;
    try {
      namespace = await import(specifier);
    } catch {
      issues.push(useLoadFailure(specifier));
      continue;
    }

    const plugin = await extractPluginFromUse(namespace, specifier, options);
    if (plugin === undefined) {
      issues.push(useLoadFailure(specifier));
      continue;
    }
    plugins.push(plugin);
  }

  return Object.freeze({
    plugins: Object.freeze([...plugins]),
    issues: Object.freeze([...issues]),
  });
}

// ---------------------------------------------------------------------------
// Exported helpers — pure logic, not `import()`, for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Normalize a `PluginUseEntry` into a `[specifier, options]` tuple.
 * A bare string gets an empty options object; a tuple is returned as-is.
 */
/** A normalized `plugins.use` module declaration. */
export interface NormalizedPluginUseEntry {
  readonly specifier: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly enabled: boolean;
  readonly requires: readonly string[];
  readonly conflicts: readonly string[];
}

export function normalizeUseEntry(entry: PluginUseEntry): NormalizedPluginUseEntry {
  if (typeof entry === 'string') {
    return Object.freeze({
      specifier: entry,
      options: Object.freeze({}),
      id: entry,
      enabled: true,
      requires: Object.freeze([]),
      conflicts: Object.freeze([]),
    });
  }
  if (Array.isArray(entry)) {
    const tuple = entry as readonly [string, Readonly<Record<string, unknown>>];
    return Object.freeze({
      specifier: tuple[0],
      options: tuple[1],
      id: tuple[0],
      enabled: true,
      requires: Object.freeze([]),
      conflicts: Object.freeze([]),
    });
  }
  const descriptor = entry as Exclude<PluginUseEntry, string | readonly unknown[]>;
  return Object.freeze({
    specifier: descriptor.specifier,
    options: descriptor.options ?? Object.freeze({}),
    id: descriptor.id ?? descriptor.specifier,
    enabled: descriptor.enabled ?? true,
    requires: Object.freeze([...(descriptor.requires ?? [])]),
    conflicts: Object.freeze([...(descriptor.conflicts ?? [])]),
  });
}

/**
 * Extract a `JsailsPlugin` from an imported module namespace.
 *
 * The module's default export is checked first:
 * - If it is already a `JsailsPlugin` object (non-empty string `name` and
 *   a `setup` function), it is returned as-is (forward-compat for modules that
 *   export a ready plugin instead of a factory).
 * - Otherwise it must be a factory function. The factory is called with
 *   `options`, the result is awaited, and it must be a valid `JsailsPlugin`.
 *
 * Returns `undefined` when the default export is missing, not a
 * function/plugin, the factory throws, or the factory returns an invalid value.
 */
export async function extractPluginFromUse(
  namespace: unknown,
  _specifier: string, // diagnostic only; never echoed in errors
  options: Readonly<Record<string, unknown>>,
): Promise<JsailsPlugin | undefined> {
  if (namespace === null || typeof namespace !== 'object') {
    return undefined;
  }
  const record = namespace as Record<string, unknown>;
  const defaultExport = record['default'];

  // Forward-compat: the default export is already a plugin object.
  if (isJsailsPlugin(defaultExport)) {
    return defaultExport;
  }

  // Primary convention: the default export is a factory function.
  if (typeof defaultExport !== 'function') {
    return undefined;
  }

  let constructed: unknown;
  try {
    constructed = (defaultExport as (opts: Record<string, unknown>) => unknown)(options);
  } catch {
    return undefined; // factory threw — value-free
  }

  // Await in case the factory is async.
  if (constructed instanceof Promise) {
    try {
      constructed = await constructed;
    } catch {
      return undefined; // async factory rejected — value-free
    }
  }

  if (!isJsailsPlugin(constructed)) {
    return undefined; // factory returned invalid value
  }

  return constructed;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a value-free `plugin_load_failed` issue for a declarative `use` entry.
 * The specifier is echoed in the message (it is a config value the developer
 * wrote, not a secret); no module contents, option values, or error messages
 * are included.
 */
function useLoadFailure(specifier: string): PluginIssue {
  return {
    source: 'package',
    code: 'plugin_load_failed',
    message: `plugin "${specifier}" failed to load`,
    path: specifier,
  };
}
