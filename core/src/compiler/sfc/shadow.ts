/**
 * Sidecars: the files through which TypeScript 7.0 checks `.jsails` files
 * (Phase A, docs/design/sfc.md §3.2). Each lowered file gets three, under
 * `.jsails/sfc/` mirroring its project path:
 *
 * ```text
 * .jsails/sfc/ui/card.jsails.tsx       the shadow, the exact text compileSfc compiles
 * .jsails/sfc/ui/card.jsails.map.json  its span table
 * .jsails/sfc/ui/card.d.jsails.ts      the bridge
 * ```
 *
 * In ESM mode TypeScript resolves `import Card from './card.jsails'` only to
 * the arbitrary-extension declaration `card.d.jsails.ts`; the bridge
 * re-exports the shadow, which `./card.jsails.js` reaches by the ordinary
 * `.js`-to-`.tsx` substitution, and the app's `rootDirs` puts `.jsails/sfc`
 * beside the project. The bridge is fixed text derived from the basename, so
 * it cannot hold an error that `skipLibCheck` would hide.
 *
 * {@link writeSidecars} writes the complete set for a project: each file
 * atomically (a temporary sibling renamed over it) and only when its bytes
 * change, so a watching type checker sees no churn; sidecar files no source
 * accounts for are removed, so a deleted or failing `.jsails` file leaves no
 * shadow to be checked against text it no longer has. It writes and deletes
 * only sidecar files, only under `.jsails/sfc`, and never through a symbolic
 * link.
 *
 * A component folder (`layout.ts`) has its sidecars at its component path,
 * like the single file. Its `x.ts` is also a real module, which TypeScript
 * checks on its own (that is what an editor shows on TS 7.0), so the folder
 * gets a fourth sidecar, the script companion:
 *
 * ```text
 * .jsails/sfc/ui/card.jsails.script.ts  what ui/card/card.ts reads without importing it
 * ```
 *
 * It augments the module `x.ts` with the names the shadow imports from the
 * catalog, typed as their exports, and, for a live component, `defineLive`
 * typed by the shadow's own state: not a generic that infers the state from
 * the options, which a nested `serverAction({ run(state) {…} })` is checked
 * before, but the state type read from the shadow's definition, so
 * `run(state)` in `x.ts` has the type it has in the shadow. Its specifiers
 * are the shadow's, which resolve from the companion's directory exactly as
 * from the shadow's. It is a `.ts` file rather than a declaration file so
 * that `skipLibCheck` cannot hide an error in it; a project that types its
 * folder scripts includes every `.script.ts` file under `.jsails/sfc` in its
 * tsconfig (the fixture harness does; no starter does before the build
 * writes sidecars).
 * {@link syncsSidecars} tells whether a project syncs them at all, which a
 * command that makes a folder requires.
 *
 * Every sidecar ends up spelled exactly as its source's path, also on a
 * case-insensitive file system (APFS, NTFS), where `ui/card.jsails.tsx` finds
 * the entry `ui/Card.jsails.tsx` that a case-only rename of the source left
 * behind. Pruning runs before writing and compares the spellings on disk, so
 * such an entry goes rather than standing in for the new file; and a directory
 * under `.jsails/sfc` that a case-only rename left spelled differently is
 * renamed to the new spelling, because TypeScript rejects a file whose import
 * and on-disk names differ in case.
 */

import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { SfcKind } from '../conventions.js';
import { isErrno } from '../../errors/inspect.js';
import { defineErrors, type ErrorRegistry } from '../../errors/registry.js';
import type { SfcImport } from './compile-page.js';
import type { Shadow } from './segments.js';

const SFC_SIDECAR_ERRORS = {
  symlinked_directory: {
    kind: 'invalid',
    message: 'the shadow directory {path} is a symbolic link',
    context: { path: 'relative-path' },
    suggestion: 'Replace it with a real directory; jsails sync owns .jsails/sfc',
  },
  not_a_directory: {
    kind: 'invalid',
    message: 'the shadow directory {path} is a file, not a directory',
    context: { path: 'relative-path' },
    suggestion: 'Move the file aside; jsails sync keeps its sidecars under .jsails/sfc',
  },
} as const;

