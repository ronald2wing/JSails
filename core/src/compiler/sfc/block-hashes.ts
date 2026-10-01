/**
 * The two hashes of a lowered `.jsails` component that tell a dev server
 * what an edit changed (sfc-plan §3.7, KRN-19): `module`, over everything
 * the compiled module and its source map are made of, and `style`, over the
 * CSS its `<style>` blocks contribute to the app's stylesheet.
 *
 * The hashes are taken over what the component lowers to, not over its
 * source blocks, so they are exact by construction: an edit that leaves the
 * module's text, span table, exports, imports and diagnostics as they were
 * is not a module change, wherever in the file it happened. That makes a
 * style-only edit `'style'` because the module never depends on what a style
 * block holds (`lower.ts`), and it makes a style edit that moves a later
 * block `'module'`, because that block's spans move.
 *
 * A map gives positions as lines and columns, which also depend on the line
 * breaks before a mapped position: replacing a character of a style body
 * above the template with a line break moves no offset but every line after
 * it. So the module hash also covers each file's line starts up to the last
 * offset a span or a diagnostic points to. What it does not cover is the
 * map's `sourcesContent`, the source text itself: after a `'style'` change
 * a module kept from before carries the old text there, as with Vue's
 * plugin.
 */

import { createHash } from 'node:crypto';

import type { SfcKind } from '../conventions.js';
import type { SfcImport } from './compile-page.js';
import type { SfcDiagnostic } from './diagnostics.js';
import { lineIndex } from './line-index.js';
import type { Shadow } from './segments.js';
import type { SourceSpace } from './source-space.js';
import type { SfcStyle } from './style.js';

/** What the hashes of a component are taken over: its lowering, before they are added to it. */
export interface SfcHashInput {
  readonly file: string;
  readonly layout: 'file' | 'folder';
  readonly kind: SfcKind;
  readonly shadow: Shadow | null;
  readonly styles: readonly SfcStyle[];
  readonly exports: readonly string[];
  readonly imports: readonly SfcImport[];
  readonly diagnostics: readonly SfcDiagnostic[];
}

/** The two hashes of a lowered component (base64url SHA-256). */
export interface SfcBlockHashes {
  /** Over the compiled module and its map: the shadow, exports, imports and diagnostics. */
  readonly module: string;
  /** Over the CSS its `<style>` blocks contribute. */
  readonly style: string;
}

/**
 * What an edit changed: nothing, only the component's CSS, or its module
 * (its CSS may have changed too).
 */
export type SfcChange = 'none' | 'style' | 'module';

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('base64url');
}

/** The last local offset of each file that a span or a diagnostic points to. */
function referencedEnds(input: SfcHashInput): ReadonlyMap<string, number> {
  const ends = new Map<string, number>();
  const reach = (file: string, end: number): void => {
    ends.set(file, Math.max(ends.get(file) ?? 0, end));
  };
  if (input.shadow !== null) {
    for (const span of input.shadow.spans) {
      const source = input.shadow.sources[span.source];
      if (source !== undefined) reach(source.name, span.originalEnd);
    }
  }
  for (const diagnostic of input.diagnostics) {
    reach(diagnostic.file, diagnostic.end);
    for (const edit of diagnostic.fix?.edits ?? []) reach(diagnostic.file, edit.end);
    if (diagnostic.related !== undefined) {
      reach(diagnostic.related.file ?? diagnostic.file, diagnostic.related.end);
    }
  }
  return ends;
}

/**
 * The hashes of the component `input` lowered from the files of `space`
 * (see the module comment).
 */
export function sfcBlockHashes(input: SfcHashInput, space: SourceSpace): SfcBlockHashes {
  const ends = referencedEnds(input);
  const lineStarts = space.files
    .filter((entry) => ends.has(entry.file))
    .map((entry) => {
      const end = ends.get(entry.file) ?? 0;
      return [
        entry.file,
        lineIndex(entry.text).lineStarts.filter((start) => start > 0 && start <= end),
      ];
    });
  const shadow =
    input.shadow === null
      ? null
      : {
          text: input.shadow.text,
          bodyStart: input.shadow.bodyStart,
          bodyEnd: input.shadow.bodyEnd,
          sources: input.shadow.sources.map((source) => source.name),
          spans: input.shadow.spans,
        };
  return Object.freeze({
    module: digest([
      input.file,
      input.layout,
      input.kind,
      shadow,
      input.exports,
      input.imports,
      input.diagnostics,
      lineStarts,
    ]),
    style: digest(input.styles),
  });
}

/** What changed between two lowerings of one component, by their {@link SfcBlockHashes}. */
export function sfcChange(previous: SfcBlockHashes, next: SfcBlockHashes): SfcChange {
  if (previous.module !== next.module) return 'module';
  return previous.style === next.style ? 'none' : 'style';
}
