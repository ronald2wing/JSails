/**
 * Tests for the `.jsails` column maps: the shadow-to-source version 3 map
 * (points at every token boundary, line start and span start, unmapped
 * header and footer, alias names), its composition with oxc's real output
 * map, seeded properties that both maps agree with the span table at every
 * mapped offset, and the rejection of input maps the composer cannot read.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { transformSync } from 'rolldown/utils';

import {
  composeSourceMap,
  lookupMapping,
  shadowSourceMap,
} from '../../../src/compiler/sfc/column-map.js';
import { lineIndex, type LineIndex } from '../../../src/compiler/sfc/line-index.js';
import { SegmentMapError } from '../../../src/compiler/sfc/segments-error.js';
import {
  assembleShadow,
  generatedToOriginal,
  SpanKind,
  type Shadow,
} from '../../../src/compiler/sfc/segments.js';
import {
  decodeMappings,
  encodeMappings,
  type MappingPoint,
} from '../../../src/compiler/sfc/vlq.js';
import { forEachSeed } from '../../../src/testing/seeded-random.js';
import { OWNERS, PAGE, pageShadow, pageSpan, randomParts } from './shadow-fixtures.js';

/** The source position a generated shadow offset maps to by the span table, or undefined. */
function expectedPoint(
  shadow: Shadow,
  indexes: readonly LineIndex[],
  offset: number,
): readonly [number, number, number] | undefined {
  const location = generatedToOriginal(shadow, offset);
  if (location.fidelity === 'none') {
    return undefined;
  }
  const index = indexes[location.source];
  assert.ok(index !== undefined);
  const position = index.positionAt(location.start);
  return [location.source, position.line, position.column];
}

function sourceIndexes(shadow: Shadow): LineIndex[] {
  return shadow.sources.map((source) => lineIndex(source.text));
}

function pointFields(point: MappingPoint | undefined): readonly number[] | undefined {
  return point === undefined ? undefined : point.slice(1, 4);
}

/**
 * A word: a run of identifier characters, ASCII or not, excluding the
 * non-ASCII whitespace (NBSP, U+2028, U+2029, BOM). A stack frame or an oxc
 * mapping points at the start of one.
 */
const WORD = /[\w$\u0080-\u009f\u00a1-\u2027\u202a-\ufefe\uff00-\uffff]+/g;

