/**
 * `loadComponentEntries()`: the single seam that reads the compiler-generated
 * component registry.
 *
 * The compiler emits `.jsails/components.registry.ts`, which imports every
 * server-component module and exports `components`, one `{ id, definition }`
 * entry per module with the path-derived id. `tsc` compiles it to
 * `dist/.jsails/components.registry.js`. This function imports that compiled
 * module and returns its entries; the server-components plugin builds the
 * application's own registry from them, so nothing is registered into shared
 * module state and an app never lists its components by hand.
 *
 * A project with no components has no registry module, and the result is an
 * empty list.
 *
 * Server-only: reached through the server-components extension, never a
 * browser-safe entry.
 */

import { importGeneratedRegistry } from '../build/generated-registry.js';
import { ComponentRegistryErrors, type ComponentEntry } from './registry.js';

/**
 * Options for {@link loadComponentEntries}.
 *
 * @public
 */
export interface LoadComponentEntriesOptions {
  /**
   * The application root the `.jsails/` layout is resolved against: the app
   * config's directory, never the process working directory.
   */
  readonly rootDir: string;
}

/**
 * Import the compiled component registry under `rootDir` and return its
 * entries, or an empty list when the project has none. A module whose `components` export is not a
 * list fails with `component_registry.invalid_entries`; the entries themselves
 * are validated when the registry is built.
 *
 * @public
 */
export async function loadComponentEntries(
  options: LoadComponentEntriesOptions,
): Promise<readonly ComponentEntry[]> {
  if (typeof options?.rootDir !== 'string' || options.rootDir === '') {
    throw new TypeError('loadComponentEntries requires the application rootDir');
  }
  const module = await importGeneratedRegistry('components.registry', {
    rootDir: options.rootDir,
  });
  if (module === undefined) {
    return [];
  }
  const entries = module.components;
  if (!Array.isArray(entries)) {
    throw new ComponentRegistryErrors.Error('invalid_entries');
  }
  return entries as readonly ComponentEntry[];
}
