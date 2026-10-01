/**
 * Seeded property tests for the plugin-bundle tar extractor (`extractTarGz`).
 *
 * Archives are built by a small deterministic PRNG (mulberry32): ustar entries
 * whose names mix ordinary segments with traversal (`..`, `.`), absolute and
 * drive prefixes, backslashes, NUL and control bytes, `__proto__`, and long
 * prefix/name splits, under every interesting type flag; then the raw tar is
 * corrupted byte by byte before compression. The properties: extraction either
 * returns a map whose every key is a safe relative path (and whose contents
 * equal what was archived) or throws the value-free `ArchiveError`, never a
 * raw `RangeError`/`TypeError`.
 */

import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';

import { ArchiveError, extractTarGz } from '../../src/plugins/archive.js';

// ---------------------------------------------------------------------------
// Seeded generator
// ---------------------------------------------------------------------------

const BASE_SEED = 0x7a40_8001;
const RUNS = 400;

/** mulberry32: a tiny, well-distributed 32-bit PRNG; same seed, same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Gen {
  chance(p: number): boolean;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

function generator(seed: number): Gen {
  const next = mulberry32(seed);
  return {
    chance: (p) => next() < p,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
  };
}

function forAll(check: (gen: Gen) => void): void {
  for (let run = 0; run < RUNS; run += 1) {
    const caseSeed = (BASE_SEED + run) >>> 0;
    try {
      check(generator(caseSeed));
    } catch (error) {
      assert.fail(`property failed for seed ${caseSeed}: ${(error as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tar writer
// ---------------------------------------------------------------------------

const BLOCK = 512;
const encoder = new TextEncoder();

interface Entry {
  readonly name: string;
  readonly prefix: string;
  readonly typeflag: string;
  readonly content: Uint8Array;
}

/** Write latin-1 text (one byte per code unit, as the extractor reads it) into a field. */
function writeText(block: Uint8Array, offset: number, length: number, text: string): void {
  for (let i = 0; i < Math.min(length, text.length); i += 1)
    block[offset + i] = text.charCodeAt(i) & 0xff;
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  writeText(block, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function header(entry: Entry): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeText(block, 0, 100, entry.name);
  writeOctal(block, 100, 8, 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, entry.content.length);
  writeOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = entry.typeflag.charCodeAt(0);
  writeText(block, 257, 6, 'ustar\0');
  writeText(block, 263, 2, '00');
  writeText(block, 345, 155, entry.prefix);
  const sum = block.reduce((total, byte) => total + byte, 0);
  writeText(block, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

function tar(entries: readonly Entry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(header(entry));
    const padded = new Uint8Array(Math.ceil(entry.content.length / BLOCK) * BLOCK);
    padded.set(entry.content);
    parts.push(padded);
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const SEGMENTS = [
  'package.json',
  'dist',
  'index.js',
  'a',
  'b.txt',
  '..',
  '.',
  '',
  '__proto__',
  'constructor',
  'C:',
  'c:\\x',
  '\\\\server',
  'a\\b',
  'nul\0x',
  'tab\tx',
  'line\nx',
  'é',
  'con',
  'aux.txt',
  'x'.repeat(60),
  'a:b',
  'a*b',
  'a?b',
  'a<b',
  ' ',
  '...',
];

function entryName(gen: Gen): string {
  const segments = Array.from({ length: gen.int(1, 4) }, () => gen.pick(SEGMENTS));
  const lead = gen.pick(['', '', '', '/', './', '../', '//']);
  const trail = gen.pick(['', '', '', '/']);
  return lead + segments.join('/') + trail;
}

function entryOf(gen: Gen): Entry {
  const full = entryName(gen);
  const split = full.length > 100 || gen.chance(0.2) ? full.lastIndexOf('/', full.length - 2) : -1;
  return {
    prefix: split > 0 ? full.slice(0, split) : '',
    name: split > 0 ? full.slice(split + 1) : full,
    typeflag: gen.pick([
      '0',
      '0',
      '0',
      '\0',
      '7',
      '5',
      '1',
      '2',
      '3',
      '4',
      '6',
      'x',
      'g',
      'K',
      'L',
      'S',
    ]),
    content: encoder.encode(gen.pick(['', 'hello', '{"name":"x"}', 'z'.repeat(gen.int(0, 1500))])),
  };
}

/** True when `path` is a relative, normalized path an extractor may write. */
function isSafeRelative(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f]/.test(path) || /^[a-zA-Z]:/.test(path)) return false;
  return path
    .split('/')
    .every(
      (segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== '__proto__',
    );
}

function flipByte(bytes: Uint8Array, index: number): Uint8Array {
  const copy = bytes.slice();
  copy[index] = copy[index]! ^ 0xff;
  return copy;
}

function extract(data: Uint8Array): Map<string, Uint8Array> | ArchiveError {
  try {
    return extractTarGz(data, { maxEntries: 50, maxTotalBytes: 1024 * 1024 });
  } catch (error) {
    assert.ok(error instanceof ArchiveError, `unexpected ${String(error)}`);
    assert.doesNotMatch(error.message, /\.\.|__proto__|hello/, 'the error echoed archive input');
    return error;
  }
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('property: extractTarGz', () => {
  it('returns only safe relative paths with their archived contents, or throws ArchiveError', () => {
    let extracted = 0;
    forAll((gen) => {
      const entries = Array.from({ length: gen.int(1, 5) }, () => entryOf(gen));
      const result = extract(gzipSync(tar(entries)));
      if (result instanceof ArchiveError) return;
      extracted += 1;
      for (const [path, content] of result) {
        assert.ok(isSafeRelative(path), `unsafe path ${JSON.stringify(path)} was extracted`);
        // A GNU long-name entry renames its successor from its own data.
        if (entries.some((entry) => entry.typeflag === 'L')) continue;
        const source = entries.find(
          (entry) => (entry.prefix === '' ? entry.name : `${entry.prefix}/${entry.name}`) === path,
        );
        assert.ok(source, `extracted ${JSON.stringify(path)} was never archived`);
        assert.deepEqual(new Uint8Array(content), source.content);
      }
    });
    assert.ok(extracted > 0, 'the generator never produced an extractable archive');
  });

  it('a corrupted tar stream yields a safe map or ArchiveError', () => {
    forAll((gen) => {
      const entries = Array.from({ length: gen.int(1, 3) }, () => ({
        name: gen.pick(['package.json', 'dist/index.js', 'a/b/c.txt']),
        prefix: '',
        typeflag: '0',
        content: encoder.encode('hello'.repeat(gen.int(0, 200))),
      }));
      const raw = tar(entries);
      for (let flips = gen.int(1, 8); flips > 0; flips -= 1) {
        raw[gen.int(0, raw.length - 1)] = gen.int(0, 255);
      }
      const result = extract(gzipSync(raw));
      if (result instanceof ArchiveError) return;
      for (const path of result.keys()) assert.ok(isSafeRelative(path), JSON.stringify(path));
    });
  });

  it('arbitrary bytes and corrupted gzip throw ArchiveError', () => {
    forAll((gen) => {
      const valid = gzipSync(
        tar([{ name: 'a.txt', prefix: '', typeflag: '0', content: encoder.encode('hello') }]),
      );
      const bytes = gen.chance(0.5)
        ? Uint8Array.from({ length: gen.int(0, 600) }, () => gen.int(0, 255))
        : flipByte(valid, gen.int(0, valid.length - 1));
      const result = extract(bytes);
      if (!(result instanceof ArchiveError)) {
        for (const path of result.keys()) assert.ok(isSafeRelative(path), JSON.stringify(path));
      }
    });
  });
});
