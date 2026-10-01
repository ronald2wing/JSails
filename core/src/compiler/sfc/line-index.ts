/**
 * Offset to line/column conversion with ECMAScript line terminators, for the
 * `.jsails` column maps.
 *
 * A source map's line numbers (ECMA-426), V8's stack-trace positions, oxc's
 * output map and TypeScript's `computeLineStarts` all break lines at the
 * ECMAScript terminators: LF, CR, CRLF (one break), U+2028 and U+2029. A map
 * that broke only at LF would disagree with every one of them on a file with
 * a lone CR (a template literal or comment from an old Mac editor) or a
 * U+2028 in a string, and every mapping after it would land on the wrong
 * line. Columns are UTF-16 code units, the unit of a JavaScript string index
 * and of a source-map column. Everything here is 0-based; callers that print
 * 1-based positions add one.
 */

/** A 0-based line and UTF-16 column. */
export interface LinePosition {
  readonly line: number;
  readonly column: number;
}

/** The line starts of one text, and conversions between offsets and positions. */
export interface LineIndex {
  /** The offset of the first code unit of each line; `lineStarts[0]` is 0. */
  readonly lineStarts: readonly number[];
  /** The length of the indexed text. */
  readonly length: number;
  /** The position of `offset`, clamped to `[0, length]`. */
  positionAt(offset: number): LinePosition;
  /**
   * The offset of `position`, or `undefined` when its line does not exist or
   * its column runs past the end of that line's content (the terminator
   * itself is not addressable).
   */
  offsetAt(position: LinePosition): number | undefined;
}

const LF = 0x0a;
const CR = 0x0d;
const LS = 0x2028;
const PS = 0x2029;

/** The offsets at which each line of `text` starts, under ECMAScript terminators. */
function computeLineStarts(text: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === CR) {
      if (text.charCodeAt(index + 1) === LF) {
        index += 1;
      }
      starts.push(index + 1);
    } else if (code === LF || code === LS || code === PS) {
      starts.push(index + 1);
    }
  }
  return Object.freeze(starts);
}

/** The offset at which the content of line `line` ends (before its terminator). */
function contentEnd(text: string, starts: readonly number[], line: number): number {
  const next = starts[line + 1];
  if (next === undefined) {
    return text.length;
  }
  let end = next - 1;
  if (text.charCodeAt(end) === LF && end > 0 && text.charCodeAt(end - 1) === CR) {
    end -= 1;
  }
  return end;
}

/** Build the {@link LineIndex} of `text`. */
export function lineIndex(text: string): LineIndex {
  const lineStarts = computeLineStarts(text);
  const length = text.length;
  return Object.freeze({
    lineStarts,
    length,
    positionAt(offset: number): LinePosition {
      const target = Math.min(Math.max(offset, 0), length);
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >>> 1;
        if ((lineStarts[mid] ?? 0) <= target) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      return Object.freeze({ line: low, column: target - (lineStarts[low] ?? 0) });
    },
    offsetAt(position: LinePosition): number | undefined {
      const start = lineStarts[position.line];
      if (start === undefined || !Number.isSafeInteger(position.column) || position.column < 0) {
        return undefined;
      }
      const offset = start + position.column;
      return offset <= contentEnd(text, lineStarts, position.line) ? offset : undefined;
    },
  });
}
