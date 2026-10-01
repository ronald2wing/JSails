/**
 * Value generators for the fidelity property test: for each portable type, a
 * seeded stream of canonical application values that mixes random values
 * with the edge cases a dialect is most likely to get wrong (range limits,
 * case and trailing-space variants, code points whose UTF-16 and code-point
 * orders differ, byte prefixes, millisecond neighbours).
 */

import type { JsonValue, PortableType } from '../../../src/model/index.js';

/** A seeded PRNG (mulberry32): the same seed gives the same values on every run. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[int(rng, 0, items.length - 1)] as T;
}

/** Code-point ranges with no surrogates and no U+0000. */
const CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0x01, 0x1f],
  [0xa0, 0x24f],
  [0x300, 0x36f],
  [0x4e00, 0x4fff],
  [0xe000, 0xe0ff],
  [0xff00, 0xffef],
  [0xfff0, 0xfffd],
  [0x1f600, 0x1f64f],
  [0x10000, 0x100ff],
];

function codePoint(rng: Rng): string {
  const [low, high] = pick(rng, CODE_POINT_RANGES);
  return String.fromCodePoint(int(rng, low, high));
}

function text(rng: Rng, maxLength: number): string {
  const length = int(rng, 0, maxLength);
  let out = '';
  for (let index = 0; index < length; index += 1) out += codePoint(rng);
  return out;
}

const STRING_EDGES = [
  '',
  ' ',
  'a',
  'A',
  'a ',
  'a  ',
  ' a',
  'b',
  'B',
  'ä',
  'Ä',
  'ß',
  'ss',
  '～',
  '😀',
  '',
  'ź',
  'ź',
];

function digits(rng: Rng, count: number): string {
  let out = '';
  for (let index = 0; index < count; index += 1) out += String(int(rng, 0, 9));
  return out;
}

function decimal(rng: Rng, precision: number, scale: number): string {
  const integerDigits = int(rng, 0, precision - scale);
  const integer = digits(rng, integerDigits).replace(/^0+/, '') || '0';
  const fraction = digits(rng, scale);
  const body = scale === 0 ? integer : `${integer}.${fraction}`;
  const zero = /^[0.]*$/.test(body);
  return rng() < 0.5 && !zero ? `-${body}` : body;
}

function decimalEdges(precision: number, scale: number): string[] {
  const max = `${'9'.repeat(precision - scale)}${scale === 0 ? '' : `.${'9'.repeat(scale)}`}`;
  const unit = scale === 0 ? '1' : `0.${'0'.repeat(scale - 1)}1`;
  const zero = scale === 0 ? '0' : `0.${'0'.repeat(scale)}`;
  return [zero, unit, `-${unit}`, max, `-${max}`];
}

function float(rng: Rng): number {
  const bytes = new DataView(new ArrayBuffer(8));
  for (;;) {
    for (let index = 0; index < 8; index += 1) bytes.setUint8(index, int(rng, 0, 255));
    const value = bytes.getFloat64(0);
    if (Number.isFinite(value)) return value === 0 ? 0 : value;
  }
}

const FLOAT_EDGES = [
  0,
  1,
  -1,
  0.1,
  1 / 3,
  -2.5e-308,
  5e-324,
  -5e-324,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.MIN_VALUE,
  Number.EPSILON,
  2 ** 53 + 2,
  123456789.12345679,
];

const TIMESTAMP_MIN = Date.UTC(1000, 0, 1);
const TIMESTAMP_MAX = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

function json(rng: Rng, depth: number): JsonValue {
  const roll = rng();
  if (depth > 3 || roll < 0.35) {
    return pick(rng, [
      () => null,
      () => rng() < 0.5,
      () => int(rng, -1e6, 1e6),
      () => float(rng),
      () => text(rng, 12),
    ])();
  }
  if (roll < 0.65) {
    return Array.from({ length: int(rng, 0, 4) }, () => json(rng, depth + 1));
  }
  const object: Record<string, JsonValue> = {};
  for (let index = int(rng, 0, 4); index > 0; index -= 1)
    object[text(rng, 6)] = json(rng, depth + 1);
  return object;
}

