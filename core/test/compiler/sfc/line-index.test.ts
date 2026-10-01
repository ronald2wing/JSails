/**
 * Tests for the `.jsails` line index: ECMAScript line terminators (LF, CR,
 * CRLF, U+2028, U+2029), UTF-16 columns, clamping, and the offset/position
 * round trip over seeded texts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lineIndex } from '../../../src/compiler/sfc/line-index.js';
import { forEachSeed } from '../../../src/testing/seeded-random.js';

describe('lineIndex', () => {
  it('breaks lines at LF, CR, CRLF, U+2028 and U+2029, counting CRLF once', () => {
    const index = lineIndex('a\nb\rc\r\nd\u2028e\u2029f');
    assert.deepEqual(index.lineStarts, [0, 2, 4, 7, 9, 11]);
  });

  it('counts columns in UTF-16 code units', () => {
    const index = lineIndex('é𝒳x\ny');
    assert.deepEqual(index.positionAt(3), { line: 0, column: 3 });
    assert.deepEqual(index.positionAt(5), { line: 1, column: 0 });
  });

  it('clamps positionAt to the text', () => {
    const index = lineIndex('ab\ncd');
    assert.deepEqual(index.positionAt(-4), { line: 0, column: 0 });
    assert.deepEqual(index.positionAt(99), { line: 1, column: 2 });
  });

  it('addresses the end of a line but not its terminator', () => {
    const index = lineIndex('ab\r\ncd');
    assert.equal(index.offsetAt({ line: 0, column: 2 }), 2);
    assert.equal(index.offsetAt({ line: 0, column: 3 }), undefined);
    assert.equal(index.offsetAt({ line: 1, column: 2 }), 6);
    assert.equal(index.offsetAt({ line: 1, column: 3 }), undefined);
    assert.equal(index.offsetAt({ line: 2, column: 0 }), undefined);
    assert.equal(index.offsetAt({ line: 0, column: -1 }), undefined);
    assert.equal(index.offsetAt({ line: 0, column: 0.5 }), undefined);
  });

  it('indexes an empty text as one empty line', () => {
    const index = lineIndex('');
    assert.deepEqual(index.lineStarts, [0]);
    assert.equal(index.offsetAt({ line: 0, column: 0 }), 0);
  });

  it('round-trips every offset that is not inside a terminator', async (t) => {
    const pieces = ['a', 'Z', ' ', '\n', '\r', '\r\n', '\u2028', '\u2029', 'é', '𝒳', '{'];
    await forEachSeed(t, (random) => {
      let text = '';
      const length = random.int(0, 60);
      for (let index = 0; index < length; index += 1) {
        text += random.pick(pieces);
      }
      const index = lineIndex(text);
      for (let offset = 0; offset <= text.length; offset += 1) {
        const insideCrlf = text[offset - 1] === '\r' && text[offset] === '\n';
        const position = index.positionAt(offset);
        if (insideCrlf) {
          // The LF of a CRLF belongs to the terminator, not to an addressable column.
          assert.equal(index.offsetAt(position), undefined);
          continue;
        }
        assert.equal(index.offsetAt(position), offset);
      }
    });
  });
});
