import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARCHIVE_LIMITS, ArchiveErrors, readTarGz } from '../../src/archive/index.js';
import {
  concat,
  gzip,
  header,
  paxEntry,
  tar,
  tarGz,
  writeHeaderChecksum,
  type TarEntry,
} from './tar-builder.js';

const decoder = new TextDecoder();

function read(entries: readonly TarEntry[]): Map<string, string> {
  return new Map(
    [...readTarGz(tarGz(entries))].map(([path, data]) => [path, decoder.decode(data)]),
  );
}

/** Reading `bytes` throws `bundle_archive.<code>` (and, when given, that `problem`). */
function assertCode(bytes: Uint8Array, code: string, problem?: string): void {
  assert.throws(
    () => readTarGz(bytes),
    (error: unknown) =>
      ArchiveErrors.is(error) &&
      error.code === `bundle_archive.${code}` &&
      (problem === undefined || (error.context as { problem?: string }).problem === problem),
  );
}

function refuses(entries: readonly TarEntry[], code: string, problem?: string): void {
  assertCode(tarGz(entries), code, problem);
}

const file = (name: string, content = 'x'): TarEntry => ({ name, content });

describe('readTarGz', () => {
  describe('what it reads', () => {
    it('reads regular files in archive order and drops directories', () => {
      const files = read([
        { name: 'package/', type: '5' },
        file('package/b.js', 'b'),
        { name: 'package/a.js', content: 'a', type: '\0' },
        { name: 'package/c.js', content: 'c', type: '7' },
        file('package/empty.txt', ''),
      ]);
      assert.deepEqual(
        [...files],
        [
          ['package/b.js', 'b'],
          ['package/a.js', 'a'],
          ['package/c.js', 'c'],
          ['package/empty.txt', ''],
        ],
      );
    });

    it('drops one leading ./ and the archive root directory entry', () => {
      const files = read([{ name: './', type: '5' }, file('./manifest.json'), file('./lib/a.js')]);
      assert.deepEqual([...files.keys()], ['manifest.json', 'lib/a.js']);
    });

    it('returns each file in its own buffer, sharing nothing with the stream', () => {
      const files = readTarGz(tarGz([file('a.js', 'aaaa'), file('b.js', 'bb')]));
      for (const data of files.values()) assert.equal(data.buffer.byteLength, data.byteLength);
    });

    it('joins the POSIX prefix field and ignores the GNU one', () => {
      assert.deepEqual([...read([{ name: 'a.js', prefix: 'lib/deep' }]).keys()], ['lib/deep/a.js']);
      assert.deepEqual(
        [...read([{ name: 'a.js', prefix: 'times', magic: 'gnu', content: 'x' }]).keys()],
        ['a.js'],
      );
    });

    it('ends a name field at its first NUL instead of trimming spaces', () => {
      const name = new Uint8Array([...new TextEncoder().encode('a.js'), 0, 0x41, 0x42]);
      assert.deepEqual([...read([{ name, content: 'x' }]).keys()], ['a.js']);
      refuses([file('a.js ')], 'unsafe_path');
    });

    it('applies GNU long names to the next entry', () => {
      const long = `lib/${'d'.repeat(120)}/x.js`;
      const files = read([
        { name: '././@LongLink', type: 'L', content: `${long}\0` },
        file('short'),
      ]);
      assert.deepEqual([...files.keys()], [long]);
    });

    it('applies pax path and size to the next entry only', () => {
      const files = read([
        paxEntry({
          path: 'lib/renamed.js',
          size: '3',
          mtime: '1700000000.5',
          'SCHILY.xattr.a': 'b',
        }),
        { name: 'ignored.js', content: 'abc', size: 0 },
        file('plain.js', 'p'),
      ]);
      assert.deepEqual(
        [...files],
        [
          ['lib/renamed.js', 'abc'],
          ['plain.js', 'p'],
        ],
      );
    });

    it('skips a pax global header that carries only metadata', () => {
      const files = read([paxEntry({ comment: 'a'.repeat(40) }, 'g'), file('a.js')]);
      assert.deepEqual([...files.keys()], ['a.js']);
    });

    it('accepts headers whose checksum was summed over signed bytes', () => {
      const entry = header({ name: 'caf\u00e9.js'.normalize('NFC') }, 1);
      let signed = 0;
      entry.fill(0x20, 148, 156);
      for (const byte of entry) signed += byte > 127 ? byte - 256 : byte;
      entry.set(new TextEncoder().encode(`${signed.toString(8).padStart(6, '0')}\0 `), 148);
      const data = new Uint8Array(512);
      data[0] = 0x78;
      const files = readTarGz(gzip(concat([entry, data, new Uint8Array(1024)])));
      assert.equal(files.size, 1);
    });
  });

  describe('input and limits', () => {
    it('refuses bytes that are not gzip', () => {
      assertCode(new Uint8Array([1, 2, 3, 4]), 'invalid_gzip');
    });

    it('refuses a compressed input above its limit before inflating it', () => {
      const bytes = tarGz([file('a.js')]);
      assert.throws(
        () => readTarGz(bytes, { maxCompressedBytes: bytes.byteLength - 1 }),
        (error: unknown) =>
          ArchiveErrors.is(error, 'too_large') && error.context.limit === 'compressed',
      );
      assert.equal(readTarGz(bytes, { maxCompressedBytes: bytes.byteLength }).size, 1);
    });

    it('refuses an archive that inflates past its limit', () => {
      const bytes = tarGz([file('a.js', 'a'.repeat(5000))]);
      assert.throws(
        () => readTarGz(bytes, { maxExtractedBytes: 4096 }),
        (error: unknown) =>
          ArchiveErrors.is(error, 'too_large') && error.context.limit === 'extracted',
      );
    });

    it('counts every file and directory entry against maxEntries, not metadata headers', () => {
      const entries: TarEntry[] = [
        { name: 'lib/', type: '5' },
        paxEntry({ path: 'lib/a.js' }),
        file('x'),
        file('lib/b.js'),
      ];
      assert.equal(readTarGz(tarGz(entries), { maxEntries: 3 }).size, 2);
      assert.throws(
        () => readTarGz(tarGz(entries), { maxEntries: 2 }),
        (error: unknown) => ArchiveErrors.is(error, 'too_many_entries'),
      );
    });

    it('counts a repeated directory entry each time it appears', () => {
      const lib: TarEntry = { name: 'lib/', type: '5' };
      assert.throws(
        () => readTarGz(tarGz([lib, lib, lib, file('lib/a.js')]), { maxEntries: 3 }),
        (error: unknown) => ArchiveErrors.is(error, 'too_many_entries'),
      );
    });

    it('counts an entry before checking its name', () => {
      assert.throws(
        () => readTarGz(tarGz([file('a.js'), { name: '../b/', type: '5' }]), { maxEntries: 1 }),
        (error: unknown) => ArchiveErrors.is(error, 'too_many_entries'),
      );
    });

    it('refuses a flood of deep directory headers at the entry limit', () => {
      // Each directory is a GNU long name of about 500 segments: a few hundred
      // kilobytes compressed, tens of thousands of them fit in the extracted
      // limit, and every name costs work to check. The entry limit stops them.
      const entries: TarEntry[] = [];
      for (let index = 0; index <= ARCHIVE_LIMITS.maxEntries; index += 1) {
        const name = `${'a/'.repeat(500)}${String(index).padStart(6, '0')}/`;
        entries.push({ name: '././@LongLink', type: 'L', content: `${name}\0`, magic: 'gnu' });
        entries.push({ name: name.slice(0, 99), type: '5', magic: 'gnu' });
      }
      entries.push(file('a.js'));
      const bytes = tarGz(entries);
      assert.ok(bytes.byteLength < 64 * 1024, 'the flood compresses to almost nothing');
      assert.throws(
        () => readTarGz(bytes),
        (error: unknown) => ArchiveErrors.is(error, 'too_many_entries'),
      );
    });

    it('lets limits tighten the ceilings but never raise them', () => {
      const bytes = tarGz([file('a.js')]);
      for (const limits of [
        { maxEntries: 0 },
        { maxEntries: ARCHIVE_LIMITS.maxEntries + 1 },
        { maxExtractedBytes: ARCHIVE_LIMITS.maxExtractedBytes + 1 },
        { maxCompressedBytes: 1.5 },
      ]) {
        assert.throws(
          () => readTarGz(bytes, limits),
          (error: unknown) => ArchiveErrors.is(error, 'invalid_limits'),
        );
      }
      assert.deepEqual(ARCHIVE_LIMITS, {
        maxCompressedBytes: 16 * 1024 * 1024,
        maxExtractedBytes: 64 * 1024 * 1024,
        maxEntries: 2_000,
      });
    });
  });

  describe('malformed headers', () => {
    it('refuses a header without ustar magic', () => {
      refuses([{ name: 'a.js', content: 'x', magic: 'v7' }], 'invalid_header', 'magic');
    });

    it('refuses a header whose checksum does not match', () => {
      const stream = tar([file('a.js')]);
      stream[0] = 0x62;
      assertCode(gzip(stream), 'invalid_header', 'checksum');
    });

    it('refuses a size that is not plain octal', () => {
      const stream = tar([file('a.js')]);
      stream.set(new TextEncoder().encode('0000000001x\0'), 124);
      writeHeaderChecksum(stream.subarray(0, 512));
      assertCode(gzip(stream), 'invalid_header', 'size');
    });

    it('refuses a base-256 size as unsupported', () => {
      const stream = tar([file('a.js')]);
      stream[124] = 0x80;
      writeHeaderChecksum(stream.subarray(0, 512));
      assertCode(gzip(stream), 'unsupported_archive_format');
    });

    it('refuses an archive cut inside an entry', () => {
      assertCode(gzip(tar([file('a.js', 'a'.repeat(600))]).subarray(0, 1024)), 'truncated');
    });

    it('refuses an archive without an end-of-archive block', () => {
      assertCode(gzip(tar([file('a.js')], false)), 'truncated');
    });

    it('refuses data after the end-of-archive block', () => {
      assertCode(
        gzip(concat([tar([file('a.js')]), tar([file('hidden.js')])])),
        'invalid_header',
        'trailing_data',
      );
    });

    it('refuses a directory entry that carries data', () => {
      refuses([{ name: 'lib/', type: '5', content: 'x' }], 'directory_with_content');
    });
  });

  describe('entry types', () => {
    for (const [type, code] of [
      ['1', 'hardlink_entry'],
      ['2', 'symlink_entry'],
      ['3', 'device_entry'],
      ['4', 'device_entry'],
      ['6', 'device_entry'],
      ['S', 'unsupported_archive_format'],
      ['V', 'unsupported_archive_format'],
      ['M', 'unsupported_archive_format'],
      ['D', 'unsupported_archive_format'],
      ['A', 'unsupported_archive_format'],
    ] as const) {
      it(`refuses typeflag ${type} with ${code}`, () => {
        refuses([{ name: 'entry', type, linkName: 'target' }], code);
      });
    }

    it('refuses a native addon whatever the case of its extension', () => {
      refuses([file('lib/addon.NODE')], 'native_addon_entry');
      assert.equal(read([file('lib/node.js'), file('lib/a.node.js')]).size, 2);
    });

    it('lets a GNU long link name precede only a link', () => {
      refuses(
        [
          { name: '././@LongLink', type: 'K', content: 'target\0' },
          { name: 'l', type: '2' },
        ],
        'symlink_entry',
      );
      refuses(
        [{ name: '././@LongLink', type: 'K', content: 'target\0' }, file('f')],
        'unsupported_archive_format',
      );
      refuses(
        [
          { name: '././@LongLink', type: 'K', content: 't\0' },
          { name: '././@LongLink', type: 'K', content: 't\0' },
        ],
        'invalid_header',
        'long_name',
      );
    });
  });

  describe('pax and GNU metadata', () => {
    it('refuses keywords that change content in another reader', () => {
      refuses([paxEntry({ hdrcharset: 'BINARY' }), file('a')], 'unsupported_archive_format');
      refuses([paxEntry({ 'GNU.sparse.major': '1' }), file('a')], 'unsupported_archive_format');
      for (const keyword of ['path', 'size', 'linkpath', 'hdrcharset', 'GNU.sparse.map']) {
        refuses([paxEntry({ [keyword]: '1' }, 'g'), file('a')], 'unsupported_archive_format');
      }
    });

    it('refuses a pax size that is not a decimal integer', () => {
      refuses([paxEntry({ size: '01' }), file('a')], 'invalid_header', 'pax_record');
      refuses([paxEntry({ size: '1e3' }), file('a')], 'invalid_header', 'pax_record');
    });

    it('refuses metadata headers out of place', () => {
      refuses(
        [paxEntry({ path: 'a' }), paxEntry({ path: 'b' }), file('c')],
        'invalid_header',
        'pax_record',
      );
      refuses(
        [paxEntry({ path: 'a' }), paxEntry({ comment: 'b' }, 'g'), file('c')],
        'invalid_header',
        'pax_record',
      );
      refuses(
        [paxEntry({ path: 'a' }), { name: 'L', type: 'L', content: 'b\0' }, file('c')],
        'unsupported_archive_format',
      );
      refuses(
        [
          { name: 'L', type: 'L', content: 'a\0' },
          { name: 'L', type: 'L', content: 'b\0' },
          file('c'),
        ],
        'invalid_header',
        'long_name',
      );
      refuses([paxEntry({ path: 'a' })], 'truncated');
    });

    it('refuses an oversized GNU long name', () => {
      refuses(
        [{ name: 'L', type: 'L', content: 'a'.repeat(64 * 1024 + 1) }, file('c')],
        'invalid_header',
        'long_name',
      );
    });

    it('checks a pax path like any other name', () => {
      refuses([paxEntry({ path: '../escape.js' }), file('a')], 'unsafe_path');
      refuses([paxEntry({ path: 'a\nb' }), file('a')], 'unsafe_path');
    });
  });

  describe('paths and collisions', () => {
    for (const name of [
      '../a.js',
      '/etc/passwd',
      'lib/../../a.js',
      'a\\b.js',
      'C:x.js',
      'lib/./a.js',
      'lib//a.js',
      '__proto__/a.js',
      'con.js',
      'lib/NUL',
      'COM1.txt',
      'lpt\u00b9',
      'trailing.',
      'trailing ',
      'tab\there',
      'del\u007f',
      'c1\u0085',
      'bidi\u202e.js',
      'what?.js',
      'pipe|.js',
      `${'s'.repeat(256)}.js`,
      `${'d/'.repeat(520)}a.js`,
      'lib/',
    ]) {
      it(`refuses the file name ${JSON.stringify(name.slice(0, 40))}`, () => {
        refuses([paxEntry({ path: name }), file('placeholder')], 'unsafe_path');
        if (new TextEncoder().encode(name).length <= 100) refuses([file(name)], 'unsafe_path');
      });
    }

    for (const [label, character, fits] of [
      ['three-byte', '\u65e5', 84],
      ['four-byte', '\u{1f600}', 63],
    ] as const) {
      it(`measures a segment of ${label} characters in UTF-8 bytes`, () => {
        const name = (count: number) => `lib/${character.repeat(count)}.js`;
        assert.deepEqual(
          [...read([paxEntry({ path: name(fits) }), file('placeholder')]).keys()],
          [name(fits)],
        );
        refuses([paxEntry({ path: name(fits + 1) }), file('placeholder')], 'unsafe_path');
      });
    }

    it('accepts dotfiles, unicode and segments up to 255 UTF-8 bytes', () => {
      const files = read([
        file('.env.example'),
        file('lib/\u65e5\u672c.js'),
        paxEntry({ path: `${'\u00e9'.repeat(126)}.js` }),
        file('placeholder'),
      ]);
      assert.equal(files.size, 3);
    });

    for (const [label, entries] of [
      ['an exact duplicate', [file('a.js'), file('a.js')]],
      ['names differing in case', [file('Readme.md'), file('README.md')]],
      ['names differing in normalisation', [file('caf\u00e9.js'), file('cafe\u0301.js')]],
      ['a long s and an s, one file on APFS', [file('src/a.js'), file('\u017frc/a.js')]],
      ['final and medial sigma, one file on APFS', [file('\u03c3.js'), file('\u03c2.js')]],
      ['a dotless i and an i, one file on NTFS', [file('file.js'), file('f\u0131le.js')]],
      ['a sharp s and ss', [file('stra\u00dfe.js'), file('STRASSE.js')]],
      ['a capital sharp s and a sharp s', [file('\u1e9e.js'), file('\u00df.js')]],
      ['a file under a later file', [file('a'), file('a-b'), file('a/x')]],
      ['a directory under a file, in another case', [file('A'), { name: 'a/b/', type: '5' }]],
      ['./a and a', [file('./a.js'), file('a.js')]],
      ['a file that is also a directory', [file('lib'), file('lib/a.js')]],
      ['a directory entry named like a file', [file('lib'), { name: 'lib/', type: '5' }]],
      ['a file named like a directory entry', [{ name: 'LIB/', type: '5' }, file('lib')]],
    ] as const) {
      it(`refuses ${label}`, () => {
        refuses(entries, 'duplicate_entry');
      });
    }

    it('accepts names that share a prefix without one being a directory of another', () => {
      const files = read([file('a'), file('a-b'), file('a.js'), file('ab/x'), file('b/a')]);
      assert.equal(files.size, 5);
    });

    it('accepts a directory entry repeated', () => {
      assert.equal(
        read([{ name: 'lib/', type: '5' }, { name: 'lib/', type: '5' }, file('lib/a.js')]).size,
        1,
      );
    });
  });
});
