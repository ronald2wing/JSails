import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArchiveErrors } from '../../src/archive/index.js';
import { parsePaxRecords } from '../../src/archive/pax.js';
import { concat, paxRecords } from './tar-builder.js';

const encoder = new TextEncoder();

function malformed(data: Uint8Array): void {
  assert.throws(
    () => parsePaxRecords(data),
    (error: unknown) =>
      ArchiveErrors.is(error, 'invalid_header') && error.context.problem === 'pax_record',
  );
}

describe('parsePaxRecords', () => {
  it('reads every record, values keeping = and spaces', () => {
    const records = parsePaxRecords(paxRecords({ path: 'a b=c.js', size: '12', comment: '' }));
    assert.deepEqual(
      [...records],
      [
        ['path', 'a b=c.js'],
        ['size', '12'],
        ['comment', ''],
      ],
    );
  });

  it('reads an empty header as no records', () => {
    assert.equal(parsePaxRecords(new Uint8Array(0)).size, 0);
  });

  it('counts the length in bytes, so UTF-8 values read exactly', () => {
    const records = parsePaxRecords(paxRecords({ path: 'lib/\u65e5\u672c\u8a9e.js' }));
    assert.equal(records.get('path'), 'lib/\u65e5\u672c\u8a9e.js');
  });

  for (const [label, text] of [
    ['a length with a leading zero', '010 path=a\n'],
    ['a length one too long', '11 path=a\n'],
    ['a length one too short', '9 path=ab\n'],
    ['a length that is not a number', 'x1 path=a\n'],
    ['a record without a space', '10path=ab\n'],
    ['a record without =', '8 patha\n'],
    ['an empty keyword', '6 =ab\n'],
    ['a missing newline', '10 path=ab'],
    ['trailing bytes', '10 path=a\n\0'],
    ['a length beyond the data', '99 path=a\n'],
    ['a repeated keyword', '10 path=a\n10 path=b\n'],
    ['a bare length', '12'],
  ] as const) {
    it(`refuses ${label}`, () => {
      malformed(encoder.encode(text));
    });
  }

  it('refuses a value that is not UTF-8', () => {
    malformed(concat([encoder.encode('10 path='), new Uint8Array([0xff]), encoder.encode('\n')]));
  });

  it('refuses a header over 1 MiB', () => {
    malformed(paxRecords({ comment: 'a'.repeat(1024 * 1024) }));
  });
});
