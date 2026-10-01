/**
 * Tests for the `.jsails` segment model: the constructors' invariants, shadow
 * assembly and span merging, the seeded properties (no generated overlap,
 * every body offset covered, Verbatim text equal to its source slice, the
 * span table agreeing with the segment list, original positions
 * round-tripping), shadow edits keeping the table exact, and the
 * `docs/design/sfc.md` §3.3 rules and §6.3 items as properties of a lowered
 * page.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SegmentMapError } from '../../../src/compiler/sfc/segments-error.js';
import {
  ALIAS_FEATURES,
  alias,
  assembleShadow,
  atom,
  editShadow,
  generatedRangeToOriginal,
  generatedToOriginal,
  isVerbatimRange,
  segmentSource,
  SpanFeature,
  SpanKind,
  spanIndexAt,
  spanMappings,
  verbatim,
  VERBATIM_FEATURES,
  type MappedSegment,
  type Shadow,
  type ShadowEdit,
} from '../../../src/compiler/sfc/segments.js';
import { sourceSpan } from '../../../src/compiler/sfc/source-span.js';
import { forEachSeed, type SeededRandom } from '../../../src/testing/seeded-random.js';
import {
  DECLARATION_FEATURES,
  OWNERS,
  PAGE,
  PAGE_FOOTER,
  PAGE_HEADER,
  pageShadow,
  pageSpan,
  oracle,
  randomParts,
  randomText,
} from './shadow-fixtures.js';

/** Assert that `fn` throws the value-free `invalid_segment` error. */
function assertInvalid(fn: () => unknown, secret?: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof SegmentMapError);
    assert.equal(error.code, 'invalid_segment');
    if (secret !== undefined) {
      assert.ok(!error.message.includes(secret));
      assert.ok(!JSON.stringify(error.context).includes(secret));
    }
    return true;
  });
}

describe('source spans', () => {
  it('rejects a reversed, negative or fractional span', () => {
    assert.throws(() => sourceSpan(3, 2), RangeError);
    assert.throws(() => sourceSpan(-1, 2), RangeError);
    assert.throws(() => sourceSpan(0.5, 2), RangeError);
    assert.deepEqual(sourceSpan(2, 2), { start: 2, end: 2 });
    assert.ok(Object.isFrozen(sourceSpan(0, 1)));
  });
});

describe('segment constructors', () => {
  const secret = 'sk_live_SECRET';
  const source = segmentSource('ui/card.jsails', `const key = '${secret}';`);

  it('copies a Verbatim slice byte for byte', () => {
    const segment = verbatim(source, sourceSpan(6, 9));
    assert.equal(segment.text, 'key');
    assert.equal(segment.kind, SpanKind.Verbatim);
    assert.equal(segment.features, VERBATIM_FEATURES);
    assert.equal(segment.features & SpanFeature.Formatting, 0);
    assert.ok(Object.isFrozen(segment));
  });

  it('defaults Alias to semantic features and Atom to none', () => {
    assert.equal(alias('key', source, sourceSpan(6, 9)).features, ALIAS_FEATURES);
    assert.equal(alias('key', source, sourceSpan(6, 9)).features & SpanFeature.Completion, 0);
    assert.equal(atom('x', source, sourceSpan(0, 5)).features, SpanFeature.None);
  });

  it('rejects empty, out-of-range and ill-featured segments without echoing the source', () => {
    assertInvalid(() => verbatim(source, sourceSpan(3, 3)), secret);
    assertInvalid(() => verbatim(source, sourceSpan(0, 999)), secret);
    assertInvalid(() => alias('', source, sourceSpan(0, 1)), secret);
    assertInvalid(() => atom('x', source, sourceSpan(0, 1), 1 << 20), secret);
    assertInvalid(() => atom('x', source, sourceSpan(0, 1), -1), secret);
    assertInvalid(() => atom('x', source, sourceSpan(0, 1), 0.5), secret);
  });

  it('names a source by a normalized POSIX relative path only', () => {
    for (const name of [
      '',
      'ui\\card.jsails',
      '/abs/card.jsails',
      'C:/card.jsails',
      'c:card.jsails',
      'file:///card.jsails',
      './ui/card.jsails',
      '../card.jsails',
      'ui/../card.jsails',
      'ui//card.jsails',
      'ui/card.jsails/',
      'ui/card\0.jsails',
    ]) {
      assertInvalid(() => segmentSource(name, ''));
    }
    for (const name of ['card.jsails', 'pages/blog/[slug].jsails', 'pages/post/post.ts', '.x/a']) {
      assert.equal(segmentSource(name, '').name, name);
    }
  });
});

