/**
 * The two layouts of a `.jsails` component: one file, or a folder named after
 * it whose files are its blocks (owner decision 2026-11-20).
 *
 * ```text
 * pages/about.jsails            pages/about/about.jsails     <template>, <template static>, <script setup>
 *                               pages/about/about.ts         the <script> body
 *                               pages/about/about.css        <style>
 *                               pages/about/about.scoped.css <style scoped>
 * pages/about.server.ts         pages/about/about.server.ts  server functions
 * ```
 *
 * A folder component is named by its component path, `pages/about.jsails`,
 * whichever layout it uses: kind, route, component id, output module and
 * sidecars follow from it, and an importer writes `./about.jsails` either
 * way. `lowerSfc` lowers both layouts to the same shadow (`lower.ts`), but
 * for an import of a file inside the folder (its server module), which names
 * that file where it stands.
 *
 * {@link splitSfc} and {@link joinSfc} convert between them, for `jsails
 * convert` and `make --mfc`. Each block's body and every comment survive a
 * conversion byte for byte; relative specifiers in the moved TypeScript are
 * relocated (`relocate.ts`); the order of blocks becomes the canonical one:
 * leading comments, `<script>`, the rest of the file as written, then
 * `<style>` and `<style scoped>`, one blank line apart. A file in that order
 * (what Prettier and the generators write) survives `joinSfc(splitSfc(x))`
 * unchanged, and every valid folder survives `splitSfc(joinSfc(f))`.
 *
 * {@link sfcComponents} groups a project's paths into components, the step
 * the project index builds on, and reports a file and a folder that claim
 * one component.
 */

import {
  SFC_FOLDER_SUFFIXES,
  sfcFolderMember,
  type SfcFolderRole,
} from '../../routing/component-parts.js';
import { findRawTextEndTag, parseSfcBlocks, type SfcBlock } from './blocks.js';
import { SfcDiagnostics, type SfcDiagnostic } from './diagnostics.js';
import { applyTextEdits, relocationEdits, type PathMap, type TextEdit } from './relocate.js';

/** The texts of a component folder's files; only the template is required. */
export interface SfcFolderSources {
  /** `x/x.jsails`: `<template>`, optional `<template static>` and `<script setup>`. */
  readonly template: string;
  /** `x/x.ts`: the `<script>` body. */
  readonly script?: string;
  /** `x/x.css`: the `<style>` body. */
  readonly style?: string;
  /** `x/x.scoped.css`: the `<style scoped>` body. */
  readonly scopedStyle?: string;
}

/** The project paths of a component's files in its folder. */
export type SfcFolderPaths = Readonly<Record<SfcFolderRole, string>>;

/**
 * The folder paths of the component `file` (`D/x.jsails` → `D/x/x.jsails`,
 * `D/x/x.ts`, `D/x/x.css`, `D/x/x.scoped.css`, `D/x/x.server.ts`).
 */
export function sfcFolderPaths(file: string): SfcFolderPaths {
  const slash = file.lastIndexOf('/');
  const name = file.slice(slash + 1).replace(/\.jsails$/, '');
  const folder = `${file.slice(0, slash + 1)}${name}/${name}`;
  const paths = {} as Record<SfcFolderRole, string>;
  for (const role of Object.keys(SFC_FOLDER_SUFFIXES) as SfcFolderRole[]) {
    paths[role] = `${folder}${SFC_FOLDER_SUFFIXES[role]}`;
  }
  return Object.freeze(paths);
}

/** The server module beside the single file `file` (`D/x.jsails` → `D/x.server.ts`). */
export function sfcServerPath(file: string): string {
  return `${file.replace(/\.jsails$/, '')}${SFC_FOLDER_SUFFIXES.server}`;
}

/**
 * The ways a relative specifier names the server module `D/x.server.ts`,
 * after its directory: `./x.server.js` (Node's ESM resolution), `./x.server.ts`
 * (`allowImportingTsExtensions`) and `./x.server` (bundler resolution). Only
 * these name it; `./x.server.types.js` is another module, which stays where it
 * is when the component changes layout.
 */
