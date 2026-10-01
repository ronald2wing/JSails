/**
 * The `plugins.use` resolver: turn config entries into constructed plugins.
 *
 * A plugin instance (`definePlugin`) is already constructed and is returned in
 * place. A legacy specifier entry (`'pkg'` or `['pkg', options]`, accepted by
 * the compat mapper until KRN-11b removes it) is imported, and its default
 * export is called with the options when it is a factory. A module whose
 * default export is already a `JsailsPlugin` object is accepted as-is. A
 * factory that `definePlugin` returned parses the options itself; an invalid
 * set fails that entry, as a throwing factory does.
 *
 * Dependencies between entries are not declared here: a plugin's `requires`
 * and `provides` order the graph, and the kernel validates it before any
 * setup runs.
 *
 * This module only imports module code. It never opens a connection, reads
 * the filesystem, or calls `setup`.
 */

import type { ExtensionEntry } from '../extensions/extension.js';
import { isJsailsPlugin } from '../extensions/plugin-contract.js';
import { isPluginInstance } from './contract/instance.js';
import type { PluginUseEntry } from '../app/config/schema.js';
import type { PluginIssue } from './discovery/index.js';
import { importModule } from '../support/project-paths.server.js';

/** Input to {@link resolvePluginUse}. */
export interface ResolvePluginUseInput {
  /** The `plugins.use` entries of the app config, in order. */
  readonly entries: readonly PluginUseEntry[];
}

/** The result of resolving `plugins.use` entries. */
export interface ResolvePluginUseResult {
  /** Constructed plugins, in the same order as the entries. One bad entry never aborts the rest. */
  readonly plugins: readonly ExtensionEntry[];
  /** Value-free issues for entries that failed to import, had an invalid export, or threw. */
  readonly issues: readonly PluginIssue[];
}

/**
 * Resolve `plugins.use` entries into constructed plugins, in entry order.
 *
 * - A plugin instance is kept as it is.
 * - A specifier is imported with `importModule` (a bare package name, a
 *   `file://` URL, or an absolute path). A relative specifier has no base and
 *   fails.
 * - Any failure (an import error, a missing or invalid default export, a
 *   factory that throws or returns something else) adds a value-free
 *   `plugin_load_failed` issue, and resolution continues with the next entry.
 */
export async function resolvePluginUse(
  input: ResolvePluginUseInput,
): Promise<ResolvePluginUseResult> {
  const plugins: ExtensionEntry[] = [];
  const issues: PluginIssue[] = [];
  for (const entry of input.entries) {
    if (isPluginInstance(entry)) {
      plugins.push(entry);
      continue;
    }
    const [specifier, options] = typeof entry === 'string' ? [entry, {}] : entry;
    let namespace: unknown;
    try {
      namespace = await importModule(specifier);
    } catch {
      issues.push(useLoadFailure(specifier));
      continue;
    }
    const plugin = await extractPluginFromUse(namespace, options);
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

/**
 * Extract a plugin from an imported module namespace.
 *
 * The module's default export is checked first:
 * - If it is already a `JsailsPlugin` object (non-empty string `name` and
 *   a `setup` function), it is returned as-is.
 * - Otherwise it must be a factory function. The factory is called with
 *   `options`, the result is awaited, and it must be a valid `JsailsPlugin`
 *   or a plugin instance.
 *
 * Returns `undefined` when the default export is missing, not a
 * function/plugin, the factory throws, or the factory returns an invalid value.
 */
export async function extractPluginFromUse(
  namespace: unknown,
  options: Readonly<Record<string, unknown>>,
): Promise<ExtensionEntry | undefined> {
  if (namespace === null || typeof namespace !== 'object') {
    return undefined;
  }
  const defaultExport = (namespace as Record<string, unknown>)['default'];
  if (isJsailsPlugin(defaultExport)) {
    return defaultExport;
  }
  if (typeof defaultExport !== 'function') {
    return undefined;
  }
  let constructed: unknown;
  try {
    constructed = await (defaultExport as (opts: Record<string, unknown>) => unknown)(options);
  } catch {
    // The factory's error may embed an option value, so only the failure is kept.
    return undefined;
  }
  if (!isJsailsPlugin(constructed) && !isPluginInstance(constructed)) {
    return undefined;
  }
  return constructed;
}

/**
 * Build a value-free `plugin_load_failed` issue for a specifier entry. The
 * specifier is echoed in the message (it is a config value the developer
 * wrote, not a secret); no module contents, option values, or error messages
 * are included.
 */
function useLoadFailure(specifier: string): PluginIssue {
  return {
    code: 'plugin_load_failed',
    message: `plugin "${specifier}" failed to load`,
    path: specifier,
  };
}