/**
 * The sidecar registry: `sfc_sidecar.*`.
 *
 * @internal
 */
export const SfcSidecarErrors: ErrorRegistry<'sfc_sidecar', typeof SFC_SIDECAR_ERRORS> =
  defineErrors('sfc_sidecar', SFC_SIDECAR_ERRORS);

/** The project directory sidecars live in. */
export const SIDECAR_DIRECTORY = '.jsails/sfc';

/**
 * Whether the project at `root` syncs sidecars: {@link writeSidecars} makes
 * `.jsails/sfc` on every run, even for a project without a component, so a
 * project has that directory once its sync has run. A component folder needs
 * it: a folder's `x.ts` is a module of the project's TypeScript program,
 * typed by its script companion, and without sync it would be compiled as a
 * module of its own, without the names the companion gives it.
 */
export function syncsSidecars(root: string): boolean {
  try {
    return lstatSync(join(root, ...SIDECAR_DIRECTORY.split('/'))).isDirectory();
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return false;
    throw error;
  }
}

/** The version of the span-table file's schema. */
export const SPAN_TABLE_VERSION = 1;

/** What a sidecar is written for: a lowered file (an `SfcLowering` is one). */
export interface SidecarSource {
  /** The `.jsails` file's project path. */
  readonly file: string;
  /** Its shadow, or `null` when it did not lower. */
  readonly shadow: Shadow | null;
  /** Its kind: a live component's script companion declares `defineLive`. */
  readonly kind?: SfcKind;
  /**
   * The catalog names its shadow imports, which a folder's script companion
   * declares; a source without them gets no companion.
   */
  readonly imports?: readonly SfcImport[];
}

/** One sidecar file: its project path and its text. */
export interface SidecarFile {
  readonly path: string;
  readonly text: string;
}

/**
 * The file system operations {@link writeSidecars} performs, on absolute
 * paths. Injectable so a test can run it on a case-insensitive file system;
 * the default is `node:fs`.
 */
export interface SidecarFs {
  /** `lstat`, never following a link; `undefined` when nothing is there. */
  lstat(path: string): SidecarFsStat | undefined;
  /** The entries of a directory, with their types as `lstat` reports them. */
  readdir(path: string): readonly SidecarFsEntry[];
  /** Create one directory (not its parents). */
  mkdir(path: string): void;
  /** Remove one empty directory. */
  rmdir(path: string): void;
  /** Read a file as UTF-8; throws when it is missing. */
  readFile(path: string): string;
  /** Create a file that must not exist yet, with `text`. */
  createFile(path: string, text: string): void;
  /** Rename `from` to `to`, replacing a file at `to`. */
  rename(from: string, to: string): void;
  /** Remove one file. */
  unlink(path: string): void;
  /** Remove a file if it is there. */
  discard(path: string): void;
}

/** What {@link SidecarFs.lstat} reports. */
export interface SidecarFsStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** One entry {@link SidecarFs.readdir} lists. */
export interface SidecarFsEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Options of {@link writeSidecars}. */
export interface WriteSidecarsOptions {
  /** The file system; `node:fs` when omitted. */
  readonly fs?: SidecarFs;
}

const NODE_SIDECAR_FS: SidecarFs = Object.freeze({
  lstat: (path: string) => lstatSync(path, { throwIfNoEntry: false }),
  readdir: (path: string) => readdirSync(path, { withFileTypes: true }),
  mkdir: (path: string) => {
    mkdirSync(path);
  },
  rmdir: (path: string) => rmdirSync(path),
  readFile: (path: string) => readFileSync(path, 'utf8'),
  createFile: (path: string, text: string) => writeFileSync(path, text, { flag: 'wx' }),
  rename: (from: string, to: string) => renameSync(from, to),
  unlink: (path: string) => unlinkSync(path),
  discard: (path: string) => rmSync(path, { force: true }),
});

/** What {@link writeSidecars} did, as sorted project paths. */
export interface SidecarSync {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
}

