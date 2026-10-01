/**
 * Reads `tsc --pretty false` output over a project with sidecars and puts
 * each diagnostic where the author can act on it (docs/design/sfc.md §3.3,
 * §3.5, §9 correction 4).
 *
 * TypeScript checks shadows, so its positions are in `.jsails/sfc/…tsx`. A
 * position is mapped through the shadow's span table:
 *
 * - inside a Verbatim or Alias span it is the exact `.jsails` position
 *   (`source`): a template expression, a `<script>` line, the name of a
 *   lowered attribute or implicit prop;
 * - inside an Atom it is the start of the template node the generated code
 *   belongs to (`generated`), with the node's tag, so a cascade in a `js-for`
 *   callback reads "in code generated for `<li>`";
 * - in the shadow's header or footer, in a bridge or a script companion, or
 *   in a shadow this run did not lower, it is `internal`: the compiler generated code that does
 *   not check, which the corpus counts as a compiler bug (`sfc_internal`).
 *
 * Any other file's diagnostic passes through unchanged (`file`), except one
 * in a component folder's `x.ts` (a non-`.jsails` source of a shadow): the
 * shadow copies and checks every line of it, so what `tsc` reports about the
 * file on its own is left out. That check exists for the editor (the script
 * companion gives it the catalog's names and a typed `defineLive`), and it
 * cannot see the template's uses of a module binding, so under
 * `noUnusedLocals` it reports a binding only the template reads. The message
 * is TypeScript's, shown to the author as `tsc` would show it; two that land
 * on the same place with the same code and message are reported once,
 * whichever way they came.
 *
 * The shadows come from memory, not from the span-table files: `jsails
 * typecheck` lowers before it syncs, so what it maps through is exactly what
 * `tsc` read. Paths are resolved with an injectable `path` implementation and
 * turned into project ids by `toPosixId`, so the Windows branch is testable
 * anywhere.
 */

import path from 'node:path';

import { toPosixId } from '../../support/project-paths.server.js';
import { lineIndex } from './line-index.js';
import { generatedToOriginal, SpanKind, type Shadow } from './segments.js';
import {
  sourceOfBridgePath,
  sourceOfScriptCompanionPath,
  sourceOfShadowPath,
  type SidecarSource,
} from './shadow.js';

/** A diagnostic category as `tsc` prints it. */
export type TscCategory = 'error' | 'warning' | 'suggestion' | 'message';

/** A 1-based line and column (UTF-16 code units), as `tsc` prints them. */
export interface TscPosition {
  readonly line: number;
  readonly column: number;
}

/** One diagnostic parsed from `tsc --pretty false` output. */
export interface TscDiagnostic {
  /** The file as printed (relative to the working directory), or `null` for a global one. */
  readonly file: string | null;
  readonly position: TscPosition | null;
  readonly category: TscCategory;
  /** The `TSnnnn` number. */
  readonly code: number;
  /** The first line of the message, then each continuation line without its indent. */
  readonly message: string;
}

/** The output of `tsc --pretty false`, parsed. */
export interface TscOutput {
  readonly diagnostics: readonly TscDiagnostic[];
  /** Non-empty lines that are neither a diagnostic nor a continuation. */
  readonly unparsed: readonly string[];
}

const LOCATED = /^(.+)\((\d+),(\d+)\): (error|warning|suggestion|message) TS(\d+): (.*)$/;
const GLOBAL = /^(error|warning|suggestion|message) TS(\d+): (.*)$/;

/** Parse `tsc --pretty false` output (LF or CRLF line ends). */
export function parseTscOutput(text: string): TscOutput {
  const diagnostics: { -readonly [K in keyof TscDiagnostic]: TscDiagnostic[K] }[] = [];
  const unparsed: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const located = LOCATED.exec(line);
    const global = located === null ? GLOBAL.exec(line) : null;
    const previous = diagnostics.at(-1);
    if (located !== null) {
      diagnostics.push({
        file: located[1] ?? '',
        position: { line: Number(located[2]), column: Number(located[3]) },
        category: located[4] as TscCategory,
        code: Number(located[5]),
        message: located[6] ?? '',
      });
    } else if (global !== null) {
      diagnostics.push({
        file: null,
        position: null,
        category: global[1] as TscCategory,
        code: Number(global[2]),
        message: global[3] ?? '',
      });
    } else if (line.startsWith('  ') && previous !== undefined) {
      previous.message = `${previous.message}\n${line.slice(2)}`;
    } else {
      unparsed.push(line);
    }
  }
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics.map((entry) => Object.freeze(entry))),
    unparsed: Object.freeze(unparsed),
  });
}

/** Where a remapped diagnostic points; see the module comment. */
export type RemapOrigin = 'file' | 'source' | 'generated' | 'internal';

