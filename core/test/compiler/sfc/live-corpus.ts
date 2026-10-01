/**
 * The live corpus of the `.jsails` compiler: `fixtures/live/`, a small app
 * whose components are live (`components/**.jsails`) and whose pages mount
 * them. `task-list` is sfc-plan §2.7's component with a `<template static>`;
 * `gate` holds every lane under the mutable policy of `shared/gate.ts`, for
 * the deny matrix; `no-fallback` has no static form; `initial` exports its own
 * render (`staticRender: 'initial'`). A live root is signed per render, so
 * these pages cannot join the byte-equal parity of the function-kind corpus;
 * the live tests compare what each mode must write instead.
 *
 * The files are read from the source tree, beside this module's source,
 * because the build compiles only TypeScript into `dist/`.
 */

import { readFileSync } from 'node:fs';

import { nameTable, type NameResolver } from '../../../src/compiler/sfc/name-resolver.js';
import type { CorpusFile } from './corpus.js';

/** The live corpus's directory in the source tree. */
export const LIVE_ROOT: URL = new URL(
  '../../../../test/compiler/sfc/fixtures/live/',
  import.meta.url,
);

function read(path: string): CorpusFile {
  return Object.freeze({ path, source: readFileSync(new URL(path, LIVE_ROOT), 'utf8') });
}

/** The `.jsails` files of the live corpus. */
export const LIVE_SFC: readonly CorpusFile[] = Object.freeze(
  [
    'components/task-list.jsails',
    'components/gate.jsails',
    'components/no-fallback.jsails',
    'components/initial.jsails',
    'pages/tasks.jsails',
    'pages/greeting.jsails',
    'pages/error.jsails',
  ].map(read),
);

/** Every file of the live corpus. */
export const LIVE_APP: readonly CorpusFile[] = Object.freeze([...LIVE_SFC, read('shared/gate.ts')]);

/** The catalog of the live corpus: the authoring helper and the component tags. */
export const LIVE_RESOLVER: NameResolver = nameTable({
  serverAction: { source: { package: 'jsails/server-components' }, export: 'serverAction' },
  TaskList: { source: { path: 'components/task-list.jsails' }, export: 'default' },
  Gate: { source: { path: 'components/gate.jsails' }, export: 'default' },
  NoFallback: { source: { path: 'components/no-fallback.jsails' }, export: 'default' },
  Initial: { source: { path: 'components/initial.jsails' }, export: 'default' },
});

/** A file of the live corpus by path. */
export function liveFile(path: string): CorpusFile {
  const file = LIVE_APP.find((entry) => entry.path === path);
  if (file === undefined) throw new Error(`no live corpus file ${path}`);
  return file;
}
