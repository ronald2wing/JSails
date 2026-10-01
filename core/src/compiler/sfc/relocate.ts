/**
 * Specifier relocation: rewriting the relative module specifiers of
 * TypeScript code that moves from one file to another so each still names
 * the same file.
 *
 * A component folder (`layout.ts`) puts a component's `<script>` in
 * `D/x/x.ts`, a real module that TypeScript and the editor resolve where it
 * stands, so its relative specifiers are relative to the folder; the module
 * it compiles to stands at the component's path `D/x.jsails`, as the single
 * file does. The lowering relocates the specifiers it copied from a folder
 * file to that path, each still naming the file it named, which is what
 * makes the two layouts compile to the same bytes (but for a specifier that
 * names a file inside the folder), and `jsails convert` relocates them the
 * other way when it splits a file. Every literal specifier form is covered:
 * static imports, re-exports and `export *`, `import()` of a string literal,
 * TypeScript `import()` types and `import x = require()`. A computed
 * specifier cannot be relocated; it resolves from the compiled module.
 *
 * A {@link PathMap} carries the files that move with the code: when
 * `jsails convert` moves a component, its server module `D/x.server.ts`
 * moves to `D/x/x.server.ts`, so `./x.server.js` in its script reads the
 * same in both layouts.
 */

import { parseSync, Visitor, type ESTree } from 'rolldown/utils';

/** A replacement in a text: `[start, end)` becomes `text`. */
export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A string literal that names a module, with the range of its quotes. */
export interface SpecifierLiteral {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

/** Maps a project path to the path the same file has on the other side of a move. */
export type PathMap = (path: string) => string;

const SAME_PATH: PathMap = (path) => path;

type Node = { type: string; start: number; end: number; [key: string]: unknown };

/** Every literal module specifier of a parsed program, in source order. */
export function specifierLiterals(program: ESTree.Program): readonly SpecifierLiteral[] {
  const found: SpecifierLiteral[] = [];
  const take = (node: unknown): void => {
    const literal = node as Node | null | undefined;
    if (literal?.type === 'Literal' && typeof literal['value'] === 'string') {
      found.push({ start: literal.start, end: literal.end, value: literal['value'] });
    }
  };
  const fromSource = (node: Node): void => take(node['source']);
  new Visitor({
    ImportDeclaration: fromSource,
    ExportNamedDeclaration: fromSource,
    ExportAllDeclaration: fromSource,
    ImportExpression: fromSource,
    TSImportType: fromSource,
    TSExternalModuleReference: (node: Node) => take(node['expression']),
  } as unknown as ConstructorParameters<typeof Visitor>[0]).visit(program);
  return found.sort((a, b) => a.start - b.start);
}

/** Whether a specifier is relative (`./x.js`, `../x.js`, `.`, `..`). */
export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

/**
 * The normalized posix path a relative specifier names from the project path
 * `from`. A path above the project root keeps its leading `..` segments.
 */
export function resolveSpecifier(from: string, specifier: string): string {
  const segments = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && segments.length > 0 && segments.at(-1) !== '..') {
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.join('/');
}

/**
 * The relative specifier that names the project path `target` from the
 * project path `from`, ending in `/` when `trailingSlash` is set.
 */
export function specifierFor(from: string, target: string, trailingSlash = false): string {
  const base = from.split('/').slice(0, -1);
  const parts = target === '' ? [] : target.split('/');
  let shared = 0;
  while (shared < base.length && shared < parts.length && base[shared] === parts[shared]) {
    shared += 1;
  }
  const up = base.length - shared;
  const path = [...Array<string>(up).fill('..'), ...parts.slice(shared)].join('/');
  const relative = path === '' ? '.' : path === '..' || path.startsWith('../') ? path : `./${path}`;
  return trailingSlash ? `${relative}/` : relative;
}

/** The directory part of a project path (`''` at the root). */
function directoryOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

/**
 * The specifier `specifier`, written in `from`, rewritten for code that
 * stands in `to`: unchanged unless it is relative and its file or its
 * target moves, otherwise the normalized path from `to` to its target after
 * `map`. A normalized specifier therefore survives a move and its reverse
 * byte for byte.
 */
export function relocateSpecifier(
  specifier: string,
  from: string,
  to: string,
  map: PathMap = SAME_PATH,
): string {
  if (!isRelativeSpecifier(specifier)) return specifier;
  const resolved = resolveSpecifier(from, specifier);
  const target = map(resolved);
  if (target === resolved && directoryOf(from) === directoryOf(to)) return specifier;
  return specifierFor(to, target, specifier.endsWith('/'));
}

/** A string literal holding `value`, quoted with the quote `literal` uses. */
function quoted(literal: string, value: string): string {
  const quote = literal.startsWith("'") ? "'" : '"';
  const body = value.replace(/[\\\n\r\u2028\u2029]/g, (character) =>
    character === '\\' ? '\\\\' : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `${quote}${body.split(quote).join(`\\${quote}`)}${quote}`;
}

/**
 * The edits that relocate every literal specifier of the TypeScript `code`
 * from `from` to `to` (see {@link relocateSpecifier}), with offsets into
 * `code`; `undefined` when `code` does not parse.
 */
export function relocationEdits(
  code: string,
  from: string,
  to: string,
  map: PathMap = SAME_PATH,
): readonly TextEdit[] | undefined {
  const parsed = parseSync('module.ts', code, { sourceType: 'module', lang: 'ts' });
  if (parsed.errors.some((entry) => entry.severity === 'Error')) return undefined;
  return literalEdits(code, specifierLiterals(parsed.program), from, to, map);
}

/** The edits that relocate `literals` of `text` (see {@link relocationEdits}). */
export function literalEdits(
  text: string,
  literals: readonly SpecifierLiteral[],
  from: string,
  to: string,
  map: PathMap = SAME_PATH,
): readonly TextEdit[] {
  const edits: TextEdit[] = [];
  for (const literal of literals) {
    const relocated = relocateSpecifier(literal.value, from, to, map);
    if (relocated === literal.value) continue;
    edits.push(
      Object.freeze({
        start: literal.start,
        end: literal.end,
        text: quoted(text.slice(literal.start, literal.end), relocated),
      }),
    );
  }
  return Object.freeze(edits);
}

/** `text` with non-overlapping `edits` applied. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  let out = '';
  let cursor = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}
