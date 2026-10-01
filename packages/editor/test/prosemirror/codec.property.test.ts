/**
 * The codec law over seeded documents from the `jsails/testing` generator
 * (10 000 across the fixed seeds and one fresh seed, and as many per seed
 * when one seed is replayed with `JSAILS_TEST_SEED`): for every canonical
 * document `d`, `schema.nodeFromJSON(encode(d))` passes `check()`, decodes
 * back to exactly `d`, and its `toJSON()` is exactly `encode(d)`. A
 * non-canonical document encodes to its canonical content. Plus the
 * schema/model correspondence that makes the law hold by construction:
 * every model block and mark has its node or mark.
 */

import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import {
  BLOCK_TYPES,
  INLINE_MARKS,
  normalizeRichText,
  parseRichText,
  type RichTextDocument,
} from 'jsails/rich-text';
import {
  FIXED_SEEDS,
  TEST_SEED_ENV,
  forEachSeed,
  generateRichTextDocument,
  type TestSeedsOptions,
} from 'jsails/testing';

import { decode, encode } from '../../src/prosemirror/codec.js';
import { BLOCK_NODES, richTextEditorSchema } from '../../src/prosemirror/schema.js';

/** Documents per seed: the fixed seeds and the fresh one cover 10 000 together. */
const PER_SEED = Math.ceil(10_000 / (FIXED_SEEDS.length + 1));

/** A seed outside the fixed list, replayed the way a failure's diagnostic says to. */
const REPLAYED_SEED = 7;

function roundTrip(document: RichTextDocument): RichTextDocument {
  const node = richTextEditorSchema.nodeFromJSON(encode(document));
  node.check();
  return decode(node);
}

/**
 * The round-trip law for every seed `options` selects. Nothing is totalled
 * across seeds, so replaying one seed with `JSAILS_TEST_SEED` checks exactly
 * what the full run checks for it.
 */
async function roundTripLaw(t: TestContext, options: TestSeedsOptions = {}): Promise<void> {
  await forEachSeed(
    t,
    (random) => {
      for (let index = 0; index < PER_SEED; index += 1) {
        const document = normalizeRichText(generateRichTextDocument(random));
        assert.ok(parseRichText(document).ok, 'the generator yields readable documents');
        const json = encode(document);
        const node = richTextEditorSchema.nodeFromJSON(json);
        node.check();
        assert.deepEqual(decode(node), document);
        assert.deepEqual(JSON.parse(JSON.stringify(node.toJSON())), json);
      }
    },
    options,
  );
}

describe('rich-text editor codec', () => {
  it('maps every model block and mark to a node or mark of the schema', () => {
    for (const type of BLOCK_TYPES) {
      const name = BLOCK_NODES[type];
      assert.ok(richTextEditorSchema.nodes[name]?.isInGroup('block'), type);
    }
    for (const mark of INLINE_MARKS) {
      assert.ok(richTextEditorSchema.marks[mark] !== undefined, mark);
    }
    assert.ok(richTextEditorSchema.marks.link !== undefined);
  });

  it('decode(nodeFromJSON(encode(d))) is d, and toJSON() is encode(d), for canonical documents', (t) =>
    roundTripLaw(t));

  it('checks the same for a single seed replayed with JSAILS_TEST_SEED', (t) =>
    roundTripLaw(t, { env: { [TEST_SEED_ENV]: String(REPLAYED_SEED) } }));

  it('encodes a non-canonical document to its canonical content', async (t) => {
    await forEachSeed(t, (random) => {
      for (let index = 0; index < 200; index += 1) {
        const document = generateRichTextDocument(random);
        assert.deepEqual(roundTrip(document), normalizeRichText(document));
      }
    });
  });

  it('round-trips the subtle shapes exactly', () => {
    const documents: RichTextDocument[] = [
      { version: 2, blocks: [] },
      { version: 2, blocks: [{ type: 'paragraph', content: [] }] },
      {
        version: 2,
        blocks: [
          {
            type: 'paragraph',
            content: [
              { text: '\n', marks: ['bold'], href: '/a' as never },
              { text: 'a\n\nb', href: '/a' as never },
              { text: 'c', marks: ['code'], href: '/a' as never },
              { text: '\n' },
            ],
          },
        ],
      },
      {
        version: 2,
        blocks: [
          {
            type: 'list',
            style: 'task',
            items: [
              {
                content: [],
                checked: true,
                children: [
                  {
                    content: [{ text: 'b' }],
                    checked: false,
                    children: [{ content: [{ text: 'c', marks: ['italic'] }], checked: true }],
                  },
                ],
              },
              { content: [{ text: 'd' }], checked: false },
            ],
          },
          { type: 'list', style: 'ordered', items: [{ content: [{ text: 'e' }] }] },
        ],
      },
      {
        version: 2,
        blocks: [
          { type: 'code', code: '\t\n\n', language: 'ts' },
          { type: 'code', code: '' },
          { type: 'quote', content: [{ text: 'q\nr' }], citation: 'c' },
          { type: 'callout', tone: 'danger', content: [] },
          { type: 'heading', level: 6, content: [{ text: 'h', marks: ['bold', 'strike'] }] },
          { type: 'image', mediaId: 'm', alt: 'a', caption: 'c' },
          { type: 'gallery', mediaIds: ['a', 'a'], alt: 'g' },
          { type: 'embed', url: 'https://example.com/e' as never },
          { type: 'cta', label: 'Go', href: 'mailto:a@b.c' as never },
          { type: 'divider' },
        ],
      },
    ];
    for (const document of documents) {
      assert.ok(parseRichText(document).ok);
      assert.deepEqual(roundTrip(document), document);
    }
  });

  it('decodes to frozen blocks, so a caller cannot corrupt the cache', () => {
    const document: RichTextDocument = {
      version: 2,
      blocks: [{ type: 'paragraph', content: [{ text: 'a', marks: ['bold'] }] }],
    };
    const node = richTextEditorSchema.nodeFromJSON(encode(document));
    const decoded = decode(node);
    const run = (decoded.blocks[0] as unknown as { content: { text: string }[] }).content[0];
    assert.ok(Object.isFrozen(decoded.blocks[0]));
    assert.throws(() => {
      (run as { text: string }).text = 'b';
    }, TypeError);
    assert.deepEqual(decode(node), document);
  });
});