function bytes(rng: Rng, maxLength: number): Uint8Array {
  return Uint8Array.from({ length: int(rng, 0, maxLength) }, () => int(rng, 0, 255));
}

function uuid(rng: Rng): string {
  const hex = Array.from({ length: 16 }, () => int(rng, 0, 255).toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `count` random values of `type` after its edge cases, all canonical. */
export function fidelityValues(type: PortableType, rng: Rng, count: number): unknown[] {
  const edges: unknown[] = [];
  let next: () => unknown;
  switch (type.kind) {
    case 'id':
      edges.push(0, 1, -1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 2 ** 31, 2 ** 32 + 1);
      // `+ 0` turns a rounded -0 into 0, the canonical zero.
      next = () => Math.round((rng() * 2 - 1) * 10 ** int(rng, 0, 15)) + 0;
      break;
    case 'integer':
      edges.push(0, 1, -1, 2147483647, -2147483648, 255, 256, -256);
      next = () => int(rng, -2147483648, 2147483647);
      break;
    case 'bigint':
      edges.push(0n, 1n, -1n, 2n ** 63n - 1n, -(2n ** 63n), 2n ** 53n + 1n, -(2n ** 53n) - 1n);
      next = () =>
        BigInt.asIntN(64, BigInt(int(rng, 0, 2 ** 31)) * BigInt(int(rng, 0, 2 ** 31)) * 3n);
      break;
    case 'decimal':
      edges.push(...decimalEdges(type.precision, type.scale));
      next = () => decimal(rng, type.precision, type.scale);
      break;
    case 'float':
      edges.push(...FLOAT_EDGES);
      next = () => (rng() < 0.5 ? float(rng) : (rng() - 0.5) * 10 ** int(rng, -10, 10));
      break;
    case 'boolean':
      edges.push(false, true);
      next = () => rng() < 0.5;
      break;
    case 'string':
      edges.push(...STRING_EDGES.filter((value) => [...value].length <= type.length));
      next = () => text(rng, type.length);
      break;
    case 'text':
      edges.push(...STRING_EDGES, 'x'.repeat(70000));
      next = () => text(rng, rng() < 0.1 ? 3000 : 40);
      break;
    case 'timestamp': {
      // Millisecond neighbours, which a dialect that rounds or truncates would reorder.
      const base = Date.UTC(2024, 1, 29, 23, 59, 59, 998);
      edges.push(
        ...[TIMESTAMP_MIN, TIMESTAMP_MAX, base, base + 1, base + 2, base - 1, 0, -1, 1].map(
          (time) => new Date(time),
        ),
      );
      next = () => new Date(int(rng, TIMESTAMP_MIN, TIMESTAMP_MAX));
      break;
    }
    case 'date':
      edges.push('1000-01-01', '9999-12-31', '2000-02-29', '1970-01-01', '1969-12-31');
      next = () => new Date(int(rng, TIMESTAMP_MIN, TIMESTAMP_MAX)).toISOString().slice(0, 10);
      break;
    case 'time':
      edges.push('00:00:00.000', '23:59:59.999', '12:00:00.000', '12:00:00.001', '11:59:59.999');
      next = () => new Date(int(rng, 0, 86_399_999)).toISOString().slice(11, 23);
      break;
    case 'json':
      edges.push({}, [], '', 0, false, { a: 1, b: [null, true, 'é😀'] }, [[[]]], 1e21, -0.5);
      next = () => {
        const value = json(rng, 0);
        return value === null ? 'null' : value;
      };
      break;
    case 'uuid':
      edges.push('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff');
      next = () => uuid(rng);
      break;
    case 'binary': {
      const max = type.length ?? 600;
      edges.push(
        new Uint8Array(),
        Uint8Array.of(0),
        Uint8Array.of(0, 0),
        Uint8Array.of(1),
        Uint8Array.of(255),
      );
      if (type.length === undefined) edges.push(new Uint8Array(70000).fill(7));
      else edges.push(new Uint8Array(max).fill(255));
      next = () => bytes(rng, max);
      break;
    }
  }
  return [...edges, ...Array.from({ length: count }, next)];
}