const SERVER_SPELLINGS: readonly string[] = Object.freeze(['.js', '.ts', '']);

/** Maps each spelling of the server module `from` (a `.server.ts` path) to the same spelling of `to`. */
function serverPathMap(from: string, to: string): PathMap {
  const fromBase = from.replace(/\.ts$/, '');
  const toBase = to.replace(/\.ts$/, '');
  const moves = new Map(
    SERVER_SPELLINGS.map((extension) => [`${fromBase}${extension}`, `${toBase}${extension}`]),
  );
  return (path) => moves.get(path) ?? path;
}

/**
 * The paths that move when the component `file` changes layout, mapped
 * from the single layout to the folder: its server module, under each
 * spelling a specifier names it with (`./x.server.js`), and nothing else.
 */
export function toFolderPaths(file: string): PathMap {
  return serverPathMap(sfcServerPath(file), sfcFolderPaths(file).server);
}

/** The reverse of {@link toFolderPaths}: folder paths to the single layout. */
export function toSinglePaths(file: string): PathMap {
  return serverPathMap(sfcFolderPaths(file).server, sfcServerPath(file));
}

/** Why {@link splitSfc} refused a file. */
export type SfcSplitRefusal =
  /** The blocks do not scan cleanly, so their boundaries are not certain. */
  | 'invalid_blocks'
  /** `<script>` or `<script setup>` does not parse, so its specifiers cannot be relocated. */
  | 'script_syntax'
  /** More than one `<style>`, or more than one `<style scoped>`: a folder holds one of each. */
  | 'style_count';

/** Where a position of a split file went: a folder file and an offset into it. */
export interface SfcFolderPosition {
  readonly file: string;
  readonly offset: number;
}

/** The outcome of {@link splitSfc}. */
export type SfcSplit =
  | {
      readonly ok: true;
      readonly folder: SfcFolderSources;
      /**
       * Where the single file's offset `offset` is in the folder; a position
       * inside a rewritten specifier or a removed block tag goes to the start
       * of what replaced it, or `undefined` when nothing did.
       */
      readonly positionOf: (offset: number) => SfcFolderPosition | undefined;
    }
  | {
      readonly ok: false;
      readonly refusal: SfcSplitRefusal;
      /** The diagnostics that explain the refusal, positioned in the file. */
      readonly diagnostics: readonly SfcDiagnostic[];
    };

/** A top-level item of a `.jsails` file: a block or a comment, with its range. */
interface Item {
  readonly start: number;
  readonly end: number;
  readonly block: SfcBlock | null;
}

/** The top-level items of `source`, whose blocks scanned without a structural error. */
function itemsOf(source: string, blocks: readonly SfcBlock[]): readonly Item[] {
  const items: Item[] = [];
  let cursor = 0;
  const comments = (to: number): void => {
    for (;;) {
      const open = source.indexOf('<!--', cursor);
      if (open === -1 || open >= to) return;
      const close = source.indexOf('-->', open + 4);
      items.push({ start: open, end: close + 3, block: null });
      cursor = close + 3;
    }
  };
  for (const block of [...blocks].sort((a, b) => a.start - b.start)) {
    comments(block.start);
    items.push({ start: block.start, end: block.end, block });
    cursor = block.end;
  }
  comments(source.length);
  return items;
}

/**
 * Builds one output file from ranges of a source and generated text,
 * recording where each copied range went, so a source offset can be found in
 * the output.
 */
class OutputBuilder {
  text = '';
  readonly pieces: { readonly from: number; readonly to: number; readonly at: number }[] = [];

  constructor(private readonly source: string) {}

  /** Copy the source range `[from, to)`, applying `edits` (offsets into the source) inside it. */
  copy(from: number, to: number, edits: readonly TextEdit[] = []): void {
    let cursor = from;
    for (const edit of edits) {
      if (edit.start < from || edit.end > to) continue;
      this.piece(cursor, edit.start);
      this.text += edit.text;
      cursor = edit.end;
    }
    this.piece(cursor, to);
  }

