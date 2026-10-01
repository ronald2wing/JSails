/**
 * Tests for the source-map `mappings` codec: known encodings, the
 * encode/decode round trip over seeded mapping lines, and the value-free
 * rejection of malformed input.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SegmentMapError } from '../../../src/compiler/sfc/segments-error.js';
import {
  decodeMappings,
  encodeMappings,
  encodeVlq,
  type MappingPoint,
} from '../../../src/compiler/sfc/vlq.js';
import { forEachSeed } from '../../../src/testing/seeded-random.js';

describe('encodeVlq', () => {
  it('encodes the specification examples', () => {
    assert.equal(encodeVlq(0), 'A');
    assert.equal(encodeVlq(1), 'C');
    assert.equal(encodeVlq(-1), 'D');
    assert.equal(encodeVlq(15), 'e');
    assert.equal(encodeVlq(16), 'gB');
    assert.equal(encodeVlq(-16), 'hB');
    assert.equal(encodeVlq(123456), 'gkxH');
  });
});

describe('decodeMappings', () => {
  it('decodes oxc output into absolute points', () => {
    assert.deepEqual(decodeMappings(';AAAA,MAAM;AACM,IAAIA'), [
      [],
      [
        [0, 0, 0, 0],
        [6, 0, 0, 6],
      ],
      [
        [0, 0, 1, 12],
        [4, 0, 1, 16, 0],
      ],
    ]);
  });

  it('keeps generated-only points and empty lines', () => {
    assert.deepEqual(decodeMappings('AAAA,E;;C'), [[[0, 0, 0, 0], [2]], [], [[1]]]);
  });

  it('rejects malformed input with a value-free error', () => {
    for (const bad of [
      'AA',
      'AAA',
      'AAAAAA',
      '!',
      'g',
      'AAAA,,AAAA',
      'AAAA,',
      'AAAA,;AAAA',
      ',AAAA',
      'D',
      'AADA',
      'ggggggggA',
    ]) {
      assert.throws(
        () => decodeMappings(bad),
        (error: unknown) =>
          error instanceof SegmentMapError &&
          error.code === 'unsupported_sourcemap' &&
          error.message === 'source map mappings are malformed',
        bad,
      );
    }
  });

  it('round-trips seeded mapping lines through encodeMappings', async (t) => {
    await forEachSeed(t, (random) => {
      const lines: MappingPoint[][] = [];
      const lineCount = random.int(1, 12);
      for (let line = 0; line < lineCount; line += 1) {
        const points: MappingPoint[] = [];
        let column = 0;
        const pointCount = random.int(0, 8);
        for (let index = 0; index < pointCount; index += 1) {
          column += random.int(0, 40);
          const shape = random.int(0, 3);
          if (shape === 0) {
            points.push([column]);
          } else if (shape === 1) {
            points.push([column, random.int(0, 3), random.int(0, 500), random.int(0, 300)]);
          } else {
            points.push([
              column,
              random.int(0, 3),
              random.int(0, 500),
              random.int(0, 300),
              random.int(0, 20),
            ]);
          }
        }
        lines.push(points);
      }
      assert.deepEqual(decodeMappings(encodeMappings(lines)), lines);
    });
  });
});
