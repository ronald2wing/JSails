/**
 * The bundle archive reader against archives real tools write, its limits at
 * their boundary, and a header mutation fuzz (the marketplace conformance
 * suite's archive part). A bundle may come from GNU tar, from bsdtar (pax `x`
 * records), or from `git archive` (a pax `g` global header), and the reader
 * must read all three, decode names as UTF-8, and refuse links, devices and
 * native addons with a code. Whatever the input, it either fails with its own
 * error or stays inside its entry and byte limits.
 *
 * The fixtures in `fixtures/` are checked in, built with `TZ=UTC` from a
 * `package/` tree holding `manifest.json` (`acme-archive@1.0.0`) and
 * `index.js`:
 *
 * - `gnu-tar.tar.gz`: plus a file whose path exceeds 100 bytes (GNU `L`
 *   records); `tar --format=gnu --sort=name --mtime=2026-01-01T00:00:00Z
 *   --owner=0 --group=0 --numeric-owner -cf - package | gzip -9n`
 * - `gnu-tar-utf8.tar.gz`: the same command, plus `lib/café.js`
 * - `gnu-tar-symlink.tar.gz`: the same command, plus `lib/link.js -> ../index.js`
 * - `bsdtar-pax.tar.gz`: plus a file whose path exceeds 255 bytes (pax `path`);
 *   `bsdtar --format pax -cf - @bsdtar-pax.mtree | gzip -9n`, run in the
 *   directory holding `package/`. The mtree spec beside the fixture fixes the
 *   entry order, owner, modes and mtime; bsdtar reads only what the spec
 *   states, so it writes no host `ctime` or `atime` record and the only pax
 *   records are the two `path` records.
 * - `git-archive.tar.gz`: the tree committed, then `git archive --format=tar
 *   HEAD | gzip -9n`
 *
 * The fuzz mutates 2,000 archives for each of five subjects, 10,000 mutated
 * headers in all, and reads each one twice: with the raw reader under the
 * tightest limits the unmutated archive passes, and with `openBundle` under
 * the default limits, which may fail only with this package's own codes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import { ArchiveErrors, readTarGz, type ArchiveLimits } from '../../src/archive/index.js';
import { IntakeErrors, openBundle, type OpenedBundle } from '../../src/intake/index.js';
import { concat, header, tarGz, writeHeaderChecksum } from './tar-builder.js';

const FIXTURES = new URL('../../../test/archive/fixtures/', import.meta.url);

const LONG_GNU_PATH =
  'lib/a-directory-name-long-enough-that-the-whole-entry-path-needs-more-than-one-hundred-bytes/deep.js';
const SEGMENT = 'abcdefghij-abcdefghij-abcdefghij-abcdefghij-abcdefghij-abcdef';
const LONG_PAX_PATH = `lib/${SEGMENT}/${SEGMENT}/${SEGMENT}/${SEGMENT}/deeper.js`;

type Limits = Pick<ArchiveLimits, 'maxEntries' | 'maxExtractedBytes'>;

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, FIXTURES)));
}

function text(files: ReadonlyMap<string, Uint8Array>, path: string): string | undefined {
  const data = files.get(path);
  return data === undefined ? undefined : new TextDecoder().decode(data);
}

function totalBytes(files: ReadonlyMap<string, Uint8Array>): number {
  return [...files.values()].reduce((sum, data) => sum + data.byteLength, 0);
}

/** The archive opens as the `acme-archive@1.0.0` bundle and holds `extra` with `content`. */
function assertBundle(bundle: OpenedBundle, extra: string, content: string): void {
  assert.equal(bundle.manifest.id, 'acme-archive', 'the manifest is at the bundle root');
  assert.equal(bundle.manifest.version, '1.0.0');
  assert.ok(bundle.files.has('index.js'), 'the entry module is at the bundle root');
  assert.equal(text(bundle.files, extra), `${content}\n`, `the archive holds ${extra}`);
}

const MANIFEST = JSON.stringify({
  manifestVersion: 1,
  id: 'acme-archive',
  version: '1.0.0',
  name: 'Archive fixture',
  summary: 'A bundle real archive tools wrote.',
  publisher: 'acme',
  jsailsCompat: '^1.0.0',
  apiTier: 'stable',
  entry: './index.js',
  marketplace: true,
});