describe('shadowSourceMap', () => {
  it('records file, sources and sourcesContent, and can leave the content out', () => {
    const shadow = pageShadow();
    const map = shadowSourceMap(shadow, { file: 'post.jsails.tsx' });
    assert.equal(map.version, 3);
    assert.equal(map.file, 'post.jsails.tsx');
    assert.deepEqual(map.sources, ['pages/post.jsails']);
    assert.deepEqual(map.sourcesContent, [PAGE.text]);
    assert.ok(Object.isFrozen(map));
    const bare = shadowSourceMap(shadow, { file: 'x', sourcesContent: false });
    assert.equal('sourcesContent' in bare, false);
    assert.equal(JSON.parse(JSON.stringify(bare)).mappings, map.mappings);
  });

  it('names each Alias mapping after its source name', () => {
    const shadow = pageShadow();
    const map = shadowSourceMap(shadow, { file: 'x' });
    assert.deepEqual([...map.names].sort(), ['page', 'pgae', 'title']);
    const generated = lineIndex(shadow.text);
    const decoded = decodeMappings(map.mappings);
    const point = lookupMapping(
      decoded,
      generated.positionAt(shadow.text.indexOf('__props.pgae') + 8),
    );
    assert.equal(point?.length, 5);
    assert.equal(map.names[point?.[4] ?? -1], 'pgae');
  });

  it('agrees with the span table at every point, boundary, line start and span start', async (t) => {
    await forEachSeed(t, (random) => {
      for (let round = 0; round < 30; round += 1) {
        const shadow = assembleShadow(randomParts(random));
        const map = shadowSourceMap(shadow, { file: 'x' });
        const decoded = decodeMappings(map.mappings);
        const generated = lineIndex(shadow.text);
        const indexes = sourceIndexes(shadow);
        assert.equal(decoded.length, generated.lineStarts.length);

        // Every mapped point says what the span table says at its offset.
        decoded.forEach((points, line) => {
          for (const point of points) {
            const offset = generated.offsetAt({ line, column: point[0] });
            assert.ok(offset !== undefined, 'a point addresses a real shadow position');
            if (point.length === 1) {
              assert.equal(generatedToOriginal(shadow, offset).fidelity, 'none');
            } else {
              assert.deepEqual(point.slice(1, 4), expectedPoint(shadow, indexes, offset));
            }
          }
        });

        // Header and footer resolve to nothing; span starts and line starts resolve exactly.
        const must = new Set<number>();
        for (const span of shadow.spans) {
          must.add(span.generatedStart);
          for (const start of generated.lineStarts) {
            if (start > span.generatedStart && start < span.generatedEnd) {
              must.add(start);
            }
          }
          if (span.kind === SpanKind.Verbatim) {
            const text = shadow.text.slice(span.generatedStart, span.generatedEnd);
            for (const match of text.matchAll(WORD)) {
              must.add(span.generatedStart + match.index);
            }
          }
        }
        for (let offset = 0; offset < shadow.text.length; offset += 1) {
          if (generated.offsetAt(generated.positionAt(offset)) !== offset) {
            continue; // the LF of a CRLF: no line and column address it
          }
          const found = lookupMapping(decoded, generated.positionAt(offset));
          if (offset < shadow.bodyStart || offset >= shadow.bodyEnd) {
            assert.equal(found, undefined, 'header and footer are unmapped');
          } else if (must.has(offset)) {
            assert.deepEqual(pointFields(found), expectedPoint(shadow, indexes, offset));
          } else {
            assert.ok(found !== undefined, 'every body offset is covered by a mapping');
          }
        }
      }
    });
  });

  it('maps every line of a multi-line template literal to its own source line', () => {
    const shadow = pageShadow();
    const decoded = decodeMappings(shadowSourceMap(shadow, { file: 'x' }).mappings);
    const generated = lineIndex(shadow.text);
    const source = lineIndex(PAGE.text);
    for (const needle of ['first', 'second', 'third']) {
      const point = lookupMapping(decoded, generated.positionAt(shadow.text.indexOf(needle)));
      const position = source.positionAt(pageSpan(needle).start);
      assert.deepEqual(pointFields(point), [0, position.line, position.column]);
    }
    const literal = pageSpan('`first\nsecond\r\nthird`');
    const start = shadow.text.indexOf('`first');
    const lines = (text: string): number => lineIndex(text).lineStarts.length;
    assert.equal(
      lines(shadow.text.slice(start, start + literal.end - literal.start)),
      lines(PAGE.text.slice(literal.start, literal.end)),
    );
  });
});