describe('assembleShadow', () => {
  it('concatenates header, body and footer and covers exactly the body', () => {
    const shadow = pageShadow();
    assert.ok(shadow.text.startsWith(PAGE_HEADER));
    assert.ok(shadow.text.endsWith(PAGE_FOOTER));
    assert.equal(shadow.bodyStart, PAGE_HEADER.length);
    assert.equal(shadow.bodyEnd, shadow.text.length - PAGE_FOOTER.length);
    assert.equal(shadow.spans[0]?.generatedStart, shadow.bodyStart);
    assert.equal(shadow.spans.at(-1)?.generatedEnd, shadow.bodyEnd);
    assert.deepEqual(shadow.sources, [PAGE]);
  });

  it('merges contiguous Verbatim slices and same-owner Atoms, never Aliases', () => {
    const source = segmentSource('ui/a.jsails', 'abcdef');
    const shadow = assembleShadow({
      header: '',
      body: [
        verbatim(source, sourceSpan(0, 2)),
        verbatim(source, sourceSpan(2, 4)),
        verbatim(source, sourceSpan(5, 6)),
        atom('x', source, sourceSpan(0, 6)),
        atom('y', source, sourceSpan(0, 6)),
        atom('z', source, sourceSpan(0, 5)),
        atom('w', source, sourceSpan(0, 5), SpanFeature.Definition),
        alias('n', source, sourceSpan(1, 2)),
        alias('n', source, sourceSpan(1, 2)),
      ],
      footer: '',
    });
    assert.deepEqual(
      shadow.spans.map((span) => [
        span.generatedStart,
        span.generatedEnd,
        span.kind,
        span.originalStart,
        span.originalEnd,
      ]),
      [
        [0, 4, SpanKind.Verbatim, 0, 4],
        [4, 5, SpanKind.Verbatim, 5, 6],
        [5, 7, SpanKind.Atom, 0, 6],
        [7, 8, SpanKind.Atom, 0, 5],
        [8, 9, SpanKind.Atom, 0, 5],
        [9, 10, SpanKind.Alias, 1, 2],
        [10, 11, SpanKind.Alias, 1, 2],
      ],
    );
  });

  it('re-checks a hand-built segment whose Verbatim text is not its slice', () => {
    const source = segmentSource('ui/a.jsails', 'secret-value');
    const forged: MappedSegment = { ...verbatim(source, sourceSpan(0, 6)), text: 'public' };
    assertInvalid(() => assembleShadow({ header: '', body: [forged], footer: '' }), 'secret');
    const badKind = { ...atom('x', source, sourceSpan(0, 1)), kind: 7 } as unknown as MappedSegment;
    assertInvalid(() => assembleShadow({ header: '', body: [badKind], footer: '' }));
    const reversed: MappedSegment = {
      ...atom('x', source, sourceSpan(0, 1)),
      span: { start: 4, end: 2 },
    };
    assertInvalid(() => assembleShadow({ header: '', body: [reversed], footer: '' }));
  });

  it('rejects two distinct sources with one name', () => {
    const one = segmentSource('ui/a.jsails', 'a');
    const two = segmentSource('ui/a.jsails', 'b');
    assertInvalid(() =>
      assembleShadow({
        header: '',
        body: [verbatim(one, sourceSpan(0, 1)), verbatim(two, sourceSpan(0, 1))],
        footer: '',
      }),
    );
  });

  it('assembles an empty body as header and footer with no spans', () => {
    const shadow = assembleShadow({ header: 'h\n', body: [], footer: 'f\n' });
    assert.equal(shadow.text, 'h\nf\n');
    assert.deepEqual(shadow.spans, []);
    assert.deepEqual(generatedToOriginal(shadow, 1), { fidelity: 'none' });
  });
});