/** The shadow's project path: `.jsails/sfc/ui/card.jsails.tsx`. */
export function shadowPath(file: string): string {
  return `${SIDECAR_DIRECTORY}/${file}.tsx`;
}

/** The span table's project path: `.jsails/sfc/ui/card.jsails.map.json`. */
export function spanTablePath(file: string): string {
  return `${SIDECAR_DIRECTORY}/${file}.map.json`;
}

/** The bridge's project path: `.jsails/sfc/ui/card.d.jsails.ts`. */
export function bridgePath(file: string): string {
  const slash = file.lastIndexOf('/');
  const stem = file.slice(slash + 1).replace(/\.jsails$/, '');
  return `${SIDECAR_DIRECTORY}/${file.slice(0, slash + 1)}${stem}.d.jsails.ts`;
}

/** The script companion's project path: `.jsails/sfc/ui/card.jsails.script.ts`. */
export function scriptCompanionPath(file: string): string {
  return `${SIDECAR_DIRECTORY}/${file}.script.ts`;
}

/** The `.jsails` file a script companion path belongs to, or `undefined` for any other path. */
export function sourceOfScriptCompanionPath(path: string): string | undefined {
  const prefix = `${SIDECAR_DIRECTORY}/`;
  return path.startsWith(prefix) && path.endsWith('.jsails.script.ts')
    ? path.slice(prefix.length, -'.script.ts'.length)
    : undefined;
}

/** The `.jsails` file a shadow path belongs to, or `undefined` for any other path. */
export function sourceOfShadowPath(path: string): string | undefined {
  const prefix = `${SIDECAR_DIRECTORY}/`;
  return path.startsWith(prefix) && path.endsWith('.jsails.tsx')
    ? path.slice(prefix.length, -'.tsx'.length)
    : undefined;
}

/** The `.jsails` file a bridge path belongs to, or `undefined` for any other path. */
export function sourceOfBridgePath(path: string): string | undefined {
  const prefix = `${SIDECAR_DIRECTORY}/`;
  return path.startsWith(prefix) && path.endsWith('.d.jsails.ts')
    ? `${path.slice(prefix.length, -'.d.jsails.ts'.length)}.jsails`
    : undefined;
}

/** The bridge's fixed text: every export of the shadow, `default` included. */
function bridgeText(file: string): string {
  const stem = file.slice(file.lastIndexOf('/') + 1).replace(/\.jsails$/, '');
  const specifier = JSON.stringify(`./${stem}.jsails.js`);
  return `export * from ${specifier};\nexport { default } from ${specifier};\n`;
}

/**
 * The span table as deterministic JSON: each span as the TypeScript 7.1
 * `SpanMapping` tuple plus the index of its source in `sources`.
 */
function spanTableText(file: string, shadow: Shadow): string {
  const rows = shadow.spans.map(
    (span) =>
      `[${[
        span.generatedStart,
        span.generatedEnd - span.generatedStart,
        span.originalStart,
        span.originalEnd - span.originalStart,
        span.kind,
        span.features,
        span.source,
      ].join(',')}]`,
  );
  return (
    `{"version":${SPAN_TABLE_VERSION},"file":${JSON.stringify(file)},` +
    `"sources":${JSON.stringify(shadow.sources.map((source) => source.name))},` +
    `"bodyStart":${shadow.bodyStart},"bodyEnd":${shadow.bodyEnd},` +
    `"spans":[\n${rows.join(',\n')}\n]}\n`
  );
}

/**
 * The script companion of the component `file`, whose folder script is
 * `x/x.ts` beside the companion's directory; see the module comment.
 */