  insert(text: string): void {
    this.text += text;
  }

  private piece(from: number, to: number): void {
    if (to <= from) return;
    this.pieces.push({ from, to, at: this.text.length });
    this.text += this.source.slice(from, to);
  }
}

/**
 * Copy `source` without the items `removed` into `out`. Every kept item
 * keeps the whitespace after it, except the last, which takes the file's
 * trailing whitespace; so a removed item takes the separator after it, or
 * the one before it when it was last. `edits` apply inside kept items.
 */
function keepItems(
  out: OutputBuilder,
  source: string,
  items: readonly Item[],
  removed: ReadonlySet<Item>,
  edits: readonly TextEdit[],
): void {
  const kept = items.filter((item) => !removed.has(item));
  const last = items.at(-1);
  out.copy(0, items[0]?.start ?? source.length);
  for (const [index, item] of kept.entries()) {
    const next = items[items.indexOf(item) + 1];
    out.copy(item.start, item.end, edits);
    if (index === kept.length - 1 || next === undefined) {
      out.copy(last?.end ?? source.length, source.length);
    } else {
      out.copy(item.end, next.start);
    }
  }
}

/** The diagnostics of a scan that make block boundaries uncertain. */
function structuralErrors(
  diagnostics: readonly SfcDiagnostic[],
  templates: readonly SfcBlock[],
): readonly SfcDiagnostic[] {
  return diagnostics.filter(
    (entry) =>
      entry.severity === 'error' &&
      entry.code !== 'sfc.script_syntax' &&
      !templates.some(
        (block) => entry.start >= block.contentStart && entry.end <= block.contentEnd,
      ),
  );
}

/** A block's body text. */
function bodyOf(source: string, block: SfcBlock): string {
  return source.slice(block.bodyStart, block.contentEnd);
}

/**
 * The folder files of the single-file component `source` at the component
 * path `file`, or why it cannot be split without loss. Relative specifiers in
 * `<script>` and `<script setup>` are relocated to the folder.
 */
