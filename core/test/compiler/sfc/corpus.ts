/**
 * The page, layout, error and view corpus of the `.jsails` kind lowerings: one
 * small app, `fixtures/app/`, whose files use every construct a function kind
 * lowers (props from `load` and from `defineProps`, setup bindings and
 * `await`, `js-if` chains, every `js-for` source, keyed fragments, named,
 * scoped and default slots and their use sites, `<component :is>`, merged
 * `class` and `style`, `js-bind`, `js-show`, `js-html`, `js-pre`, catalog
 * names as values and as tags, a `getStaticPaths` route, the error boundary
 * behind a failing page, the not-found page), with the TypeScript modules it
 * imports and the name table that resolves its catalog names. The lowering,
 * scope, typecheck, twin, parity, map and determinism tests all run over it.
 *
 * The files are read from the source tree, beside this module's source,
 * because the build compiles only TypeScript into `dist/`. Every route has a
 * hand-written TSX twin under `fixtures/twin/`.
 */

import { readFileSync } from 'node:fs';

import { nameTable, type NameResolver } from '../../../src/compiler/sfc/name-resolver.js';

/** A corpus file: its project path and its text. */
export interface CorpusFile {
  readonly path: string;
  readonly source: string;
}

/** The corpus app's directory in the source tree (`core/test/compiler/sfc/fixtures/app/`). */
export const CORPUS_ROOT: URL = new URL(
  '../../../../test/compiler/sfc/fixtures/app/',
  import.meta.url,
);

function read(paths: readonly string[]): readonly CorpusFile[] {
  return Object.freeze(
    paths.map((path) =>
      Object.freeze({ path, source: readFileSync(new URL(path, CORPUS_ROOT), 'utf8') }),
    ),
  );
}

/** The `.jsails` files of the corpus app, pages first. */
export const SFC_CORPUS: readonly CorpusFile[] = read([
  'pages/blog/[slug].jsails',
  'pages/index.jsails',
  'pages/layout.jsails',
  'pages/error.jsails',
  'pages/not-found.jsails',
  'pages/posts.jsails',
  'pages/broken.jsails',
  'ui/shell.jsails',
  'ui/tag-badge.jsails',
  'ui/card.jsails',
  'ui/post-list.jsails',
]);

/** The TypeScript modules the corpus's catalog names come from. */
export const CORPUS_MODULES: readonly CorpusFile[] = read([
  'shared/posts.ts',
  'shared/format-date.ts',
]);

/** Every file of the corpus app. */
export const CORPUS_APP: readonly CorpusFile[] = Object.freeze([...SFC_CORPUS, ...CORPUS_MODULES]);

/** The catalog of the corpus: what its free names and tags resolve to. */
export const CORPUS_RESOLVER: NameResolver = nameTable({
  posts: { source: { path: 'shared/posts.ts' }, export: 'posts' },
  formatDate: { source: { path: 'shared/format-date.ts' }, export: 'formatDate' },
  Shell: { source: { path: 'ui/shell.jsails' }, export: 'default' },
  TagBadge: { source: { path: 'ui/tag-badge.jsails' }, export: 'default' },
  Card: { source: { path: 'ui/card.jsails' }, export: 'default' },
  PostList: { source: { path: 'ui/post-list.jsails' }, export: 'default' },
});
