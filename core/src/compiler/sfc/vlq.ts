/**
 * The `mappings` field of a version 3 source map (ECMA-426): base64 VLQ
 * encoding and decoding of decoded mapping lines.
 *
 * Decoding is what composing with oxc needs: `rolldown/utils`'
 * `transformSync` returns a map from the compiled JavaScript to the shadow
 * TSX, and its typed `typescript.inputMap` option is ignored
 * (`docs/design/sfc.md` §8), so the `.jsails` compiler reads that map itself.
 * The decoder rejects malformed input with a value-free `SegmentMapError`
 * instead of producing positions that point nowhere.
 */

import { SegmentMapError } from './segments-error.js';

/**
 * One decoded mapping on a generated line: the generated column alone (a
 * position with no source), or with a source index, source line and source
 * column, optionally followed by a `names` index. All fields are absolute and
 * 0-based.
 */
export type MappingPoint =
  | readonly [generatedColumn: number]
  | readonly [generatedColumn: number, source: number, line: number, column: number]
  | readonly [generatedColumn: number, source: number, line: number, column: number, name: number];

/** Every generated line's mappings, in generated-column order. */
export type DecodedMappings = readonly (readonly MappingPoint[])[];

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Int8Array(128).fill(-1);
for (let index = 0; index < BASE64.length; index += 1) {
  DIGIT[BASE64.charCodeAt(index)] = index;
}
const SHIFT = 5;
const CONTINUATION = 1 << SHIFT;
const MASK = CONTINUATION - 1;
/** VLQ values beyond 2^31 cannot be produced by a map of a JavaScript string. */
const MAX_SHIFT = 31;

/** Encode one signed integer as base64 VLQ. */
export function encodeVlq(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = vlq & MASK;
    vlq >>>= SHIFT;
    if (vlq > 0) {
      digit |= CONTINUATION;
    }
    out += BASE64[digit];
  } while (vlq > 0);
  return out;
}

/**
 * Encode decoded mapping lines as a `mappings` string. Points on a line must
 * be in non-decreasing generated-column order.
 */
export function encodeMappings(lines: DecodedMappings): string {
  let out = '';
  let source = 0;
  let line = 0;
  let column = 0;
  let name = 0;
  lines.forEach((points, lineNumber) => {
    if (lineNumber > 0) {
      out += ';';
    }
    let generatedColumn = 0;
    points.forEach((point, index) => {
      if (index > 0) {
        out += ',';
      }
      out += encodeVlq(point[0] - generatedColumn);
      generatedColumn = point[0];
      if (point.length === 1) {
        return;
      }
      out += encodeVlq(point[1] - source);
      out += encodeVlq(point[2] - line);
      out += encodeVlq(point[3] - column);
      source = point[1];
      line = point[2];
      column = point[3];
      if (point.length === 5) {
        out += encodeVlq(point[4] - name);
        name = point[4];
      }
    });
  });
  return out;
}

function malformed(): SegmentMapError {
  return new SegmentMapError('unsupported_sourcemap', 'source map mappings are malformed');
}

/**
 * Decode a `mappings` string. Throws `SegmentMapError` on an invalid
 * character, a truncated value, an empty segment (a `,` with nothing before
 * or after it on its line), a segment with two, three or more than five
 * fields, or an absolute field that becomes negative.
 */
export function decodeMappings(mappings: string): DecodedMappings {
  const lines: MappingPoint[][] = [];
  let points: MappingPoint[] = [];
  const fields: number[] = [];
  let source = 0;
  let line = 0;
  let column = 0;
  let name = 0;
  let generatedColumn = 0;
  let index = 0;
  /** Set after a `,`, until the segment it opens has a field. */
  let pendingSegment = false;

  const endSegment = (): void => {
    if (fields.length === 0) {
      return;
    }
    generatedColumn += fields[0] ?? 0;
    if (generatedColumn < 0) {
      throw malformed();
    }
    if (fields.length === 1) {
      points.push(Object.freeze([generatedColumn] as const));
    } else if (fields.length === 4 || fields.length === 5) {
      source += fields[1] ?? 0;
      line += fields[2] ?? 0;
      column += fields[3] ?? 0;
      if (source < 0 || line < 0 || column < 0) {
        throw malformed();
      }
      if (fields.length === 5) {
        name += fields[4] ?? 0;
        if (name < 0) {
          throw malformed();
        }
        points.push(Object.freeze([generatedColumn, source, line, column, name] as const));
      } else {
        points.push(Object.freeze([generatedColumn, source, line, column] as const));
      }
    } else {
      throw malformed();
    }
    fields.length = 0;
  };

  while (index < mappings.length) {
    const code = mappings.charCodeAt(index);
    if (code === 0x3b /* ; */) {
      if (pendingSegment) {
        throw malformed();
      }
      endSegment();
      lines.push(points);
      points = [];
      generatedColumn = 0;
      index += 1;
      continue;
    }
    if (code === 0x2c /* , */) {
      if (fields.length === 0) {
        throw malformed();
      }
      endSegment();
      pendingSegment = true;
      index += 1;
      continue;
    }
    pendingSegment = false;
    let value = 0;
    let shift = 0;
    let digit: number;
    do {
      const char = mappings.charCodeAt(index);
      digit = char < 128 ? (DIGIT[char] ?? -1) : -1;
      if (digit < 0 || shift > MAX_SHIFT) {
        throw malformed();
      }
      value += (digit & MASK) * 2 ** shift;
      shift += SHIFT;
      index += 1;
    } while (digit & CONTINUATION);
    const magnitude = Math.floor(value / 2);
    fields.push(value % 2 === 1 ? -magnitude : magnitude);
  }
  if (pendingSegment) {
    throw malformed();
  }
  endSegment();
  lines.push(points);
  return Object.freeze(lines.map((entries) => Object.freeze(entries)));
}