/** A valid bundle archive (`package/` root, manifest and entry) plus `extra`. */
function bundleWith(extra: {
  readonly name: string | Uint8Array;
  readonly content: string | Uint8Array;
}): Uint8Array {
  const prefix = new TextEncoder().encode('package/');
  const name =
    typeof extra.name === 'string'
      ? `package/${extra.name}`
      : new Uint8Array([...prefix, ...extra.name]);
  return tarGz([
    { name: 'package/', type: '5' },
    { name: 'package/manifest.json', content: MANIFEST },
    { name: 'package/index.js', content: 'export default { name: "acme-archive", setup() {} };\n' },
    { name, content: extra.content },
  ]);
}

/** `fn` throws the archive reader's `code`. */
function assertRefused(fn: () => unknown, code: string, message: string): void {
  assert.throws(
    fn,
    (error: unknown) => ArchiveErrors.is(error) && error.code === `bundle_archive.${code}`,
    message,
  );
}

/**
 * An archive the fuzz and the boundary tests run over, how many files it
 * holds, and how many entries (files and directories).
 */
interface FuzzSubject {
  readonly name: string;
  readonly bytes: () => Uint8Array;
  readonly files: number;
  readonly entries: number;
}

const SUBJECTS: readonly FuzzSubject[] = [
  { name: 'gnu-tar.tar.gz', bytes: () => fixture('gnu-tar.tar.gz'), files: 3, entries: 6 },
  {
    name: 'gnu-tar-utf8.tar.gz',
    bytes: () => fixture('gnu-tar-utf8.tar.gz'),
    files: 3,
    entries: 5,
  },
  { name: 'bsdtar-pax.tar.gz', bytes: () => fixture('bsdtar-pax.tar.gz'), files: 3, entries: 9 },
  { name: 'git-archive.tar.gz', bytes: () => fixture('git-archive.tar.gz'), files: 2, entries: 3 },
  {
    name: 'ustar bundle',
    bytes: () => bundleWith({ name: 'lib/extra.js', content: 'extra\n' }),
    files: 3,
    entries: 4,
  },
];

/** The tightest limits the unmutated archive passes, so enforcing them is what the fuzz checks. */
function tightLimits(subject: FuzzSubject): Limits {
  return {
    maxEntries: subject.entries,
    maxExtractedBytes: gunzipSync(subject.bytes()).byteLength,
  };
}

const ITERATIONS_PER_ARCHIVE = 2_000;
/** At least this many mutated archives must open, or the fuzz checks almost nothing. */
const MIN_READ = 400;
const TYPEFLAGS = ['0', '5', '7', 'x', 'g', 'L', 'K', '1', '2', '3', '4', '6', '\0', 'Z', 'S'];

/** mulberry32: a small seeded generator, so a failure reproduces from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function declaredSize(tar: Uint8Array, at: number): number {
  const field = new TextDecoder().decode(tar.subarray(at + 124, at + 136));
  return parseInt(field.replace(/[\0 ]+$/, ''), 8) || 0;
}

/** Offsets of every header block, following each entry's declared size. */
function headerOffsets(tar: Uint8Array): number[] {
  const offsets: number[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length && tar.subarray(offset, offset + 512).some((b) => b !== 0)) {
    offsets.push(offset);
    offset += 512 + Math.ceil(declaredSize(tar, offset) / 512) * 512;
  }
  return offsets;
}

function writeSize(tar: Uint8Array, at: number, size: number): void {
  tar.set(new TextEncoder().encode(size.toString(8).padStart(11, '0').slice(-11)), at + 124);
}

/**
 * Grow the entry at `at` by `extra` bytes (a multiple of 512) of data, so the
 * archive's content outgrows a byte limit sized to the original stream.
 */
function grow(tar: Uint8Array, at: number, extra: number): Uint8Array {
  const size = declaredSize(tar, at);
  const split = Math.min(at + 512 + size, tar.length);
  const out = new Uint8Array(tar.length + extra);
  out.set(tar.subarray(0, split), 0);
  out.fill(0x61, split, split + extra);
  out.set(tar.subarray(split), split + extra);
  writeSize(out, at, size + extra);
  return out;
}