function scriptCompanionText(
  file: string,
  kind: SfcKind | undefined,
  imports: readonly SfcImport[],
): string {
  const stem = file.slice(file.lastIndexOf('/') + 1).replace(/\.jsails$/, '');
  const lines = [`// Written by jsails sync: what ${stem}/${stem}.ts reads without importing it.`];
  const live = kind === 'live';
  if (live) {
    lines.push(
      `type __State = typeof import(${JSON.stringify(`./${stem}.jsails.js`)}).default extends`,
      "  import('jsails/server-components').ServerComponentDefinition<",
      "    infer State extends import('jsails/server-components').ServerComponentState",
      '  >',
      '  ? State',
      '  : never;',
    );
  }
  lines.push(`declare module ${JSON.stringify(`./${stem}/${stem}.js`)} {`);
  for (const entry of imports) {
    lines.push(
      `  export const ${entry.name}: typeof import(${JSON.stringify(entry.specifier)}).${entry.export};`,
    );
  }
  if (live) {
    lines.push(
      '  export function defineLive<Actions = Record<never, never>, Derived = Record<never, never>>(',
      '    options: {',
      "      readonly stateSchema: import('jsails/server-components').DefineComponentOptions<__State>['stateSchema'];",
      '    } & Omit<',
      "      import('jsails/server-components').LiveComponentOptions<__State, Actions, Derived>,",
      "      'render' | 'staticFallback'",
      '    >,',
      '  ): void;',
    );
  }
  lines.push('}', 'export {};', '');
  return lines.join('\n');
}

/** Whether a shadow copies a folder's `x.ts`: a source that is not a `.jsails` file. */
function copiesFolderScript(shadow: Shadow): boolean {
  return shadow.sources.some((entry) => !entry.name.endsWith('.jsails'));
}

/**
 * The sidecar files of one source: none when it has no shadow; the script
 * companion too when the shadow copies a folder's `x.ts`.
 */
export function sidecarFiles(source: SidecarSource): readonly SidecarFile[] {
  if (source.shadow === null) return Object.freeze([]);
  const files: SidecarFile[] = [
    Object.freeze({ path: shadowPath(source.file), text: source.shadow.text }),
    Object.freeze({
      path: spanTablePath(source.file),
      text: spanTableText(source.file, source.shadow),
    }),
    Object.freeze({ path: bridgePath(source.file), text: bridgeText(source.file) }),
  ];
  if (source.imports !== undefined && copiesFolderScript(source.shadow)) {
    files.push(
      Object.freeze({
        path: scriptCompanionPath(source.file),
        text: scriptCompanionText(source.file, source.kind, source.imports),
      }),
    );
  }
  return Object.freeze(files);
}

/** Whether a file name is one of the four sidecar kinds. */
function isSidecarName(name: string): boolean {
  return (
    name.endsWith('.jsails.tsx') ||
    name.endsWith('.jsails.map.json') ||
    name.endsWith('.d.jsails.ts') ||
    name.endsWith('.jsails.script.ts')
  );
}

/** One {@link writeSidecars} call: the project, its file system, and the directories it checked. */
interface SyncContext {
  readonly root: string;
  readonly fs: SidecarFs;
  readonly ensured: Set<string>;
}

function absolute(context: SyncContext, projectPath: string): string {
  return join(context.root, ...projectPath.split('/'));
}

/** A temporary sibling of `path`, which no other writer picks. */
function temporarySibling(path: string): string {
  return `${path}.${randomBytes(6).toString('hex')}.tmp`;
}

/**
 * Whether `projectPath` (a directory) exists, refusing a symbolic link or a
 * file at it. A missing directory is `false`.
 */
function realDirectory(context: SyncContext, projectPath: string): boolean {
  const stat = context.fs.lstat(absolute(context, projectPath));
  if (stat === undefined) return false;
  if (stat.isSymbolicLink()) {
    throw new SfcSidecarErrors.Error('symlinked_directory', { path: projectPath });
  }
  if (!stat.isDirectory()) {
    throw new SfcSidecarErrors.Error('not_a_directory', { path: projectPath });
  }
  return true;
}

/** Whether sync owns the directory `projectPath`: `.jsails/sfc` and everything under it. */
function ownsDirectory(projectPath: string): boolean {
  return projectPath === SIDECAR_DIRECTORY || projectPath.startsWith(`${SIDECAR_DIRECTORY}/`);
}

