/**
 * The `live:list` command: report the publications an application serves over
 * the live layer (LIVE-PLAN.md Phase 9).
 *
 * Publications are registered at runtime by application code — they are not a
 * declarative part of the app config and are not discoverable from
 * `plugins.use` without executing the application's own startup code (the
 * registry is a caller-supplied object handed to `livePlugin`, and each
 * `registry.register(definePublication(...))` call lives in application code,
 * not in plugin `setup`). The command therefore cannot enumerate a project's
 * publications statically; it loads the app config, resolves `plugins.use`, and
 * reports that publications are registered at runtime.
 *
 * The `registry` dependency seam is how an embedding runtime with an already
 * constructed registry (and the tests) supplies the list the command prints, so
 * the name/collection/authorize rendering is still exercised without a live
 * app.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PublicationRegistry } from '../live/publication-registry.js';
import { resolvePluginUse } from '../plugins/use.js';
import { DEFAULT_APP_CONFIG_PATH, loadAppConfig } from './config-loader.js';

/** Dependency seam for the `live:list` command; tests inject a live registry. */
export interface LiveListDeps {
  /**
   * Resolve the publication registry to list, or `undefined` when no registry
   * is available (the CLI's normal case: publications are registered at runtime
   * by application code this process never runs).
   */
  loadRegistry(configPath: string): Promise<PublicationRegistry | undefined>;
  /** Write one output line. */
  stdout(text: string): void;
}

const defaultLiveListDeps: LiveListDeps = {
  async loadRegistry() {
    return undefined;
  },
  stdout: (text) => process.stdout.write(`${text}\n`),
};

/**
 * Resolve `plugins.use` from the app config without constructing a registry, so
 * the command can report that the app declares plugins rather than a fabricated
 * publication list. A missing default config is a no-op (a CLI-only project has
 * no app config); an explicitly supplied path that does not exist is an error.
 */
async function resolveDeclaredPlugins(configPath: string): Promise<readonly string[]> {
  const appConfig = await loadAppConfig(configPath);
  const result = await resolvePluginUse({ entries: appConfig.plugins?.use ?? [] });
  return result.plugins.map((plugin) => plugin.name);
}

/** Render a publication's summary line: name, collection, and authorize presence. */
function formatPublicationLine(definition: {
  readonly name: string;
  readonly collection: string;
  readonly authorize: unknown;
}): string {
  const authorize = typeof definition.authorize === 'function' ? 'authorize' : 'no authorize';
  return `${definition.name}  ${definition.collection}  ${authorize}`;
}

/**
 * Print the publications a registry exposes, or — when no registry is reachable
 * from the CLI — report that publications are registered at runtime. Returns
 * the process exit code. Exported for tests: inject a live registry to exercise
 * the rendering without an app runtime.
 */
export async function runLiveListCommand(
  configPath: string,
  deps: LiveListDeps = defaultLiveListDeps,
): Promise<number> {
  const registry = await deps.loadRegistry(configPath);

  if (registry !== undefined) {
    const publications = registry.list();
    if (publications.length === 0) {
      deps.stdout('Publications: (none)');
      return 0;
    }
    deps.stdout('Publications:');
    for (const definition of publications) {
      deps.stdout(`  ${formatPublicationLine(definition)}`);
    }
    return 0;
  }

  // No registry is reachable without running application code, which the CLI
  // never does. Report the declared plugins and be explicit that publications
  // are registered at runtime rather than inventing an empty or fake list.
  const declared =
    configPath !== DEFAULT_APP_CONFIG_PATH || existsSync(resolve(configPath))
      ? await resolveDeclaredPlugins(configPath)
      : [];
  deps.stdout(
    'Publications are registered at runtime by application code and are not discoverable by the CLI.',
  );
  if (declared.length > 0) {
    deps.stdout(`Declared plugins: ${declared.join(', ')}`);
  }
  return 0;
}
