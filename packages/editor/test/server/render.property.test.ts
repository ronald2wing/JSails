/**
 * Seeded property tests for the server renderer, over documents from the
 * `jsails/testing` generator with run texts replaced by hostile strings (markup
 * fragments mixed with arbitrary characters from every plane):
 *
 * - safety: the output tokenizes under the strict grammar, holds only
 *   allowlisted elements and attributes, and every `href` passes
 *   `isLinkHref`, every frame `src` passes `isEmbedUrl`, and every image `src`
 *   is one the media resolver returned;
 * - round trip: `parseRendered(render(d))` equals `d` for documents without
 *   image, gallery, embed and CTA blocks;
 * - structure: for every document, one top-level element per block, of the
 *   kind the block maps to.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isEmbedUrl,
  isLinkHref,
  normalizeRichText,
  type InlineContent,
  type ListItem,
  type RichTextBlock,
  type RichTextDocument,
} from 'jsails/rich-text';
import {
  FIXED_SEEDS,
  forEachSeed,
  generateRichTextDocument,
  type SeededRandom,
} from 'jsails/testing';

import { renderRichText, type RenderRichTextOptions } from '../../src/server/index.js';
import { elements, parseHtml, parseRendered, topLevel } from './rendered-html.js';

const PER_SEED = Math.ceil(10_000 / (FIXED_SEEDS.length + 1));

/** Schema-valid strings aimed at an HTML serializer. */
const HOSTILE: readonly string[] = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '" onmouseover="x',
  "' autofocus onfocus='x",
  '</p><p>',
  '<!--',
  '-->',
  ']]>',
  '&',
  '&amp;',
  '&#60;',
  '&lt;',
  '<a href="javascript:x">',
  'javascript:alert(1)',
  '`',
  '=',
  '\u00a0',
  '\u2028',
  '😀',
];

const MEDIA_SOURCES = new Set(['/media/a.jpg', 'https://cdn.example.com/b.png']);

const OPTIONS: RenderRichTextOptions = {
  resolveMedia: (id) =>
    id.endsWith('0')
      ? undefined
      : { src: id.endsWith('1') ? '/media/a.jpg' : 'https://cdn.example.com/b.png' },
  embedHostAllowlist: ['.youtube.com', 'player.vimeo.com', 'example.com'],
};

/**
 * Code point ranges a run may hold: printable ASCII, Latin-1 and the rest of
 * the BMP below the surrogates, the BMP above them, and the astral planes.
 * Controls and bidi controls are removed afterwards, since the schema refuses
 * them.
 */
const CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
  [0x20, 0x7f],
  [0xa0, 0xd800],
  [0xe000, 0x10000],
  [0x10000, 0x110000],
];

const REFUSED_IN_RUNS = /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** An arbitrary schema-valid character. */
function arbitraryCharacter(random: SeededRandom): string {
  const [low, high] = random.pick(CODE_POINT_RANGES);
  return String.fromCodePoint(random.int(low, high)).replace(REFUSED_IN_RUNS, '');
}

function hostileText(random: SeededRandom, breaks: boolean): string {
  let out = '';
  for (let count = random.int(1, 5); count > 0; count -= 1) {
    const roll = random.next();
    out +=
      breaks && roll < 0.1 ? '\n' : roll < 0.4 ? arbitraryCharacter(random) : random.pick(HOSTILE);
  }
  return out;
}

function hostileInline(
  content: InlineContent,
  random: SeededRandom,
  breaks: boolean,
): InlineContent {
  return content.map((run) => ({ ...run, text: hostileText(random, breaks) }));
}

function hostileItems(items: readonly ListItem[], random: SeededRandom): ListItem[] {
  return items.map((item) => ({
    ...item,
    content: hostileInline(item.content, random, true),
    ...(item.children === undefined ? {} : { children: hostileItems(item.children, random) }),
  }));
}

/** The generator's document with every run text replaced by hostile markup. */
function hostileDocument(random: SeededRandom, kinds?: readonly RichTextBlock['type'][]) {
  const document = generateRichTextDocument(random, kinds === undefined ? {} : { kinds });
  const blocks = document.blocks.map((block): RichTextBlock => {
    switch (block.type) {
      case 'paragraph':
      case 'quote':
      case 'callout':
        return { ...block, content: hostileInline(block.content, random, true) };
      case 'heading':
        return { ...block, content: hostileInline(block.content, random, false) };
      case 'list':
        return { ...block, items: hostileItems(block.items, random) };
      case 'code':
        return { ...block, code: hostileText(random, true) };
      default:
        return block;
    }
  });
  return normalizeRichText({ version: document.version, blocks });
}

function assertSafe(html: string): void {
  for (const element of elements(parseHtml(html))) {
    const { href, src } = element.attrs;
    if (element.name === 'a') {
      assert.ok(typeof href === 'string' && isLinkHref(href), 'a link href fails the predicate');
    }
    if (element.name === 'iframe') {
      assert.ok(typeof src === 'string' && isEmbedUrl(src), 'a frame src fails the predicate');
    }
    if (element.name === 'img') {
      assert.ok(
        typeof src === 'string' && MEDIA_SOURCES.has(src),
        'an image src is not resolved media',
      );
    }
  }
}

const TOP_LEVEL: Readonly<Record<RichTextBlock['type'], readonly string[]>> = {
  paragraph: ['p'],
  heading: ['h2', 'h3', 'h4', 'h5', 'h6'],
  quote: ['blockquote'],
  callout: ['aside'],
  code: ['pre'],
  list: ['ol', 'ul'],
  image: ['img', 'figure', 'span'],
  gallery: ['figure'],
  embed: ['div', 'span'],
  cta: ['p'],
  divider: ['hr'],
};

function assertStructure(document: RichTextDocument, html: string): void {
  const top = topLevel(html);
  assert.equal(top.length, document.blocks.length, 'one top-level element per block');
  document.blocks.forEach((block, index) => {
    const element = top[index];
    assert.ok(element !== undefined && TOP_LEVEL[block.type].includes(element.name));
    if (block.type === 'cta') {
      const link = element.children[0];
      assert.ok(typeof link !== 'string' && link?.name === 'a');
      assert.equal(link.attrs['href'], block.href);
      assert.deepEqual(link.children, [block.label]);
    }
    if (block.type === 'gallery') {
      assert.equal(element.children.length, block.mediaIds.length);
    }
  });
}

const TEXT_KINDS: readonly RichTextBlock['type'][] = [
  'paragraph',
  'heading',
  'quote',
  'callout',
  'code',
  'list',
  'divider',
];

describe('renderRichText properties', () => {
  it('emits only allowlisted markup whose URLs pass the predicates or the resolver', async (t) => {
    await forEachSeed(t, (random) => {
      for (let index = 0; index < PER_SEED; index += 1) {
        assertSafe(renderRichText(hostileDocument(random), OPTIONS));
      }
    });
  });

  it('round-trips documents without media, embeds and calls to action', async (t) => {
    await forEachSeed(t, (random) => {
      for (let index = 0; index < PER_SEED; index += 1) {
        const document = hostileDocument(random, TEXT_KINDS);
        assert.deepEqual(parseRendered(renderRichText(document)), document);
      }
    });
  });

  it('maps every block to one top-level element of its kind', async (t) => {
    await forEachSeed(t, (random) => {
      for (let index = 0; index < PER_SEED; index += 1) {
        const document = hostileDocument(random);
        assertStructure(document, renderRichText(document, OPTIONS));
      }
    });
  });
});
