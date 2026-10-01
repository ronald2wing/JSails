/**
 * {@link upgradeRichTextDocument}: the explicit, one-time path from a stored
 * version 1 document to the current model. `parseRichText` refuses version 1
 * by number, so a store holding version 1 rows runs this once over them (the
 * blog ships it as a data migration) instead of every reader coercing old
 * data on each read.
 *
 * Version 1 held plain strings with block ids. The upgrade drops the ids,
 * turns each text into one unmarked run, and brings strings within the
 * version 2 text rules: `\r\n` and `\r` become `\n`, line breaks become spaces
 * where version 2 forbids them (headings, citations, alt text, captions,
 * labels), tabs become spaces outside code, unpaired surrogates become U+FFFD,
 * and other controls and bidi controls are removed. A call to action whose
 * href the link predicate refuses, or whose label is left empty, becomes a
 * paragraph of its label, an image whose media id is left empty becomes a
 * paragraph of its alt text and caption, and an
 * embed whose URL is not `https:` becomes a paragraph holding the URL (a link
 * when the URL is a valid link), so no author text is lost and no refused URL
 * survives. The result is normalised and then read with `parseRichText`, so
 * a document over the version 2 budget is reported, not stored.
 */

import { z } from 'zod';

import { normalizeRichText } from './canonical.js';
import {
  RICH_TEXT_VERSION,
  type HeadingLevel,
  type InlineContent,
  type RichTextBlock,
} from './document.js';
import { parseRichText, type RichTextParseResult } from './parse.js';
import { isEmbedUrl, isLinkHref } from './url.js';

/**
 * The version 1 schema, built on first use: browser bundles import this
 * module through the `jsails/rich-text` barrel, and schema construction at
 * module scope is a call a bundler cannot drop when the upgrade is unused.
 */
function buildV1Document() {
  const v1Text = z.string();
  const v1Optional = z.string().optional();
  const v1Block = z.discriminatedUnion('type', [
    z.object({ type: z.literal('paragraph'), text: v1Text }),
    z.object({ type: z.literal('heading'), level: z.number().int().min(2).max(6), text: v1Text }),
    z.object({
      type: z.literal('list'),
      style: z.enum(['ordered', 'unordered']),
      items: z.array(v1Text),
    }),
    z.object({ type: z.literal('quote'), text: v1Text, citation: v1Optional }),
    z.object({ type: z.literal('code'), code: v1Text, language: v1Optional }),
    z.object({ type: z.literal('image'), mediaId: v1Text, alt: v1Optional, caption: v1Optional }),
    z.object({ type: z.literal('gallery'), mediaIds: z.array(v1Text), alt: v1Optional }),
    z.object({ type: z.literal('embed'), url: v1Text }),
    z.object({
      type: z.literal('callout'),
      tone: z.enum(['info', 'success', 'warning', 'danger']),
      text: v1Text,
    }),
    z.object({ type: z.literal('cta'), label: v1Text, href: v1Text }),
    z.object({ type: z.literal('divider') }),
  ]);
  return z.object({ version: z.literal(1), blocks: z.array(v1Block) });
}

type V1Document = ReturnType<typeof buildV1Document>;
type V1Block = z.infer<V1Document>['blocks'][number];

let v1Document: V1Document | undefined;

/** Characters version 2 refuses in every text, `\t` and `\n` aside. */
const REFUSED = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function wellFormed(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value.slice(index, index + 2);
        index += 1;
        continue;
      }
      out += '\ufffd';
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      out += '\ufffd';
    } else {
      out += value[index];
    }
  }
  return out;
}

function clean(value: string, allow: 'line' | 'run' | 'code'): string {
  let out = wellFormed(value).replace(/\r\n?/g, '\n');
  if (allow !== 'code') {
    out = out.replace(/\t/g, ' ');
  }
  if (allow === 'line') {
    out = out.replace(/\n/g, ' ');
  }
  return out.replace(REFUSED, '');
}

function runs(value: string, allow: 'line' | 'run' = 'run'): InlineContent {
  return [{ text: clean(value, allow) }];
}

function line(value: string | undefined): string | undefined {
  return value === undefined ? undefined : clean(value, 'line');
}

function upgradeBlock(block: V1Block): RichTextBlock {
  switch (block.type) {
    case 'paragraph':
      return { type: 'paragraph', content: runs(block.text) };
    case 'heading':
      return {
        type: 'heading',
        level: block.level as HeadingLevel,
        content: runs(block.text, 'line'),
      };
    case 'list':
      return {
        type: 'list',
        style: block.style,
        items: block.items.map((item) => ({ content: runs(item) })),
      };
    case 'quote':
      return { type: 'quote', content: runs(block.text), citation: line(block.citation) };
    case 'code':
      return { type: 'code', code: clean(block.code, 'code'), language: line(block.language) };
    case 'image': {
      const mediaId = clean(block.mediaId, 'line');
      if (mediaId === '') {
        // An id that was nothing but refused characters names no media; the
        // author's alt text and caption are kept as a paragraph.
        return {
          type: 'paragraph',
          content: runs(
            [block.alt, block.caption].filter((part) => part !== undefined).join(' '),
            'line',
          ),
        };
      }
      return { type: 'image', mediaId, alt: line(block.alt), caption: line(block.caption) };
    }
    case 'gallery':
      return {
        type: 'gallery',
        mediaIds: block.mediaIds.map((id) => clean(id, 'line')).filter((id) => id !== ''),
        alt: line(block.alt),
      };
    case 'embed': {
      if (isEmbedUrl(block.url)) {
        return { type: 'embed', url: block.url };
      }
      const text = clean(block.url, 'line');
      return {
        type: 'paragraph',
        content: [isLinkHref(block.url) ? { text, href: block.url } : { text }],
      };
    }
    case 'callout':
      return { type: 'callout', tone: block.tone, content: runs(block.text) };
    case 'cta': {
      const label = clean(block.label, 'line');
      return label !== '' && isLinkHref(block.href)
        ? { type: 'cta', label, href: block.href }
        : { type: 'paragraph', content: [{ text: label }] };
    }
    case 'divider':
      return { type: 'divider' };
  }
}

/**
 * Upgrade a stored document to the current version. A version 1 document is
 * converted as described in this module's header; a current document is read
 * with `parseRichText` unchanged, so running the upgrade twice is harmless.
 * Anything else, or a version 1 value that does not match the version 1
 * schema, is refused with value-free issues.
 *
 * @public
 */
export function upgradeRichTextDocument(input: unknown): RichTextParseResult {
  const version =
    input !== null && typeof input === 'object' ? (input as { version?: unknown }).version : null;
  if (version !== 1) {
    return parseRichText(input);
  }
  v1Document ??= buildV1Document();
  const parsed = v1Document.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [
        { path: ['version'], code: 'unsupported_version', message: 'not a version 1 document' },
      ],
    };
  }
  return parseRichText(
    normalizeRichText({
      version: RICH_TEXT_VERSION,
      blocks: parsed.data.blocks.map(upgradeBlock),
    }),
  );
}