export function splitSfc(source: string, file: string): SfcSplit {
  const parsed = parseSfcBlocks(source, file);
  const templates = [parsed.template, parsed.templateStatic].filter((block) => block !== null);
  const structural = structuralErrors(parsed.diagnostics, templates);
  if (structural.length > 0) {
    return Object.freeze({ ok: false, refusal: 'invalid_blocks', diagnostics: structural });
  }
  const global = parsed.styles.filter((style) => !style.scoped);
  const scoped = parsed.styles.filter((style) => style.scoped);
  if (global.length > 1 || scoped.length > 1) {
    const diagnostics = new SfcDiagnostics(file);
    for (const extra of [...global.slice(1), ...scoped.slice(1)]) {
      diagnostics.error(
        'sfc.duplicate_block',
        'A component folder holds one <style> and one <style scoped>; merge them first',
        extra.start,
        extra.contentStart,
      );
    }
    return Object.freeze({ ok: false, refusal: 'style_count', diagnostics: diagnostics.list() });
  }

  const paths = sfcFolderPaths(file);
  const toFolder = toFolderPaths(file);
  const { script, scriptSetup: setup } = parsed;
  const scriptBody = script === null ? undefined : bodyOf(source, script);
  const scriptEdits =
    scriptBody === undefined ? [] : relocationEdits(scriptBody, file, paths.script, toFolder);
  const setupEdits =
    setup === null ? [] : relocationEdits(setup.content, file, paths.template, toFolder);
  if (scriptEdits === undefined || setupEdits === undefined) {
    return Object.freeze({
      ok: false,
      refusal: 'script_syntax',
      diagnostics: parsed.diagnostics.filter((entry) => entry.code === 'sfc.script_syntax'),
    });
  }

  const blocks = [setup, ...templates, script, ...parsed.styles].filter((block) => block !== null);
  const items = itemsOf(source, blocks);
  const moved = new Set(
    items.filter(
      (item) => item.block !== null && (item.block === script || item.block.type === 'style'),
    ),
  );
  const setupAt = setup?.contentStart ?? 0;
  const templateOut = new OutputBuilder(source);
  keepItems(
    templateOut,
    source,
    items,
    moved,
    setupEdits.map((edit) => ({ ...edit, start: edit.start + setupAt, end: edit.end + setupAt })),
  );
  const outputs: { readonly file: string; readonly out: OutputBuilder }[] = [
    { file: paths.template, out: templateOut },
  ];
  const bodyOut = (block: SfcBlock | undefined, path: string, edits: readonly TextEdit[]) => {
    if (block === undefined) return undefined;
    const out = new OutputBuilder(source);
    out.copy(
      block.bodyStart,
      block.contentEnd,
      edits.map((edit) => ({
        ...edit,
        start: edit.start + block.bodyStart,
        end: edit.end + block.bodyStart,
      })),
    );
    outputs.push({ file: path, out });
    return out.text;
  };
  const scriptText = bodyOut(script ?? undefined, paths.script, scriptEdits);
  const style = bodyOut(global[0], paths.style, []);
  const scopedStyle = bodyOut(scoped[0], paths.scopedStyle, []);
  const template = templateOut.text;
  const positionOf = (offset: number): SfcFolderPosition | undefined => {
    for (const { file: target, out } of outputs) {
      const piece = out.pieces.find((entry) => offset >= entry.from && offset < entry.to);
      if (piece !== undefined) return { file: target, offset: piece.at + offset - piece.from };
    }
    return undefined;
  };
  return Object.freeze({
    ok: true,
    folder: Object.freeze({
      template,
      ...(scriptText === undefined ? {} : { script: scriptText }),
      ...(style === undefined ? {} : { style }),
      ...(scopedStyle === undefined ? {} : { scopedStyle }),
    }),
    positionOf,
  });
}

/** Why {@link joinSfc} refused a folder. */
export type SfcJoinRefusal =
  /** The template file's blocks do not scan cleanly. */
  | 'invalid_blocks'
  /** The template file holds a `<script>` or `<style>`, whose home is a file of its own. */
  | 'folder_block'
  /** `x.ts` or `<script setup>` does not parse, so its specifiers cannot be relocated. */
  | 'script_syntax'
  /**
   * `x.ts` holds `</script` or a style file `</style` (in a string or a
   * comment, legal in a file of its own), which would end its block early
   * in the single file.
   */
  | 'end_tag';

/** The outcome of {@link joinSfc}. */
export type SfcJoin =
  | { readonly ok: true; readonly source: string }
  | {
      readonly ok: false;
      readonly refusal: SfcJoinRefusal;
      /** The diagnostics that explain the refusal, positioned in the folder's files. */
      readonly diagnostics: readonly SfcDiagnostic[];
    };

/**
 * Report a `<script>` or `<style>` block inside a folder's template file:
 * each has a file of its own there (`sfc.folder_block`, at the start tag).
 */
export function reportFolderBlocks(blocks: readonly SfcBlock[], diagnostics: SfcDiagnostics): void {
  for (const block of blocks) {
    diagnostics.error(
      'sfc.folder_block',
      block.type === 'style'
        ? 'In a component folder, <style> is the file x.css and <style scoped> the file x.scoped.css'
        : 'In a component folder, <script> is the file x.ts beside x.jsails',
      block.start,
      block.contentStart,
    );
  }
}

/** The offset in a text before `edits` of the offset `offset` in the text after them. */
function offsetBeforeEdits(edits: readonly TextEdit[], offset: number): number {
  let delta = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    const start = edit.start + delta;
    if (offset < start) break;
    if (offset < start + edit.text.length) return edit.start;
    delta += edit.text.length - (edit.end - edit.start);
  }
  return offset - delta;
}