describe('composeSourceMap', () => {
  it('composes an identity input map into the span table, offset by offset', async (t) => {
    await forEachSeed(t, (random) => {
      for (let round = 0; round < 30; round += 1) {
        const shadow = assembleShadow(randomParts(random));
        const generated = lineIndex(shadow.text);
        // A map whose generated text is the shadow itself, with a point per code unit.
        const identity: MappingPoint[][] = generated.lineStarts.map(() => []);
        for (let offset = 0; offset <= shadow.text.length; offset += 1) {
          const position = generated.positionAt(offset);
          if (generated.offsetAt(position) === offset) {
            identity[position.line]?.push([position.column, 0, position.line, position.column]);
          }
        }
        const composed = composeSourceMap(
          shadow,
          { version: 3, sources: ['x.tsx'], mappings: encodeMappings(identity) },
          { file: 'x.js' },
        );
        const decoded = decodeMappings(composed.mappings);
        const indexes = sourceIndexes(shadow);
        for (let offset = 0; offset < shadow.text.length; offset += 1) {
          const position = generated.positionAt(offset);
          if (generated.offsetAt(position) !== offset) {
            continue;
          }
          assert.deepEqual(
            pointFields(lookupMapping(decoded, position)),
            expectedPoint(shadow, indexes, offset),
          );
        }
      }
    });
  });

  it('maps oxc output back to .jsails lines and columns', () => {
    const shadow = pageShadow();
    const result = transformSync('post.jsails.tsx', shadow.text, {
      lang: 'tsx',
      jsx: { runtime: 'automatic', importSource: 'jsails' },
      sourcemap: true,
    });
    assert.deepEqual(result.errors, []);
    assert.ok(result.map !== undefined && result.map !== null);
    const composed = composeSourceMap(shadow, result.map, { file: 'post.js' });
    assert.deepEqual(composed.sources, ['pages/post.jsails']);
    const decoded = decodeMappings(composed.mappings);
    const js = lineIndex(result.code);
    const source = lineIndex(PAGE.text);
    const resolve = (needle: string, nth = 0): readonly number[] | undefined => {
      let offset = -1;
      for (let count = 0; count <= nth; count += 1) {
        offset = result.code.indexOf(needle, offset + 1);
      }
      assert.ok(offset >= 0, 'needle in compiled output');
      return pointFields(lookupMapping(decoded, js.positionAt(offset)));
    };
    const at = (offset: number): readonly number[] => {
      const position = source.positionAt(offset);
      return [0, position.line, position.column];
    };

    // Verbatim template expressions and script code land on their exact columns.
    assert.deepEqual(resolve('formatDate(page.date)'), at(pageSpan('formatDate(page.date)').start));
    assert.deepEqual(resolve('page.count'), at(pageSpan('page.count').start));
    assert.deepEqual(resolve('pgae.title'), at(pageSpan('pgae.title').start));
    // Code after the multi-line literal keeps its line: the literal's line count survived.
    assert.deepEqual(resolve('total'), at(pageSpan('total').start));
    assert.deepEqual(resolve('total', 1), at(pageSpan('total', 1).start));
    // Generated code lands on its owner: the renderList call on the <ul>, the callback's element
    // on the <li>. (oxc puts no mapping on the arrow's punctuation, so that is not asserted.)
    assert.deepEqual(resolve('renderList('), at(OWNERS.ul.start));
    assert.deepEqual(resolve('_jsx("li"'), at(OWNERS.li.start));
    // §3.3 rule 2 survives compilation: the name after `__props.` lands on the template name.
    const props = result.code.indexOf('__props.pgae');
    assert.ok(props >= 0);
    const propertyName = lookupMapping(decoded, js.positionAt(props + '__props.'.length));
    assert.deepEqual(pointFields(propertyName), at(pageSpan('pgae').start));
    assert.equal(composed.names[propertyName?.[4] ?? -1], 'pgae');
    // §3.3 rule 1: the lowered attribute name lands on the name after `:`.
    assert.deepEqual(resolve('title: 42'), at(pageSpan(':title').start + 1));
    // §6.3 item 2: the generated component name lands on the <template> tag.
    assert.deepEqual(resolve('Post('), at(OWNERS.templateTag.start));
    // The style import in the footer is unmapped.
    assert.equal(resolve('import "./post.css"'), undefined);
  });

  it('rejects an input map it cannot read, without echoing it', () => {
    const shadow = pageShadow();
    const reject = (input: Parameters<typeof composeSourceMap>[1]): void => {
      assert.throws(
        () => composeSourceMap(shadow, input, { file: 'x' }),
        (error: unknown) =>
          error instanceof SegmentMapError &&
          error.code === 'unsupported_sourcemap' &&
          (input.mappings.length < 4 || !error.message.includes(input.mappings)),
      );
    };
    reject({ version: 2, sources: ['a'], mappings: 'AAAA' });
    reject({ version: 3, sources: ['a', 'b'], mappings: 'AAAA' });
    reject({ version: 3, sources: [], mappings: '' });
    reject({ version: 3, sources: ['a'], mappings: 'ACAA' });
    reject({ version: 3, sources: ['a'], mappings: 'AA9999' });
    reject({ version: 3, sources: ['a'], mappings: 'AAAA,AAg/EA' });
    reject({ version: 3, sources: ['a'], mappings: 'AA' });
  });
});

describe('lookupMapping', () => {
  it('returns the last point at or before the column, and nothing after an unmapped point', () => {
    const decoded = decodeMappings('AAAA,EAAE,E;AACA');
    assert.deepEqual(lookupMapping(decoded, { line: 0, column: 1 }), [0, 0, 0, 0]);
    assert.deepEqual(lookupMapping(decoded, { line: 0, column: 3 }), [2, 0, 0, 2]);
    assert.equal(lookupMapping(decoded, { line: 0, column: 4 }), undefined);
    assert.deepEqual(lookupMapping(decoded, { line: 1, column: 9 }), [0, 0, 1, 2]);
    assert.equal(lookupMapping(decoded, { line: 7, column: 0 }), undefined);
  });
});