function mutate(tar: Uint8Array, next: () => number): Uint8Array {
  const out = new Uint8Array(tar);
  const offsets = headerOffsets(out);
  const at = offsets[Math.floor(next() * offsets.length)] ?? 0;
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const encoder = new TextEncoder();
  switch (Math.floor(next() * 8)) {
    case 0:
      out[at + Math.floor(next() * 512)] = Math.floor(next() * 256);
      break;
    case 1:
      writeSize(out, at, pick([0, 1, 511, 512, 513, 0o77777777777, Math.floor(next() * 2 ** 20)]));
      break;
    case 2:
      out[at + 156] = pick(TYPEFLAGS).charCodeAt(0);
      break;
    case 3:
      for (let i = 0; i < 100; i += 1) out[at + i] = Math.floor(next() * 256);
      break;
    case 4: {
      // The first data block: a pax or long-name payload when the entry has one.
      const index = at + 512 + Math.floor(next() * 512);
      if (index < out.length) out[index] = pick([0x30, 0x39, 0x20, 0x0a, 0x3d, 0x00, 0xff]);
      break;
    }
    case 5: {
      // A run of empty files with portable names before a header: more
      // entries than the limit allows, and more files than the archive held
      // entries, so a reader that ignores the limit shows it.
      const extra = concat(
        Array.from({ length: 8 }, (_, index) => header({ name: `package/extra-${index}.js` }, 0)),
      );
      return concat([out.subarray(0, at), extra, out.subarray(at)]);
    }
    case 6: {
      const grown = grow(out, at, tar.length);
      writeHeaderChecksum(grown.subarray(at, at + 512));
      return grown;
    }
    default:
      out.set(encoder.encode('ustar'), at + 257 + Math.floor(next() * 3));
  }
  if (next() < 0.9) writeHeaderChecksum(out.subarray(at, at + 512));
  return out;
}

type Reader = (bytes: Uint8Array, limits: Limits) => ReadonlyMap<string, Uint8Array>;

const readEntries: Reader = (bytes, limits) => readTarGz(bytes, limits);

/** What one fuzz run saw: how many mutated archives opened, and every broken guarantee. */
interface FuzzResult {
  readonly read: number;
  readonly violations: readonly string[];
}