describe('segment properties (seeded)', () => {
  it('never overlaps, covers every body offset, and keeps Verbatim bytes', async (t) => {
    await forEachSeed(t, (random) => {
      for (let round = 0; round < 40; round += 1) {
        const parts = randomParts(random);
        const shadow = assembleShadow(parts);
        assert.equal(
          shadow.text,
          parts.header + parts.body.map((segment) => segment.text).join('') + parts.footer,
        );
        let cursor = shadow.bodyStart;
        for (const span of shadow.spans) {
          assert.equal(span.generatedStart, cursor, 'no gap and no overlap');
          assert.ok(span.generatedEnd > span.generatedStart, 'no empty span');
          assert.ok(span.originalEnd > span.originalStart);
          const source = shadow.sources[span.source];
          assert.ok(source !== undefined);
          assert.ok(span.originalEnd <= source.text.length);
          if (span.kind === SpanKind.Verbatim) {
            assert.equal(
              shadow.text.slice(span.generatedStart, span.generatedEnd),
              source.text.slice(span.originalStart, span.originalEnd),
            );
          }
          cursor = span.generatedEnd;
        }
        assert.equal(cursor, shadow.bodyEnd);
      }
    });
  });

  it('maps every generated offset as the segment list says', async (t) => {
    await forEachSeed(t, (random) => {
      for (let round = 0; round < 40; round += 1) {
        const parts = randomParts(random);
        const shadow = assembleShadow(parts);
        for (let offset = 0; offset <= shadow.text.length; offset += 1) {
          const expected = oracle(parts, offset);
          const actual = generatedToOriginal(shadow, offset);
          if (expected === undefined) {
            assert.deepEqual(actual, { fidelity: 'none' });
            assert.equal(spanIndexAt(shadow, offset), -1);
            continue;
          }
          assert.notEqual(actual.fidelity, 'none');
          if (actual.fidelity === 'none') {
            continue;
          }
          assert.equal(shadow.sources[actual.source], expected.source);
          assert.equal(actual.start, expected.offset);
          assert.equal(actual.kind, expected.kind);
          assert.equal(actual.fidelity, expected.kind === SpanKind.Verbatim ? 'exact' : 'atom');
        }
      }
    });
  });

  it('round-trips every Verbatim original offset through its generated offset', async (t) => {
    await forEachSeed(t, (random) => {
      for (let round = 0; round < 40; round += 1) {
        const shadow = assembleShadow(randomParts(random));
        for (const span of shadow.spans) {
          if (span.kind !== SpanKind.Verbatim) {
            continue;
          }
          for (let original = span.originalStart; original < span.originalEnd; original += 1) {
            const generated = span.generatedStart + original - span.originalStart;
            const back = generatedToOriginal(shadow, generated);
            assert.equal(back.fidelity, 'exact');
            assert.equal(back.fidelity === 'exact' ? back.start : -1, original);
          }
        }
      }
    });
  });

  it('derives SpanMapping tuples per source, in generated order', async (t) => {
    await forEachSeed(t, (random) => {
      for (let round = 0; round < 20; round += 1) {
        const shadow = assembleShadow(randomParts(random));
        let total = 0;
        shadow.sources.forEach((source, index) => {
          const tuples = spanMappings(shadow, source);
          const own = shadow.spans.filter((span) => span.source === index);
          assert.equal(tuples.length, own.length);
          tuples.forEach((tuple, position) => {
            const span = own[position];
            assert.ok(span !== undefined);
            assert.deepEqual(tuple, [
              span.generatedStart,
              span.generatedEnd - span.generatedStart,
              span.originalStart,
              span.originalEnd - span.originalStart,
              span.kind,
              span.features,
            ]);
          });
          total += tuples.length;
        });
        assert.equal(total, shadow.spans.length);
        assert.deepEqual(spanMappings(shadow, segmentSource('other.jsails', '')), []);
      }
    });
  });
});