/**
 * Report every raw-text end tag (`</script`, `</style`) in `text`, the body a
 * join wraps in a `<name>` block, which would end the block there:
 * `sfc.raw_text_end_tag`, positioned in the folder file through `edits` (the
 * relocation applied to it) and `base` (where the body starts in that file).
 */
function reportRawTextEndTags(
  diagnostics: SfcDiagnostics,
  text: string,
  name: 'script' | 'style',
  edits: readonly TextEdit[] = [],
  base = 0,
): void {
  for (
    let found = findRawTextEndTag(text, name);
    found !== undefined;
    found = findRawTextEndTag(text, name, found.end)
  ) {
    const start = base + offsetBeforeEdits(edits, found.start);
    diagnostics.error(
      'sfc.raw_text_end_tag',
      `This text ends a <${name}> block in one file; split the end tag, as in <\\/${name}>`,
      start,
      start + name.length + 2,
    );
  }
}

/**
 * The single file of the component folder `folder` at the component path
 * `file`, or why it cannot be joined. Relative specifiers in `x.ts` and
 * `<script setup>` are relocated from the folder to the file. A folder
 * whose `x.ts` holds `</script`, or whose style file holds `</style`, is
 * refused: the single file's block would end there, and nothing of the
 * folder may be lost (`splitSfc` of the result gives the folder back).
 */
export function joinSfc(folder: SfcFolderSources, file: string): SfcJoin {
  const paths = sfcFolderPaths(file);
  const toSingle = toSinglePaths(file);
  const source = folder.template;
  const parsed = parseSfcBlocks(source, paths.template);
  const templates = [parsed.template, parsed.templateStatic].filter((block) => block !== null);
  const structural = structuralErrors(parsed.diagnostics, templates);
  if (structural.length > 0) {
    return Object.freeze({ ok: false, refusal: 'invalid_blocks', diagnostics: structural });
  }
  const misplaced = [parsed.script, ...parsed.styles].filter((block) => block !== null);
  if (misplaced.length > 0) {
    const diagnostics = new SfcDiagnostics(paths.template);
    reportFolderBlocks(misplaced, diagnostics);
    return Object.freeze({ ok: false, refusal: 'folder_block', diagnostics: diagnostics.list() });
  }
  const setup = parsed.scriptSetup;
  const scriptEdits =
    folder.script === undefined ? [] : relocationEdits(folder.script, paths.script, file, toSingle);
  const setupEdits =
    setup === null ? [] : relocationEdits(setup.content, paths.template, file, toSingle);
  if (scriptEdits === undefined || setupEdits === undefined) {
    const diagnostics = new SfcDiagnostics(paths.script);
    if (scriptEdits === undefined) {
      diagnostics.error('sfc.script_syntax', 'The script is not valid TypeScript', 0, 0);
    }
    return Object.freeze({
      ok: false,
      refusal: 'script_syntax',
      diagnostics: [
        ...diagnostics.list(),
        ...parsed.diagnostics.filter((entry) => entry.code === 'sfc.script_syntax'),
      ],
    });
  }

  const script =
    folder.script === undefined ? undefined : applyTextEdits(folder.script, scriptEdits);
  const endTags: SfcDiagnostic[] = [];
  const sinks: readonly [
    string,
    string | undefined,
    'script' | 'style',
    readonly TextEdit[],
    number,
  ][] = [
    [
      paths.template,
      setup === null ? undefined : applyTextEdits(setup.content, setupEdits),
      'script',
      setupEdits,
      setup?.contentStart ?? 0,
    ],
    [paths.script, script, 'script', scriptEdits, 0],
    [paths.style, folder.style, 'style', [], 0],
    [paths.scopedStyle, folder.scopedStyle, 'style', [], 0],
  ];
  for (const [path, text, name, edits, base] of sinks) {
    if (text === undefined) continue;
    const diagnostics = new SfcDiagnostics(path);
    reportRawTextEndTags(diagnostics, text, name, edits, base);
    endTags.push(...diagnostics.list());
  }
  if (endTags.length > 0) {
    return Object.freeze({ ok: false, refusal: 'end_tag', diagnostics: endTags });
  }

  const blocks = [setup, ...templates].filter((block) => block !== null);
  const items = itemsOf(source, blocks);
  const firstBlock = items.find((item) => item.block !== null);
  const lastEnd = items.at(-1)?.end ?? source.length;
  let out = '';
  let cursor = 0;
  const copy = (to: number): void => {
    const piece = source.slice(cursor, to);
    out +=
      setup !== null && cursor <= setup.contentStart && to >= setup.contentEnd
        ? piece.slice(0, setup.contentStart - cursor) +
          applyTextEdits(setup.content, setupEdits) +
          piece.slice(setup.contentEnd - cursor)
        : piece;
    cursor = to;
  };
  if (script !== undefined) {
    const at = firstBlock?.start ?? lastEnd;
    copy(at);
    out += `<script lang="ts">\n${script}</script>\n\n`;
  }
  copy(lastEnd);
  if (folder.style !== undefined) out += `\n\n<style>\n${folder.style}</style>`;
  if (folder.scopedStyle !== undefined) out += `\n\n<style scoped>\n${folder.scopedStyle}</style>`;
  copy(source.length);
  return Object.freeze({ ok: true, source: out });
}