/** A `tsc` diagnostic placed on the file the author owns. */
export interface RemappedDiagnostic {
  readonly origin: RemapOrigin;
  /**
   * The project path of the file (`pages/post.jsails`, `shared/format.ts`),
   * or the POSIX relative path of a file outside the project; `null` for a
   * global diagnostic.
   */
  readonly file: string | null;
  /** The position in `file`; `null` for a global or `internal` diagnostic. */
  readonly position: TscPosition | null;
  /** For `generated`: the tag of the template node that owns the code (`<li>`). */
  readonly generatedFor?: string;
  readonly category: TscCategory;
  readonly code: number;
  readonly message: string;
}

/** What {@link remapTscOutput} needs besides the output. */
export interface RemapOptions {
  /** The project directory, which holds `.jsails/sfc`. */
  readonly root: string;
  /** The directory `tsc` ran in; printed paths are relative to it. */
  readonly cwd: string;
  /** The lowered files whose sidecars `tsc` read. */
  readonly sources: readonly SidecarSource[];
  /** The `path` implementation of the platform `tsc` ran on (default: this one). */
  readonly pathApi?: Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>;
}

/** Remap every diagnostic of `output` (the text `tsc --pretty false` printed). */
export function remapTscOutput(
  output: string,
  options: RemapOptions,
): readonly RemappedDiagnostic[] {
  const shadows = new Map<string, Shadow>();
  const folderScripts = new Set<string>();
  for (const source of options.sources) {
    if (source.shadow === null) continue;
    shadows.set(source.file, source.shadow);
    for (const entry of source.shadow.sources) {
      if (!entry.name.endsWith('.jsails')) folderScripts.add(entry.name);
    }
  }
  const pathApi = options.pathApi ?? path;
  // A shadow may copy one source range twice (a live tag's branch condition
  // is checked in the hoisted mount and in the template), so the same
  // diagnostic can map to the same place twice; the author sees it once.
  const seen = new Set<string>();
  const remapped: RemappedDiagnostic[] = [];
  for (const diagnostic of parseTscOutput(output).diagnostics) {
    const entry = remapOne(diagnostic, options, pathApi, shadows);
    if (entry.origin === 'file' && entry.file !== null && folderScripts.has(entry.file)) continue;
    const key = JSON.stringify([
      entry.origin === 'file' || entry.origin === 'source' ? 'author' : entry.origin,
      entry.file,
      entry.position,
      entry.code,
      entry.message,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    remapped.push(Object.freeze(entry));
  }
  return Object.freeze(remapped);
}

function remapOne(
  diagnostic: TscDiagnostic,
  options: RemapOptions,
  pathApi: NonNullable<RemapOptions['pathApi']>,
  shadows: ReadonlyMap<string, Shadow>,
): RemappedDiagnostic {
  const { category, code, message } = diagnostic;
  if (diagnostic.file === null || diagnostic.position === null) {
    return { origin: 'file', file: null, position: null, category, code, message };
  }
  const relative = pathApi.relative(options.root, pathApi.resolve(options.cwd, diagnostic.file));
  const id = toPosixId(relative, pathApi);
  const passThrough = (): RemappedDiagnostic => ({
    origin: 'file',
    file: id,
    position: diagnostic.position,
    category,
    code,
    message,
  });
  // A file outside the project (a declaration under node_modules elsewhere,
  // another drive) is never a sidecar.
  if (id === '..' || id.startsWith('../') || pathApi.isAbsolute(relative)) return passThrough();

  const internal = (file: string): RemappedDiagnostic => ({
    origin: 'internal',
    file,
    position: null,
    category,
    code,
    message,
  });
  const bridged = sourceOfBridgePath(id) ?? sourceOfScriptCompanionPath(id);
  if (bridged !== undefined) return internal(bridged);
  const file = sourceOfShadowPath(id);
  if (file === undefined) return passThrough();
  const shadow = shadows.get(file);
  if (shadow === undefined) return internal(file);

  const offset = lineIndex(shadow.text).offsetAt({
    line: diagnostic.position.line - 1,
    column: diagnostic.position.column - 1,
  });
  const location = offset === undefined ? undefined : generatedToOriginal(shadow, offset);
  if (location === undefined || location.fidelity === 'none') return internal(file);
  const source = shadow.sources[location.source];
  if (source === undefined) return internal(file);
  const at = lineIndex(source.text).positionAt(location.start);
  const position = { line: at.line + 1, column: at.column + 1 };
  if (location.kind !== SpanKind.Atom) {
    return { origin: 'source', file: source.name, position, category, code, message };
  }
  return {
    origin: 'generated',
    file: source.name,
    position,
    generatedFor: ownerTag(source.text, location.start),
    category,
    code,
    message,
  };
}

/** The tag an Atom's owner starts with (`<li>`), or the block it lies in. */
function ownerTag(text: string, start: number): string {
  const tag = /^<\/?([A-Za-z][^\s/>]*)/.exec(text.slice(start, start + 64));
  return tag === null ? 'the template' : `<${tag[1] ?? ''}>`;
}
