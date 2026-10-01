/**
 * Loads the repo's bench collectors (`scripts/bench/collectors/`) into the
 * conformance suites.
 *
 * The collectors are plain repo tooling shared with the bench harness, so
 * they live outside this workspace and are not compiled with it. The suites
 * run from `core/dist/test/...`, one directory deeper than their source, so
 * the modules are found by walking up to the checkout and imported by URL;
 * the types come from the modules' own `.d.mts` declarations.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type * as CollectorsModule from '../../../../scripts/bench/collectors/index.mjs';
import type * as ListenerModule from '../../../../scripts/bench/collectors/listener.mjs';

export type {
  Collectors,
  Counts,
  CounterName,
} from '../../../../scripts/bench/collectors/index.mjs';
export type {
  ListenerResult,
  RequestListener,
} from '../../../../scripts/bench/collectors/listener.mjs';

const COLLECTORS_DIR = join('scripts', 'bench', 'collectors');

/** The checkout root: the nearest ancestor holding `scripts/bench/collectors/`. */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, COLLECTORS_DIR, 'index.mjs'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('scripts/bench/collectors was not found above the suite');
    dir = parent;
  }
}

const collectorsDir = join(findRepoRoot(), COLLECTORS_DIR);

/** The collectors module (`installCollectors`, `CHANNELS`, `COUNTERS`). */
export const collectorsModule: typeof CollectorsModule = (await import(
  pathToFileURL(join(collectorsDir, 'index.mjs')).href
)) as typeof CollectorsModule;

/** The listener-level driver module (`driveListener`). */
export const listenerModule: typeof ListenerModule = (await import(
  pathToFileURL(join(collectorsDir, 'listener.mjs')).href
)) as typeof ListenerModule;
