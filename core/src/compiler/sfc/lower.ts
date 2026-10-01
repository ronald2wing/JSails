/**
 * `lowerSfc`, the one entry of the `.jsails` compiler (sfc-plan §3.1): a
 * component's text and project path in, its shadow module and diagnostics
 * out. A component is one file, or a folder of files, one per block
 * (`layout.ts`); both lower through the same passes over one offset space
 * (`source-space.ts`) and give the same shadow. A folder's diagnostics name
 * the file that holds the block, and the relative specifiers it copies from
 * its folder files are relocated to the component's path, where its module
 * stands, so the bytes do not depend on the layout, except that a specifier
 * naming a file inside the folder (its server module) names it there.
 *
 * It is pure and deterministic: no file system, no absolute paths, and names
 * the file leaves free are resolved through the {@link NameResolver} it is
 * given. The kind comes from the path (`sfcKind`); the function kinds lower
 * in `compile-page.ts`, a live component in `compile-live.ts`, and a kind
 * whose lowering has not landed is reported as `sfc.not_lowered` rather than
 * compiled to a wrong module. The shadow's
 * text is what TypeScript checks and what the build compiles ("check what
 * you ship"); `null` means an error stopped code generation.
 *
 * Its `<style>` blocks come out as the CSS the app's one stylesheet holds
 * (`style.ts`), and its template's outermost elements carry the scope id of
 * its path, whether or not it has a `<style scoped>`, so a parent's scoped
 * rules end at its root. The module never depends on what a style block
 * holds; a style error still stops code generation, like any other error.
 */

import { parseSync } from 'rolldown/utils';

import { sfcKind, type SfcKind } from '../conventions.js';
import {
  checkScriptBlock,
  fileBlock,
  parseSfcBlocks,
  type SfcFile,
  type SfcStyleBlock,
} from './blocks.js';
import { compileLiveKind } from './compile-live.js';
import { compileFunctionKind, type SfcImport } from './compile-page.js';
import { SfcDiagnostics, type SfcDiagnostic } from './diagnostics.js';
import { isFunctionKind, kindSpec } from './kinds.js';
import { reportFolderBlocks, sfcFolderPaths, type SfcFolderSources } from './layout.js';
import { EMPTY_RESOLVER, type NameResolver } from './name-resolver.js';
import { literalEdits, specifierLiterals } from './relocate.js';
import {
  editShadow,
  generatedToOriginal,
  isVerbatimRange,
  type Shadow,
  type ShadowEdit,
} from './segments.js';
import { sfcBlockHashes, type SfcBlockHashes } from './block-hashes.js';
import { SourceSpace } from './source-space.js';
import { lowerStyles, sfcScopeId, type SfcStyle } from './style.js';

export type { SfcImport } from './compile-page.js';
export type { SfcFolderSources } from './layout.js';
export type { SfcBlockHashes, SfcChange } from './block-hashes.js';
export type { SfcStyle } from './style.js';

/** Options of {@link lowerSfc}. */
export interface LowerSfcOptions {
  /** Resolves the names the file leaves free; resolves nothing when omitted. */
  readonly resolver?: NameResolver;
}

/** A lowered `.jsails` component. */
export interface SfcLowering {
  /** The component's project path (`pages/about.jsails`, also for the folder `pages/about/`). */
  readonly file: string;
  /** Whether the component is one file or a folder. */
  readonly layout: 'file' | 'folder';
  readonly kind: SfcKind;
  /** The shadow module, or `null` when an error stopped code generation. */
  readonly shadow: Shadow | null;
  /** The shadow's text: the TSX the build compiles; `''` without a shadow. */
  readonly tsx: string;
  /**
   * The scope id of its path (`sfcScopeId`), which its template's outermost
   * elements carry as `data-s`.
   */
  readonly scopeId: string;
  /** Its `<style>` blocks in source order, as the stylesheet holds them; empty after an error. */
  readonly styles: readonly SfcStyle[];
  /** The names the module exports: `<script>`'s, then `default`. */
  readonly exports: readonly string[];
  /** The resolved names the module imports. */
  readonly imports: readonly SfcImport[];
  readonly diagnostics: readonly SfcDiagnostic[];
  /**
   * What a dev server compares to tell a style-only edit from a module
   * change (`sfcChange`, `block-hashes.ts`).
   */
  readonly hashes: SfcBlockHashes;
}

/** A component read into its offset space, its blocks scanned. */
interface ReadComponent {
  readonly layout: 'file' | 'folder';
  readonly parsed: SfcFile;
  readonly space: SourceSpace;
  readonly diagnostics: SfcDiagnostics;
}

function readFile(source: string, file: string): ReadComponent {
  const space = new SourceSpace([{ file, text: source }]);
  const parsed = parseSfcBlocks(source, file);
  const diagnostics = new SfcDiagnostics(space);
  diagnostics.addAll(parsed.diagnostics);
  return { layout: 'file', parsed, space, diagnostics };
}

/**
 * Read a folder: its template file scanned at offset 0, then `x.ts` and the
 * style files as whole-file blocks, each at its own place in the space. A
 * `<script>` or `<style>` written in the template file is `sfc.folder_block`.
 */