/** Mutate `subject` ITERATIONS_PER_ARCHIVE times, reading each result with `reader` under its tight limits. */
function fuzz(subject: FuzzSubject, reader: Reader, intake: boolean): FuzzResult {
  const tar = new Uint8Array(gunzipSync(subject.bytes()));
  const limits = tightLimits(subject);
  const seed = [...subject.name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
  const next = random(seed);
  const violations: string[] = [];
  let read = 0;
  for (let iteration = 0; iteration < ITERATIONS_PER_ARCHIVE; iteration += 1) {
    const where = `iteration ${iteration} (seed ${seed})`;
    const bytes = new Uint8Array(gzipSync(mutate(tar, next), { level: 1 }));
    if (intake) {
      try {
        openBundle(bytes);
      } catch (error) {
        if (!ArchiveErrors.is(error) && !IntakeErrors.is(error)) {
          violations.push(`intake: ${where} threw another error`);
        }
      }
    }
    let files: ReadonlyMap<string, Uint8Array>;
    try {
      files = reader(bytes, limits);
    } catch (error) {
      if (!ArchiveErrors.is(error)) violations.push(`error: ${where} threw another error`);
      continue;
    }
    read += 1;
    if (files.size > limits.maxEntries) violations.push(`entries: ${where} has too many entries`);
    if (totalBytes(files) > limits.maxExtractedBytes) {
      violations.push(`bytes: ${where} has too many bytes`);
    }
    for (const path of files.keys()) {
      if (path.startsWith('/') || path.split('/').includes('..')) {
        violations.push(`escape: ${where} has an entry outside the bundle`);
      }
    }
  }
  return { read, violations };
}

/** The fuzz guarantees: no broken limit, and enough mutated archives read to mean something. */
function assertFuzzHolds(subject: FuzzSubject): void {
  const { read, violations } = fuzz(subject, readEntries, true);
  assert.deepEqual(violations, [], `${subject.name}: every mutation stays inside the limits`);
  assert.ok(
    read >= MIN_READ,
    `${subject.name}: too few mutated archives were read (${read} of ${ITERATIONS_PER_ARCHIVE}, at least ${MIN_READ})`,
  );
}

/** The limits hold at their boundary: the tightest limits open it, one less refuses it. */
function assertLimitsAtBoundary(subject: FuzzSubject): void {
  const bytes = subject.bytes();
  const limits = tightLimits(subject);
  const files = readEntries(bytes, limits);
  assert.equal(files.size, subject.files, `${subject.name} holds ${subject.files} files`);
  assertRefused(
    () => readEntries(bytes, { ...limits, maxEntries: subject.entries - 1 }),
    'too_many_entries',
    'one entry over maxEntries is refused',
  );
  assertRefused(
    () => readEntries(bytes, { ...limits, maxExtractedBytes: totalBytes(files) - 1 }),
    'too_large',
    'one byte over maxExtractedBytes is refused',
  );
}

describe('marketplace archive reader', () => {
  describe('archives real tools write', () => {
    it('reads a GNU tar bundle, long names included', () => {
      assertBundle(openBundle(fixture('gnu-tar.tar.gz')), LONG_GNU_PATH, 'long');
    });

    it('reads a bsdtar pax bundle, applying pax path records', () => {
      assertBundle(openBundle(fixture('bsdtar-pax.tar.gz')), LONG_PAX_PATH, 'pax');
    });

    it('reads a git archive bundle, skipping the pax global header', () => {
      const bundle = openBundle(fixture('git-archive.tar.gz'));
      assert.equal(bundle.manifest.id, 'acme-archive');
      assert.deepEqual([...bundle.files.keys()].sort(), ['index.js', 'manifest.json']);
    });

    it('decodes entry names as UTF-8', () => {
      assertBundle(openBundle(fixture('gnu-tar-utf8.tar.gz')), 'lib/café.js', 'utf8');
    });
  });

  describe('refusals', () => {
    it('opens the valid bundle the refusal cases are built from', () => {
      assertBundle(
        openBundle(bundleWith({ name: 'lib/cafe.js', content: 'plain\n' })),
        'lib/cafe.js',
        'plain',
      );
    });

    it('refuses an entry name that is not valid UTF-8', () => {
      const name = new Uint8Array([...new TextEncoder().encode('lib/caf'), 0xe9, 0x2e, 0x6a, 0x73]);
      assertRefused(
        () => openBundle(bundleWith({ name, content: 'latin-1 name\n' })),
        'unsafe_path',
        'a name that is not UTF-8 is refused as an unsafe path',
      );
    });

    it('refuses a symbolic link with a code that names it', () => {
      assertRefused(
        () => openBundle(fixture('gnu-tar-symlink.tar.gz')),
        'symlink_entry',
        'a symbolic link is refused with symlink_entry',
      );
    });

    it('refuses a native addon', () => {
      const addon = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
      assertRefused(
        () => openBundle(bundleWith({ name: 'lib/addon.node', content: addon })),
        'native_addon_entry',
        'a .node file is refused with native_addon_entry',
      );
    });
  });

  describe('limits at their boundary', () => {
    for (const subject of SUBJECTS) {
      it(`${subject.name}: opens at its tightest limits and is refused one below`, () => {
        assertLimitsAtBoundary(subject);
      });
    }
  });

  describe('header mutation fuzz', () => {
    for (const subject of SUBJECTS) {
      it(`${subject.name}: every mutation fails with an archive error or stays inside the limits`, () => {
        assertFuzzHolds(subject);
      });
    }

    it('fails against a reader that ignores its limits', () => {
      const unbounded: Reader = (bytes) => readTarGz(bytes);
      for (const subject of SUBJECTS) {
        const { read, violations } = fuzz(subject, unbounded, false);
        assert.ok(read >= MIN_READ, `${subject.name}: the unbounded reader reads mutations`);
        assert.ok(
          violations.some((violation) => violation.startsWith('entries:')),
          `${subject.name}: some mutation exceeds maxEntries`,
        );
        assert.ok(
          violations.some((violation) => violation.startsWith('bytes:')),
          `${subject.name}: some mutation exceeds maxExtractedBytes`,
        );
      }
    });
  });
});
