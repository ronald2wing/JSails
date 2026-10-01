/**
 * The island corpus of the `.jsails` compiler: `fixtures/islands/`, a small
 * app whose page mounts islands directly, in a `js-for` loop, inside another
 * island (`toggle-panel` renders `counter` as part of itself) and through a
 * view (`ui/promo`), and whose islands use signals, `@event` with a
 * modifier, `js-model` on a numeric input and a checkbox, a component event
 * (`defineEmits`) and a view (`ui/badge`) the page renders too.
 *
 * The files are read from the source tree, beside this module's source,
 * because the build compiles only TypeScript into `dist/`.
 */

import { readFileSync } from 'node:fs';

import { nameTable, type NameResolver } from '../../../src/compiler/sfc/name-resolver.js';
import type { CorpusFile } from './corpus.js';

/** The island corpus's directory in the source tree. */
export const ISLAND_ROOT: URL = new URL(
  '../../../../test/compiler/sfc/fixtures/islands/',
  import.meta.url,
);

function read(path: string): CorpusFile {
  return Object.freeze({ path, source: readFileSync(new URL(path, ISLAND_ROOT), 'utf8') });
}

/** The islands of the corpus, with the id each compiles under. */
export const ISLAND_IDS: Readonly<Record<string, string>> = Object.freeze({
  'islands/counter.jsails': 'counter',
  'islands/toggle-panel.jsails': 'toggle-panel',
});

/** The files a client bundle of the corpus holds: its islands, and the view they render. */
export const ISLAND_CLIENT_FILES: readonly string[] = Object.freeze([
  ...Object.keys(ISLAND_IDS),
  'ui/badge.jsails',
]);

/** Every file of the island corpus. */
export const ISLAND_APP: readonly CorpusFile[] = Object.freeze(
  [...ISLAND_CLIENT_FILES, 'ui/promo.jsails', 'pages/index.jsails'].map(read),
);

/** The catalog of the island corpus: the signal hook, the islands and the views. */
export const ISLAND_RESOLVER: NameResolver = nameTable({
  useSignal: { source: { package: '@preact/signals' }, export: 'useSignal' },
  Counter: { source: { path: 'islands/counter.jsails' }, export: 'default' },
  TogglePanel: { source: { path: 'islands/toggle-panel.jsails' }, export: 'default' },
  Badge: { source: { path: 'ui/badge.jsails' }, export: 'default' },
  Promo: { source: { path: 'ui/promo.jsails' }, export: 'default' },
});