describe('the §3.3 rules on a lowered page', () => {
  const shadow = pageShadow();
  const at = (needle: string, nth = 0): number => {
    let found = -1;
    for (let count = 0; count <= nth; count += 1) {
      found = shadow.text.indexOf(needle, found + 1);
    }
    assert.ok(found >= 0);
    return found;
  };

  it('rule 2: the property name after __props. maps to the name in the template', () => {
    // TS2339 for `pgae` is reported at the name after `__props.`.
    const location = generatedRangeToOriginal(
      shadow,
      at('__props.pgae') + 8,
      at('__props.pgae') + 12,
    );
    assert.equal(location.fidelity, 'atom');
    assert.equal(location.fidelity === 'atom' ? location.kind : -1, SpanKind.Alias);
    assert.deepEqual(location.fidelity === 'atom' ? [location.start, location.end] : [], [
      pageSpan('pgae').start,
      pageSpan('pgae').end,
    ]);
    // `__props.` itself is generated code owned by the template.
    const owner = generatedToOriginal(shadow, at('__props.pgae'));
    assert.equal(owner.fidelity === 'atom' ? owner.start : -1, OWNERS.template.start);
  });

  it('rule 1: a lowered attribute name maps to the name in the source attribute', () => {
    const location = generatedRangeToOriginal(shadow, at('title={'), at('title={') + 5);
    assert.deepEqual(
      location.fidelity === 'atom' ? [location.kind, location.start, location.end] : [],
      [SpanKind.Alias, pageSpan(':title').start + 1, pageSpan(':title').end],
    );
  });

  it('a template expression maps exactly', () => {
    const location = generatedToOriginal(shadow, at('page.count') + 5);
    assert.deepEqual(location.fidelity === 'exact' ? [location.start] : [], [
      pageSpan('page.count').start + 5,
    ]);
  });

  it('rule 3: a cascade in the js-for callback maps to the <li js-for> owner', () => {
    const location = generatedToOriginal(shadow, at(') => <li>{') + 3);
    assert.equal(location.fidelity, 'atom');
    assert.equal(location.fidelity === 'atom' ? location.start : -1, OWNERS.li.start);
  });

  it('only the header and footer are unmapped', () => {
    assert.deepEqual(generatedToOriginal(shadow, 0), { fidelity: 'none' });
    assert.deepEqual(generatedToOriginal(shadow, shadow.bodyStart - 1), { fidelity: 'none' });
    assert.deepEqual(generatedToOriginal(shadow, shadow.bodyEnd), { fidelity: 'none' });
    for (let offset = shadow.bodyStart; offset < shadow.bodyEnd; offset += 1) {
      assert.notEqual(generatedToOriginal(shadow, offset).fidelity, 'none');
    }
  });

  it('§6.3 item 2: the generated component name is an Atom with navigation features', () => {
    const name = at('function Post') + 9;
    const span = shadow.spans[spanIndexAt(shadow, name)];
    assert.ok(span !== undefined);
    assert.equal(span.kind, SpanKind.Atom);
    assert.equal(span.features, DECLARATION_FEATURES);
    assert.equal(span.originalStart, OWNERS.templateTag.start);
    const tuple = spanMappings(shadow, PAGE).find((entry) => entry[0] === name);
    assert.deepEqual(tuple?.slice(4), [SpanKind.Atom, DECLARATION_FEATURES]);
  });

  it('maps a range across spans approximately and outside the body to none', () => {
    const start = at('{formatDate');
    const location = generatedRangeToOriginal(shadow, start, start + 12);
    assert.equal(location.fidelity, 'approximate');
    assert.deepEqual(location.fidelity === 'approximate' ? [location.start, location.end] : [], [
      OWNERS.p.start,
      pageSpan('formatDate(page.date)').start + 11,
    ]);
    assert.deepEqual(generatedRangeToOriginal(shadow, 0, shadow.bodyStart + 2), {
      fidelity: 'none',
    });
    assert.deepEqual(generatedRangeToOriginal(shadow, shadow.bodyEnd - 1, shadow.bodyEnd + 1), {
      fidelity: 'none',
    });
  });

  it('allows an edit only inside contiguous Verbatim text', () => {
    const expression = at('formatDate(page.date)');
    assert.equal(isVerbatimRange(shadow, expression, expression + 21), true);
    assert.equal(isVerbatimRange(shadow, expression - 1, expression + 3), false);
    assert.equal(isVerbatimRange(shadow, expression, expression), false);
    assert.equal(isVerbatimRange(shadow, at('__props.pgae'), at('__props.pgae') + 3), false);
    assert.equal(isVerbatimRange(shadow, 0, 3), false);
  });
});

describe('a multi-line template literal', () => {
  it('keeps its bytes and its line count in the shadow', () => {
    const shadow = pageShadow();
    const literal = pageSpan('`first\nsecond\r\nthird`');
    const generated = shadow.text.indexOf('`first');
    assert.equal(
      shadow.text.slice(generated, generated + literal.end - literal.start),
      PAGE.text.slice(literal.start, literal.end),
    );
    const location = generatedToOriginal(shadow, generated + 'first\nsecond\r\n'.length + 1);
    assert.equal(location.fidelity === 'exact' ? location.start : -1, pageSpan('third').start);
  });
});

/** Apply `edits` to `text` naively, as the expected edited text. */
function splice(text: string, edits: readonly ShadowEdit[]): string {
  let out = '';
  let cursor = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}