/** A component of a project: its path, its layout and the files it has. */
export interface SfcComponentEntry {
  /** The component path (`pages/about.jsails`), whichever layout it uses. */
  readonly file: string;
  readonly layout: 'file' | 'folder';
  /**
   * The project paths of its files that exist, sorted: the `.jsails` file
   * and its server module, or the folder's members.
   */
  readonly files: readonly string[];
}

/** The components of a project, and the conflicts found grouping them. */
export interface SfcComponentIndex {
  /** Every component, sorted by path; a conflicting one is left out. */
  readonly components: readonly SfcComponentEntry[];
  /** `sfc.layout_conflict` for each file whose folder exists beside it. */
  readonly diagnostics: readonly SfcDiagnostic[];
}

/**
 * Group a project's file paths (normalized posix, relative to the root) into
 * `.jsails` components. A `.jsails` file named after its directory is a
 * folder's template, every other `.jsails` file a single file; a single file
 * and a folder that share a component path (`D/x.jsails` beside
 * `D/x/x.jsails`) are both left out and reported as `sfc.layout_conflict` on
 * the single file.
 */
export function sfcComponents(paths: readonly string[]): SfcComponentIndex {
  const present = new Set(paths);
  const folders = new Map<string, string[]>();
  const singles = new Map<string, string[]>();
  for (const path of [...present].sort()) {
    const member = sfcFolderMember(path);
    if (member !== undefined && present.has(member.template)) {
      const files = folders.get(member.component) ?? [];
      files.push(path);
      folders.set(member.component, files);
    } else if (path.endsWith('.jsails')) {
      const server = sfcServerPath(path);
      singles.set(path, present.has(server) ? [path, server].sort() : [path]);
    }
  }
  const components: SfcComponentEntry[] = [];
  const conflicts: string[] = [];
  for (const [file, files] of singles) {
    if (folders.has(file)) {
      conflicts.push(file);
      continue;
    }
    components.push(Object.freeze({ file, layout: 'file', files: Object.freeze(files) }));
  }
  for (const [file, files] of folders) {
    if (singles.has(file)) continue;
    components.push(Object.freeze({ file, layout: 'folder', files: Object.freeze(files) }));
  }
  components.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const diagnostics = conflicts.flatMap((file) => {
    const sink = new SfcDiagnostics(file);
    sink.error(
      'sfc.layout_conflict',
      'A component folder of the same name stands beside this file; keep one layout',
      0,
      0,
    );
    return sink.list();
  });
  return Object.freeze({
    components: Object.freeze(components),
    diagnostics: Object.freeze(diagnostics),
  });
}
