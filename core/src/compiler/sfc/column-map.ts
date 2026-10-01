/**
 * Column-accurate version 3 source maps for `.jsails` shadows, and their
 * composition with oxc's output map.
 *
 * Two maps are derived from a shadow's span table (`segments.ts`):
 *
 * - {@link shadowSourceMap}, shadow TSX to `.jsails`, for a bundler plugin
 *   that hands the TSX to the next transform. A source map has no ranges, so
 *   a Verbatim span gets a mapping at every token boundary (each identifier,
 *   whitespace run and punctuation character), which is a superset of the
 *   positions any later map or stack trace can point at; an Alias or Atom
 *   gets one at its start. Every generated line inside a span starts with a
 *   mapping, and the first footer position gets an explicit unmapped one, so
 *   no generated text is attributed to whatever mapping preceded it.
 * - {@link composeSourceMap}, compiled JavaScript to `.jsails`, from the map
 *   `rolldown/utils`' `transformSync` returns (JavaScript to shadow). rolldown
 *   1.2.15 ignores the typed `typescript.inputMap` option (`docs/design/sfc.md`
 *   §8), so composition is done here: each oxc mapping's shadow position is
 *   looked up in the span table, which is exact for Verbatim spans, and every
 *   oxc mapping that lands in the header or footer becomes unmapped.
 *
 * Lines break at ECMAScript terminators and columns are UTF-16 code units
 * (`line-index.ts`), which is what oxc and V8 use.
 */

import { lineIndex, type LineIndex, type LinePosition } from './line-index.js';
import { SegmentMapError } from './segments-error.js';
import { generatedToOriginal, SpanKind, type Shadow, type Span } from './segments.js';
import { decodeMappings, encodeMappings, type DecodedMappings, type MappingPoint } from './vlq.js';

/** A version 3 source map as plain data (a bundler's `ExistingRawSourceMap`). */
export interface RawSourceMap {
  readonly version: 3;
  readonly file: string;
  readonly sources: readonly string[];
  readonly sourcesContent?: readonly string[];
  readonly names: readonly string[];
  readonly mappings: string;
}

/** Options for {@link shadowSourceMap} and {@link composeSourceMap}. */
export interface ColumnMapOptions {
  /** The generated file's name, recorded as the map's `file`. */
  readonly file: string;
  /**
   * Whether the map carries `sourcesContent` (default `true`). A client map
   * can leave the sources out and let the dev server serve them.
   */
  readonly sourcesContent?: boolean;
}

/** The fields of an input map {@link composeSourceMap} reads. */
export interface InputSourceMap {
  readonly version?: number;
  readonly sources: readonly (string | null)[];
  readonly names?: readonly string[];
  readonly mappings: string;
}

const WORD = 0;
const SPACE = 1;
const PUNCTUATION = 2;

function charClass(code: number): number {
  if (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0xfeff ||
    code === 0x2028 ||
    code === 0x2029
  ) {
    return SPACE;
  }
  if (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x24 ||
    code >= 0x80
  ) {
    return WORD;
  }
  return PUNCTUATION;
}

/**
 * Whether generated offset `offset` starts a token: a punctuation character,
 * or the first character of a word or whitespace run. A surrogate pair is two
 * word units, so no boundary falls inside one.
 */
function isBoundary(text: string, offset: number): boolean {
  const current = charClass(text.charCodeAt(offset));
  return current === PUNCTUATION || current !== charClass(text.charCodeAt(offset - 1));
}

/** Whether `offset` is the LF of a CRLF, a position no line/column addresses. */
function insideCrlf(text: string, offset: number): boolean {
  return text.charCodeAt(offset) === 0x0a && text.charCodeAt(offset - 1) === 0x0d;
}

/** Collects mapping points per generated line and the `names` table. */
class PointSink {
  readonly lines: MappingPoint[][];
  readonly names: string[] = [];
  private readonly nameIndex = new Map<string, number>();

  constructor(lineCount: number) {
    this.lines = Array.from({ length: lineCount }, () => []);
  }

  private nameOf(name: string): number {
    let index = this.nameIndex.get(name);
    if (index === undefined) {
      index = this.names.length;
      this.names.push(name);
      this.nameIndex.set(name, index);
    }
    return index;
  }

  /** Add a mapped point, unless it repeats the line's previous point. */
  mapped(at: LinePosition, source: number, original: LinePosition, name?: string): void {
    const line = this.lines[at.line] as MappingPoint[];
    const point: MappingPoint =
      name === undefined
        ? [at.column, source, original.line, original.column]
        : [at.column, source, original.line, original.column, this.nameOf(name)];
    const previous = line.at(-1);
    if (
      previous !== undefined &&
      previous.length === point.length &&
      previous.slice(1).every((field, index) => field === point[index + 1])
    ) {
      return;
    }
    if (previous !== undefined && previous[0] === at.column) {
      line[line.length - 1] = point;
      return;
    }
    line.push(point);
  }

  /** End the previous mapping at `at`, when the line has one to end. */
  unmapped(at: LinePosition): void {
    const line = this.lines[at.line] as MappingPoint[];
    const previous = line.at(-1);
    if (previous === undefined || previous.length === 1) {
      return;
    }
    if (previous[0] === at.column) {
      line.pop();
      this.unmapped(at);
      return;
    }
    line.push([at.column]);
  }