/** Non-overlapping random edits: inside single body spans, and in the header or footer. */
function randomEdits(random: SeededRandom, shadow: Shadow): ShadowEdit[] {
  const edits: ShadowEdit[] = [];
  let floor = 0;
  const regions: { start: number; end: number; body: boolean }[] = [
    { start: 0, end: shadow.bodyStart, body: false },
    ...shadow.spans.map((span) => ({
      start: span.generatedStart,
      end: span.generatedEnd,
      body: true,
    })),
    { start: shadow.bodyEnd, end: shadow.text.length, body: false },
  ];
  for (const region of regions) {
    if (random.int(0, 3) !== 0 || region.end < Math.max(floor, region.start)) continue;
    const from = Math.max(floor, region.start);
    if (region.body && from >= region.end) continue;
    const start = random.int(from, region.body ? region.end : region.end + 1);
    const end = region.body
      ? random.int(start + 1, region.end + 1)
      : random.int(start, region.end + 1);
    const text = region.body ? randomText(random, 1, 3) : randomText(random, 0, 3);
    edits.push({ start, end, text });
    floor = end;
  }
  return edits;
}

describe('editShadow', () => {
  it('keeps every invariant and every unedited mapping (seeded)', async (t) => {
    await forEachSeed(t, (random) => {
      for (let round = 0; round < 40; round += 1) {
        const shadow = assembleShadow(randomParts(random));
        const edits = randomEdits(random, shadow);
        const edited = editShadow(shadow, edits);
        assert.equal(edited.text, splice(shadow.text, edits));
        let cursor = edited.bodyStart;
        for (const span of edited.spans) {
          assert.equal(span.generatedStart, cursor, 'no gap and no overlap');
          assert.ok(span.generatedEnd > span.generatedStart, 'no empty span');
          if (span.kind === SpanKind.Verbatim) {
            assert.equal(
              edited.text.slice(span.generatedStart, span.generatedEnd),
              edited.sources[span.source]?.text.slice(span.originalStart, span.originalEnd),
            );
          }
          cursor = span.generatedEnd;
        }
        assert.equal(cursor, edited.bodyEnd);
        // Each unedited original offset maps where it mapped before; each
        // edited body range maps to the original its first code unit had.
        let shift = 0;
        let before = 0;
        for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
          for (let offset = before; offset < edit.start; offset += 1) {
            assert.deepEqual(
              generatedToOriginal(edited, offset + shift),
              generatedToOriginal(shadow, offset),
            );
          }
          if (
            edit.start >= shadow.bodyStart &&
            edit.end <= shadow.bodyEnd &&
            edit.end > edit.start
          ) {
            const original = generatedToOriginal(shadow, edit.start);
            const mapped = generatedToOriginal(edited, edit.start + shift);
            assert.ok(original.fidelity !== 'none' && mapped.fidelity !== 'none');
            assert.equal(mapped.start, original.start);
            assert.equal(mapped.source, original.source);
          }
          shift += edit.text.length - (edit.end - edit.start);
          before = edit.end;
        }
        for (let offset = before; offset <= shadow.text.length; offset += 1) {
          assert.deepEqual(
            generatedToOriginal(edited, offset + shift),
            generatedToOriginal(shadow, offset),
          );
        }
      }
    });
  });

  it('turns an edited Verbatim slice into an Atom owned by that slice', () => {
    const shadow = pageShadow();
    const at = shadow.text.indexOf("'../shared/format.js'");
    const literal = "'../shared/format.js'";
    const edited = editShadow(shadow, [
      { start: at, end: at + literal.length, text: "'../shared/x.js'" },
    ]);
    const span = edited.spans[spanIndexAt(edited, at)];
    assert.equal(span?.kind, SpanKind.Atom);
    assert.equal(span?.generatedEnd, at + "'../shared/x.js'".length);
    assert.equal(PAGE.text.slice(span?.originalStart, span?.originalEnd), literal);
    const after = generatedToOriginal(edited, edited.text.indexOf('const total'));
    assert.deepEqual(after, generatedToOriginal(shadow, shadow.text.indexOf('const total')));
  });

  it('rejects overlapping, cross-span and empty body edits without echoing the text', () => {
    const shadow = pageShadow();
    const body = shadow.bodyStart;
    assertInvalid(() =>
      editShadow(shadow, [
        { start: body, end: body + 4, text: 'a' },
        { start: body + 2, end: body + 6, text: 'b' },
      ]),
    );
    const first = shadow.spans[0];
    assert.ok(first !== undefined);
    assertInvalid(
      () =>
        editShadow(shadow, [
          { start: first.generatedEnd - 1, end: first.generatedEnd + 1, text: 'secret' },
        ]),
      'secret',
    );
    assertInvalid(() => editShadow(shadow, [{ start: body + 1, end: body + 1, text: 'x' }]));
    assertInvalid(() => editShadow(shadow, [{ start: body, end: body + 1, text: '' }]));
    assertInvalid(() => editShadow(shadow, [{ start: 0, end: shadow.text.length + 1, text: 'x' }]));
  });
});