function readFolder(folder: SfcFolderSources, file: string): ReadComponent {
  const paths = sfcFolderPaths(file);
  const parts: { readonly role: 'script' | 'style' | 'scopedStyle'; readonly text: string }[] = [];
  if (folder.script !== undefined) parts.push({ role: 'script', text: folder.script });
  if (folder.style !== undefined) parts.push({ role: 'style', text: folder.style });
  if (folder.scopedStyle !== undefined) {
    parts.push({ role: 'scopedStyle', text: folder.scopedStyle });
  }
  const space = new SourceSpace([
    { file: paths.template, text: folder.template },
    ...parts.map((part) => ({ file: paths[part.role], text: part.text })),
  ]);
  const scanned = parseSfcBlocks(folder.template, paths.template);
  const diagnostics = new SfcDiagnostics(space);
  diagnostics.addAll(scanned.diagnostics);
  reportFolderBlocks(
    [scanned.script, ...scanned.styles].filter((block) => block !== null),
    diagnostics,
  );
  let script = null;
  const styles: SfcStyleBlock[] = [];
  for (const part of parts) {
    const placed = space.files.find((entry) => entry.file === paths[part.role]);
    const base = placed?.base ?? 0;
    if (part.role === 'script') {
      script = fileBlock('script', part.text, paths.script, base);
      checkScriptBlock(script, diagnostics);
    } else {
      styles.push(fileBlock('style', part.text, paths[part.role], base) as SfcStyleBlock);
    }
  }
  const parsed: SfcFile = Object.freeze({
    file,
    script,
    scriptSetup: scanned.scriptSetup,
    template: scanned.template,
    templateStatic: scanned.templateStatic,
    styles: Object.freeze(styles),
    header: scanned.header,
    diagnostics: Object.freeze([]),
  });
  return { layout: 'folder', parsed, space, diagnostics };
}

/**
 * Lower the `.jsails` component at the normalized posix project path `file`
 * (`pages/blog/[slug].jsails`): the text of the single file, or the texts of
 * the folder `pages/blog/[slug]/` (see {@link SfcFolderSources}). Throws
 * `sfc_style.invalid_path` when `file` is not such a path (`sfcScopeId`).
 */
export function lowerSfc(
  source: string | SfcFolderSources,
  file: string,
  options: LowerSfcOptions = {},
): SfcLowering {
  const scopeId = sfcScopeId(file);
  const kind = sfcKind(file);
  const { layout, parsed, space, diagnostics } =
    typeof source === 'string' ? readFile(source, file) : readFolder(source, file);
  const styles = lowerStyles(parsed.styles, { file, scopeId, space, diagnostics });
  const result = (
    shadow: Shadow | null,
    exports: readonly string[],
    imports: readonly SfcImport[],
  ): SfcLowering => {
    const lowered = {
      file,
      layout,
      kind,
      shadow,
      styles: diagnostics.hasErrors ? Object.freeze([]) : styles,
      exports: Object.freeze([...exports]),
      imports: Object.freeze([...imports]),
      diagnostics: diagnostics.list(),
    };
    return Object.freeze({
      ...lowered,
      tsx: shadow?.text ?? '',
      scopeId,
      hashes: sfcBlockHashes(lowered, space),
    });
  };

  const spec = kindSpec(kind);
  if (!isFunctionKind(spec) && spec.kind !== 'live') {
    diagnostics.error(
      'sfc.not_lowered',
      `This file compiles to ${spec.compilesTo}, whose lowering has not landed`,
      0,
      Math.min(1, space.files[0]?.text.length ?? 0),
    );
    return result(null, [], []);
  }
  if (parsed.templateStatic !== null && spec.kind !== 'live') {
    diagnostics.error(
      'sfc.block_kind',
      '<template static> is the static-export form of a live component',
      parsed.templateStatic.start,
      parsed.templateStatic.contentStart,
    );
  }
  const template = parsed.template;
  if (diagnostics.hasErrors || template === null) return result(null, [], []);

  const input = {
    file: parsed,
    template,
    space,
    resolver: options.resolver ?? EMPTY_RESOLVER,
    diagnostics,
    scopeId,
  };
  const lowered = isFunctionKind(spec)
    ? compileFunctionKind({ ...input, spec })
    : compileLiveKind(input);
  if (lowered === undefined) return result(null, [], []);
  const shadow =
    layout === 'folder' ? withRelocatedSpecifiers(lowered.shadow, file) : lowered.shadow;
  return result(shadow, lowered.exports, lowered.imports);
}

/**
 * The folder component's shadow with every relative specifier it copied
 * from a folder file rewritten to name the same file from the component's
 * path, where the shadow and the compiled module stand (`relocate.ts`). Each
 * rewritten literal becomes an Atom owned by the literal it replaces.
 *
 * A specifier names the file where it stands: the folder's server module
 * `D/x/x.server.ts` is imported from `D/x.jsails` as `./x/x.server.js`, not
 * as the `./x.server.js` of the single layout, because nothing moves when a
 * folder is compiled. So the two layouts compile to the same bytes except
 * for a specifier naming a file inside the folder.
 */
function withRelocatedSpecifiers(shadow: Shadow, file: string): Shadow {
  const parsed = parseSync('shadow.tsx', shadow.text, { lang: 'tsx', sourceType: 'module' });
  const edits: ShadowEdit[] = [];
  for (const literal of specifierLiterals(parsed.program)) {
    const at = generatedToOriginal(shadow, literal.start);
    if (at.fidelity !== 'exact' || !isVerbatimRange(shadow, literal.start, literal.end)) continue;
    const from = shadow.sources[at.source]?.name;
    if (from === undefined || from === file) continue;
    edits.push(...literalEdits(shadow.text, [literal], from, file));
  }
  return edits.length === 0 ? shadow : editShadow(shadow, edits);
}