  map(options: ColumnMapOptions, shadow: Shadow): RawSourceMap {
    const map: RawSourceMap = {
      version: 3,
      file: options.file,
      sources: Object.freeze(shadow.sources.map((source) => source.name)),
      ...(options.sourcesContent === false
        ? {}
        : { sourcesContent: Object.freeze(shadow.sources.map((source) => source.text)) }),
      names: Object.freeze(this.names),
      mappings: encodeMappings(this.lines),
    };
    return Object.freeze(map);
  }
}

/** Lazily built line indexes of a shadow's sources. */
function sourceIndexes(shadow: Shadow): (index: number) => LineIndex {
  const cache = new Map<number, LineIndex>();
  return (index) => {
    let found = cache.get(index);
    if (found === undefined) {
      found = lineIndex((shadow.sources[index] as Shadow['sources'][number]).text);
      cache.set(index, found);
    }
    return found;
  };
}

function aliasName(shadow: Shadow, span: Span): string | undefined {
  if (span.kind !== SpanKind.Alias) {
    return undefined;
  }
  return shadow.sources[span.source]?.text.slice(span.originalStart, span.originalEnd);
}

/** The version 3 map from a shadow's TSX to its sources. */
export function shadowSourceMap(shadow: Shadow, options: ColumnMapOptions): RawSourceMap {
  const generated = lineIndex(shadow.text);
  const sources = sourceIndexes(shadow);
  const sink = new PointSink(generated.lineStarts.length);
  const lineStarts = new Set(generated.lineStarts);

  for (const span of shadow.spans) {
    const original = sources(span.source);
    const name = aliasName(shadow, span);
    for (let offset = span.generatedStart; offset < span.generatedEnd; offset += 1) {
      if (insideCrlf(shadow.text, offset)) {
        // The LF of a CRLF has no line and column of its own; the next line's start is mapped.
        continue;
      }
      const startsLine = lineStarts.has(offset);
      if (span.kind === SpanKind.Verbatim) {
        if (offset === span.generatedStart || startsLine || isBoundary(shadow.text, offset)) {
          sink.mapped(
            generated.positionAt(offset),
            span.source,
            original.positionAt(span.originalStart + offset - span.generatedStart),
          );
        }
      } else if (offset === span.generatedStart || startsLine) {
        sink.mapped(
          generated.positionAt(offset),
          span.source,
          original.positionAt(span.originalStart),
          name,
        );
      }
    }
  }
  if (shadow.bodyEnd < shadow.text.length && !insideCrlf(shadow.text, shadow.bodyEnd)) {
    sink.unmapped(generated.positionAt(shadow.bodyEnd));
  }
  return sink.map(options, shadow);
}

function unsupported(message: string): SegmentMapError {
  return new SegmentMapError('unsupported_sourcemap', message);
}

/**
 * Compose `input`, a map from compiled JavaScript to the shadow's TSX (oxc's
 * output map), with the shadow's span table into a map from the JavaScript to
 * the `.jsails` sources. Throws `SegmentMapError` (`unsupported_sourcemap`)
 * when `input` is not a version 3 map of exactly one source or points at a
 * position the shadow does not have.
 */
export function composeSourceMap(
  shadow: Shadow,
  input: InputSourceMap,
  options: ColumnMapOptions,
): RawSourceMap {
  if ((input.version !== undefined && input.version !== 3) || input.sources.length !== 1) {
    throw unsupported('the input map is a version 3 map of one source');
  }
  const decoded: DecodedMappings = decodeMappings(input.mappings);
  const generated = lineIndex(shadow.text);
  const sources = sourceIndexes(shadow);
  const sink = new PointSink(decoded.length);

  decoded.forEach((points, line) => {
    for (const point of points) {
      const at = { line, column: point[0] };
      if (point.length === 1) {
        sink.unmapped(at);
        continue;
      }
      if (point[1] !== 0) {
        throw unsupported('an input mapping names a source the map does not have');
      }
      const offset = generated.offsetAt({ line: point[2], column: point[3] });
      if (offset === undefined) {
        throw unsupported('an input mapping points outside the shadow');
      }
      const location = generatedToOriginal(shadow, offset);
      if (location.fidelity === 'none') {
        sink.unmapped(at);
        continue;
      }
      const name =
        location.kind === SpanKind.Verbatim
          ? point.length === 5
            ? input.names?.[point[4]]
            : undefined
          : location.kind === SpanKind.Alias
            ? shadow.sources[location.source]?.text.slice(location.start, location.end)
            : undefined;
      sink.mapped(at, location.source, sources(location.source).positionAt(location.start), name);
    }
  });
  return sink.map(options, shadow);
}

/**
 * The mapping that covers generated `position` in `mappings`: the line's last
 * point at or before the column, or `undefined` when there is none or that
 * point is unmapped.
 */
export function lookupMapping(
  mappings: DecodedMappings,
  position: LinePosition,
): MappingPoint | undefined {
  const points = mappings[position.line];
  if (points === undefined) {
    return undefined;
  }
  let low = 0;
  let high = points.length - 1;
  let found: MappingPoint | undefined;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const point = points[mid] as MappingPoint;
    if (point[0] <= position.column) {
      found = point;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found === undefined || found.length === 1 ? undefined : found;
}