/**
 * Give the existing directory `projectPath` exactly that spelling on disk. A
 * case-insensitive file system finds it under another one (`UI` for `ui`); a
 * case-sensitive one never does, so there this only reads the parent. The
 * rename goes through a temporary sibling, which works wherever a case-only
 * rename might be refused or ignored.
 */
function respell(context: SyncContext, projectPath: string): void {
  const slash = projectPath.lastIndexOf('/');
  const name = projectPath.slice(slash + 1);
  const entries = context.fs.readdir(absolute(context, projectPath.slice(0, slash)));
  if (entries.some((entry) => entry.name === name)) return;
  const path = absolute(context, projectPath);
  const temporary = temporarySibling(path);
  context.fs.rename(path, temporary);
  context.fs.rename(temporary, path);
}

/**
 * Create the directory `projectPath` and its parents below the project, never
 * through a link, and spell each one sync owns exactly as `projectPath` does.
 */
function ensureDirectory(context: SyncContext, projectPath: string): void {
  const segments = projectPath.split('/');
  for (let count = 1; count <= segments.length; count += 1) {
    const prefix = segments.slice(0, count).join('/');
    if (context.ensured.has(prefix)) continue;
    if (!realDirectory(context, prefix)) {
      context.fs.mkdir(absolute(context, prefix));
    } else if (ownsDirectory(prefix)) {
      respell(context, prefix);
    }
    context.ensured.add(prefix);
  }
}

function readText(context: SyncContext, path: string): string | undefined {
  try {
    return context.fs.readFile(path);
  } catch {
    // Missing or unreadable: the caller writes it.
    return undefined;
  }
}

/** Write `text` to `path` through a temporary sibling, so no reader sees a torn file. */
function writeAtomically(context: SyncContext, path: string, text: string): void {
  const temporary = temporarySibling(path);
  try {
    context.fs.createFile(temporary, text);
    context.fs.rename(temporary, path);
  } catch (error) {
    context.fs.discard(temporary);
    throw error;
  }
}

/**
 * Remove the sidecar files under `directory` that `keep` does not list, and
 * the directories left empty. Paths are built from the names on disk, so an
 * entry that differs from a kept path only in case is not kept. Returns
 * whether `directory` is now empty.
 */
function prune(
  context: SyncContext,
  directory: string,
  keep: ReadonlySet<string>,
  removed: string[],
): boolean {
  let empty = true;
  for (const entry of context.fs.readdir(absolute(context, directory))) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (prune(context, path, keep, removed)) {
        context.fs.rmdir(absolute(context, path));
      } else {
        empty = false;
      }
    } else if (entry.isFile() && isSidecarName(entry.name) && !keep.has(path)) {
      context.fs.unlink(absolute(context, path));
      removed.push(path);
    } else {
      // A symbolic link, another kind of file, or a file sync does not own.
      empty = false;
    }
  }
  return empty;
}

/**
 * Write the sidecars of every source in `sources` under `root` (the project
 * directory) and remove the sidecar files no source accounts for; see the
 * module comment.
 */
export function writeSidecars(
  root: string,
  sources: readonly SidecarSource[],
  options: WriteSidecarsOptions = {},
): SidecarSync {
  const context: SyncContext = { root, fs: options.fs ?? NODE_SIDECAR_FS, ensured: new Set() };
  const files = sources.flatMap((source) => sidecarFiles(source));
  const keep = new Set(files.map((file) => file.path));
  const written: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];

  ensureDirectory(context, SIDECAR_DIRECTORY);
  // Before writing: a stale entry spelled differently would otherwise be read
  // and written through as if it were the new file, then removed.
  prune(context, SIDECAR_DIRECTORY, keep, removed);
  for (const file of files) {
    ensureDirectory(context, file.path.slice(0, file.path.lastIndexOf('/')));
    const target = absolute(context, file.path);
    if (readText(context, target) === file.text) {
      unchanged.push(file.path);
      continue;
    }
    writeAtomically(context, target, file.text);
    written.push(file.path);
  }

  const sorted = (list: string[]): readonly string[] =>
    Object.freeze(list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  return Object.freeze({
    written: sorted(written),
    unchanged: sorted(unchanged),
    removed: sorted(removed),
  });
}
