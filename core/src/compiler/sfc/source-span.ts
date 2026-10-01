/**
 * The source span every `.jsails` compiler stage shares: a half-open range of
 * UTF-16 code-unit offsets into one source text.
 *
 * The parser (`template-parse.ts`, `blocks.ts`) records one on every block,
 * node, attribute name and expression it produces; the segment model
 * (`segments.ts`) takes them as the source side of every mapping. Offsets,
 * not line and column, are the currency between stages, because a JavaScript
 * string index, the source-map column unit (ECMA-426) and the `utf-16`
 * position encoding TypeScript's content-mapper protocol negotiates are the
 * same unit. Line and column are derived only at the edges, through
 * `line-index.ts`.
 */

/**
 * A half-open range `[start, end)` of UTF-16 code-unit offsets into one source
 * text. `start <= end`; an empty span (`start === end`) is an insertion point.
 */
export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * A frozen {@link SourceSpan}. Throws a `RangeError` (a programming error, not
 * an author error) unless both offsets are non-negative safe integers with
 * `start <= end`.
 */
export function sourceSpan(start: number, end: number): SourceSpan {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError('a source span is [start, end) with 0 <= start <= end');
  }
  return Object.freeze({ start, end });
}
