/**
 * The cursor the kind lowerings write a shadow's body with: every chunk is a
 * Verbatim copy, an Alias for a source name, or an Atom owned by a source
 * range (`segments.ts`), so the body has no unmapped text by construction.
 *
 * The writer tracks the generated length, so a lowering can mark generated
 * ranges (the render function's body) for the scope pass, and it keeps every
 * span non-empty: an owner range that is empty (an insertion point) widens to
 * the next code unit, or the previous one at the end of the file.
 *
 * Offsets are offsets of the component's {@link SourceSpace}: each chunk
 * names the file its range lies in, so a folder component's shadow maps its
 * `<script>` copy to `x/x.ts` and its template to `x/x.jsails`.
 */

import {
  ALIAS_FEATURES,
  ATOM_FEATURES,
  alias,
  atom,
  verbatim,
  type MappedSegment,
} from './segments.js';
import type { SourceSpace, SpaceFile } from './source-space.js';
import { sourceSpan, type SourceSpan } from './source-span.js';

/** Appends mapped segments to a shadow body. */
export class SegmentWriter {
  private readonly parts: MappedSegment[] = [];
  private size = 0;

  constructor(readonly space: SourceSpace) {}

  /** The generated length so far: the offset the next chunk starts at. */
  get length(): number {
    return this.size;
  }

  /** The segments written, in order. */
  segments(): readonly MappedSegment[] {
    return this.parts;
  }

  /** The source text of `[start, end)`. */
  text(start: number, end: number): string {
    return this.space.slice(start, end);
  }

  /** Copy the source range `[start, end)`; an empty range writes nothing. */
  verbatim(start: number, end: number): void {
    if (end > start) {
      const file = this.space.fileOf(start, end);
      this.push(verbatim(file.source, sourceSpan(start - file.base, end - file.base)));
    }
  }

  /** Generated `text` that stands for the source name at `[start, end)`. */
  alias(text: string, start: number, end: number, features: number = ALIAS_FEATURES): void {
    if (text !== '') {
      const file = this.space.fileOf(start, end);
      this.push(alias(text, file.source, this.span(file, start, end), features));
    }
  }

  /** Generated `text` owned by the source range `[start, end)`. */
  atom(text: string, start: number, end: number, features: number = ATOM_FEATURES): void {
    if (text !== '') {
      const file = this.space.fileOf(start, end);
      this.push(atom(text, file.source, this.span(file, start, end), features));
    }
  }

  /** Generated `text` owned by `owner`. */
  atomOf(text: string, owner: SourceSpan): void {
    this.atom(text, owner.start, owner.end);
  }

  /** `[start, end)` local to `file`, an empty range widened to one code unit. */
  private span(file: SpaceFile, start: number, end: number): SourceSpan {
    const from = start - file.base;
    if (end > start) {
      return sourceSpan(from, end - file.base);
    }
    const length = file.text.length;
    return from < length ? sourceSpan(from, from + 1) : sourceSpan(length - 1, length);
  }

  private push(segment: MappedSegment): void {
    this.parts.push(segment);
    this.size += segment.text.length;
  }
}
