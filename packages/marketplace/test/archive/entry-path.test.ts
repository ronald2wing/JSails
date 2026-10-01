import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArchiveErrors } from '../../src/archive/index.js';
import { checkEntryPath, collisionKey, decodeEntryName } from '../../src/archive/entry-path.js';

function unsafe(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => ArchiveErrors.is(error, 'unsafe_path'));
}

describe('checkEntryPath', () => {
  it('returns a file path with one leading ./ dropped', () => {
    assert.equal(checkEntryPath('lib/a.js', 'file'), 'lib/a.js');
    assert.equal(checkEntryPath('./lib/a.js', 'file'), 'lib/a.js');
    unsafe(() => checkEntryPath('././lib/a.js', 'file'));
  });

  it('drops one trailing slash from a directory, and reads ./ as the root', () => {
    assert.equal(checkEntryPath('lib/', 'directory'), 'lib');
    assert.equal(checkEntryPath('lib', 'directory'), 'lib');
    assert.equal(checkEntryPath('./', 'directory'), undefined);
    unsafe(() => checkEntryPath('lib//', 'directory'));
    unsafe(() => checkEntryPath('/', 'directory'));
    unsafe(() => checkEntryPath('', 'directory'));
  });

  it('refuses a file name ending in a slash, or naming the root', () => {
    unsafe(() => checkEntryPath('lib/', 'file'));
    unsafe(() => checkEntryPath('./', 'file'));
    unsafe(() => checkEntryPath('', 'file'));
  });

  it('judges a device name by its stem, whatever follows', () => {
    for (const name of [
      'aux',
      'AUX.tar.gz',
      'lib/com9.d.ts',
      'Lpt\u00b2.md',
      'nul .txt',
      'CON/a.js',
      'lib/nul\u00a0.js',
      'prn\u3000',
    ]) {
      unsafe(() => checkEntryPath(name, 'file'));
    }
    for (const name of [
      'auxiliary.js',
      'console.js',
      'com10.js',
      'lib/null.js',
      ' con.js',
      'a.con',
    ]) {
      assert.equal(checkEntryPath(name, 'file'), name);
    }
  });

  it('caps a path at 1,024 characters', () => {
    const segment = 'a'.repeat(100);
    const path = `${Array.from({ length: 10 }, () => segment).join('/')}/${'b'.repeat(14)}`;
    assert.equal(path.length, 1_024);
    assert.equal(checkEntryPath(path, 'file'), path);
    unsafe(() => checkEntryPath(`${path}c`, 'file'));
  });

  it('refuses lone surrogates and the remaining bidirectional controls', () => {
    for (const name of ['a\ud800.js', 'a\u061c.js', 'a\u200e.js', 'a\u2066.js']) {
      unsafe(() => checkEntryPath(name, 'file'));
    }
  });
});

describe('decodeEntryName', () => {
  it('decodes UTF-8 and refuses anything else', () => {
    assert.equal(decodeEntryName(new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9])), 'caf\u00e9');
    unsafe(() => decodeEntryName(new Uint8Array([0x63, 0xe9])));
    unsafe(() => decodeEntryName(new Uint8Array([0xc0, 0xaf])));
  });
});

describe('collisionKey', () => {
  it('folds case and normalisation', () => {
    assert.equal(collisionKey('Cafe\u0301.JS'), collisionKey('caf\u00e9.js'));
    assert.notEqual(collisionKey('a.js'), collisionKey('b.js'));
  });

  it('folds case the way APFS and NTFS do, not only by lower-casing', () => {
    for (const [left, right] of [
      ['src/a.js', '\u017frc/a.js'],
      ['\u03c3.js', '\u03c2.js'],
      ['file.js', 'f\u0131le.js'],
      ['stra\u00dfe.js', 'STRASSE.JS'],
      ['\u1e9e.js', '\u00df.js'],
      ['\u1e9e.js', 'ss.js'],
    ] as const) {
      assert.equal(collisionKey(left), collisionKey(right), `${left} and ${right}`);
    }
  });

  it('is stable: a key is its own key, for every code point', () => {
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const key = collisionKey(String.fromCodePoint(code));
      if (collisionKey(key) !== key) assert.fail(`U+${code.toString(16)} has an unstable key`);
    }
  });
});
