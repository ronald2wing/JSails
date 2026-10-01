/**
 * Seeded rich-text documents for property tests (`jsails/testing`).
 *
 * {@link generateRichTextDocument} builds schema-valid documents that are
 * deliberately not canonical (empty runs, unsorted and duplicate marks,
 * split runs that should merge, empty optionals, missing task `checked`), so
 * a normaliser, a codec or a renderer is exercised on what writers actually
 * produce. {@link generateRejectedRichText} takes such a document and plants
 * one defect `parseRichText` must refuse (a lone surrogate, a control or bidi
 * character, a refused URL, an unknown key, a fourth list level), returning
 * the issue code it must report. Text mixes ASCII, markup characters,
 * non-Latin scripts and astral characters, and stays far inside the budget.
 */

import {
  CALLOUT_TONES,
  INLINE_MARKS,
  LIST_STYLES,
  RICH_TEXT_VERSION,
  type EmbedUrl,
  type InlineContent,
  type InlineMark,
  type InlineRun,
  type LinkHref,
  type ListItem,
  type ListStyle,
  type RichTextBlock,
  type RichTextBlockType,
  type RichTextDocument,
} from '../rich-text/index.js';
import type { SeededRandom } from './seeded-random.js';

/**
 * Options for {@link generateRichTextDocument}.
 *
 * @public
 */
export interface RichTextGeneratorOptions {
  /** Block kinds to draw from; defaults to every kind. */
  readonly kinds?: readonly RichTextBlockType[];
  /** Most blocks per document; defaults to 12. */
  readonly maxBlocks?: number;
}

/**
 * A value `parseRichText` must refuse, with the issue code it must report.
 *
 * @public
 */
export interface RejectedRichText {
  readonly input: unknown;
  readonly code: string;
}

const ALL_KINDS: readonly RichTextBlockType[] = [
  'paragraph',
  'heading',
  'quote',
  'callout',
  'code',
  'list',
  'image',
  'gallery',
  'embed',
  'cta',
  'divider',
];

/** Text fragments: plain words, markup characters, other scripts, astral characters. */
const FRAGMENTS: readonly string[] = [
  'a',
  'word',
  'Hello',
  ' ',
  '  ',
  '<b>',
  '</p>',
  '&amp;',
  '&',
  '"',
  "'",
  '<script>alert(1)</script>',
  'é',
  'ß',
  '日本語',
  'שלום',
  'مرحبا',
  '😀',
  '👩‍💻',
  '𝔘',
  '\u00a0',
  '\u200d',
];

/** Strings a valid document may hold as a link target. */
const LINKS: readonly string[] = [
  '/',
  '/pricing',
  '/a/b?c=d&e=f#g',
  '#section-2',
  'https://example.com',
  'https://example.com/path?q=1#frag',
  'http://example.org/',
  'https://例え.jp/パス',
  'https://[::1]:8443/x',
  'mailto:team@example.com',
  'mailto:a@b.c?subject=hi',
  'tel:+1-555-0100',
  'tel:0800(123)456',
];

/** Strings a valid document may hold as an embed source. */
const EMBEDS: readonly string[] = [
  'https://www.youtube.com/embed/dQw4w9WgXcQ',
  'https://player.vimeo.com/video/1',
  'https://example.com/frame?x=1',
];

/** Link targets the predicate refuses. */
const REFUSED_LINKS: readonly string[] = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  '//evil.example/',
  '/\\evil.example',
  'https://trusted.example@evil.example/',
  'HTTPS://example.com',
  'https:example.com',
  'https://',
  ' https://example.com',
  'https://exa mple.com',
  'relative/path',
  'ftp://example.com/file',
  'https://example.com/\u202e',
  '',
];

/** Embed sources the predicate refuses. */
const REFUSED_EMBEDS: readonly string[] = [
  'http://www.youtube.com/embed/x',
  'javascript:alert(1)',
  '/embed/local',
  '//www.youtube.com/embed/x',
  'https://user:pass@example.com/',
];

/** Characters no text may hold (a lone surrogate, C0, C1 and bidi controls). */
const REFUSED_CHARACTERS: readonly string[] = [
  '\u0000',
  '\u0007',
  '\r',
  '\u001b',
  '\u007f',
  '\u0085',
  '\u009b',
  '\u202a',
  '\u202e',
  '\u2066',
  '\u2069',
  '\ud800',
  '\udfff',
];

function text(
  random: SeededRandom,
  options: { breaks?: boolean; min?: number; max?: number } = {},
): string {
  // The longest fragment is 25 code units, so `max` fragments bound the length.
  const count = random.int(options.min ?? 0, (options.max ?? 5) + 1);
  let out = '';
  for (let index = 0; index < count; index += 1) {
    out += options.breaks === true && random.next() < 0.1 ? '\n' : random.pick(FRAGMENTS);
  }
  return out;
}

function marks(random: SeededRandom): readonly InlineMark[] | undefined {
  const roll = random.next();
  if (roll < 0.4) {
    return undefined;
  }
  if (roll < 0.45) {
    return [];
  }
  const count = random.int(1, 5);
  const out: InlineMark[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(random.pick(INLINE_MARKS));
  }
  return out;
}

function href(random: SeededRandom): LinkHref | undefined {
  return random.next() < 0.25 ? (random.pick(LINKS) as LinkHref) : undefined;
}

function inline(random: SeededRandom, breaks: boolean): InlineContent {
  const count = random.int(0, 7);
  const out: InlineRun[] = [];
  for (let index = 0; index < count; index += 1) {
    const runMarks = marks(random);
    const runHref = href(random);
    const value = text(random, { breaks });
    out.push({
      text: value,
      ...(runMarks === undefined ? {} : { marks: runMarks }),
      ...(runHref === undefined ? {} : { href: runHref }),
    });
    // A split run that normalisation must merge back.
    if (random.next() < 0.15) {
      out.push({
        text: text(random, { breaks }),
        ...(runMarks === undefined ? {} : { marks: [...runMarks].reverse() }),
        ...(runHref === undefined ? {} : { href: runHref }),
      });
    }
  }
  return out;
}

function optionalText(random: SeededRandom): string | undefined {
  const roll = random.next();
  if (roll < 0.4) {
    return undefined;
  }
  return roll < 0.5 ? '' : text(random, { min: 1, max: 2 });
}

function items(random: SeededRandom, style: ListStyle, depth: number): ListItem[] {
  const count = random.int(0, depth === 1 ? 6 : 3);
  const out: ListItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const roll = random.next();
    const children = depth < 3 && random.next() < 0.3 ? items(random, style, depth + 1) : undefined;
    out.push({
      content: inline(random, true),
      // Task items may omit `checked` and other items may carry it: both are
      // schema-valid, and normalisation decides by the list's style.
      ...(roll < 0.6 ? { checked: random.next() < 0.5 } : {}),
      ...(children === undefined ? {} : { children }),
    });
  }
  return out;
}

function mediaId(random: SeededRandom): string {
  return `media-${random.int(0, 1000)}`;
}

function block(random: SeededRandom, kind: RichTextBlockType): RichTextBlock {
  switch (kind) {
    case 'paragraph':
      return { type: 'paragraph', content: inline(random, true) };
    case 'heading':
      return {
        type: 'heading',
        level: random.pick([2, 3, 4, 5, 6] as const),
        content: inline(random, false),
      };
    case 'quote': {
      const citation = optionalText(random);
      return {
        type: 'quote',
        content: inline(random, true),
        ...(citation === undefined ? {} : { citation }),
      };
    }
    case 'callout':
      return { type: 'callout', tone: random.pick(CALLOUT_TONES), content: inline(random, true) };
    case 'code': {
      const language = optionalText(random);
      const lines = random.int(0, 4);
      let code = '';
      for (let index = 0; index < lines; index += 1) {
        code += `${random.next() < 0.3 ? '\t' : ''}${text(random)}\n`;
      }
      return { type: 'code', code, ...(language === undefined ? {} : { language }) };
    }
    case 'list': {
      const style = random.pick(LIST_STYLES);
      return { type: 'list', style, items: items(random, style, 1) };
    }
    case 'image': {
      const alt = optionalText(random);
      const caption = optionalText(random);
      return {
        type: 'image',
        mediaId: mediaId(random),
        ...(alt === undefined ? {} : { alt }),
        ...(caption === undefined ? {} : { caption }),
      };
    }
    case 'gallery': {
      const alt = optionalText(random);
      const count = random.int(0, 5);
      return {
        type: 'gallery',
        mediaIds: Array.from({ length: count }, () => mediaId(random)),
        ...(alt === undefined ? {} : { alt }),
      };
    }
    case 'embed':
      return { type: 'embed', url: random.pick(EMBEDS) as EmbedUrl };
    case 'cta':
      return {
        type: 'cta',
        label: text(random, { min: 1, max: 4 }),
        href: random.pick(LINKS) as LinkHref,
      };
    case 'divider':
      return { type: 'divider' };
  }
}

/**
 * A schema-valid document, usually not canonical, drawn from `random`. The
 * same seed always yields the same document.
 *
 * @public
 */
export function generateRichTextDocument(
  random: SeededRandom,
  options: RichTextGeneratorOptions = {},
): RichTextDocument {
  const kinds = options.kinds ?? ALL_KINDS;
  const count = random.int(0, (options.maxBlocks ?? 12) + 1);
  return {
    version: RICH_TEXT_VERSION,
    blocks: Array.from({ length: count }, () => block(random, random.pick(kinds))),
  };
}

type Mutable = Record<string, unknown>;

/** Every string-holding location of a JSON value, as a parent and key. */
function textSlots(value: unknown, out: { parent: Mutable; key: string }[] = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      textSlots(item, out);
    }
  } else if (value !== null && typeof value === 'object') {
    const record = value as Mutable;
    for (const [key, field] of Object.entries(record)) {
      if (
        typeof field === 'string' &&
        ['text', 'code', 'alt', 'caption', 'citation', 'label', 'language'].includes(key)
      ) {
        out.push({ parent: record, key });
      } else {
        textSlots(field, out);
      }
    }
  }
  return out;
}

/**
 * A value `parseRichText` must refuse: a generated document with one planted
 * defect, and the issue code that defect must produce.
 *
 * @public
 */
export function generateRejectedRichText(random: SeededRandom): RejectedRichText {
  const base = JSON.parse(JSON.stringify(generateRichTextDocument(random))) as {
    version: number;
    blocks: Mutable[];
  };
  const defect = random.int(0, 6);
  switch (defect) {
    case 0: {
      const slots = textSlots(base);
      const character = random.pick(REFUSED_CHARACTERS);
      const slot = slots.length === 0 ? undefined : random.pick(slots);
      if (slot === undefined) {
        base.blocks.push({ type: 'paragraph', content: [{ text: `x${character}` }] });
      } else {
        const value = slot.parent[slot.key] as string;
        const at = random.int(0, value.length + 1);
        slot.parent[slot.key] = value.slice(0, at) + character + value.slice(at);
      }
      return { input: base, code: 'invalid_text' };
    }
    case 1:
      base.blocks.push({
        type: 'paragraph',
        content: [{ text: 'link', href: random.pick(REFUSED_LINKS) }],
      });
      return { input: base, code: 'invalid_link' };
    case 2:
      base.blocks.push({ type: 'cta', label: 'Go', href: random.pick(REFUSED_LINKS) });
      return { input: base, code: 'invalid_link' };
    case 3:
      base.blocks.push({ type: 'embed', url: random.pick(REFUSED_EMBEDS) });
      return { input: base, code: 'invalid_embed' };
    case 4:
      base.blocks.push({
        type: 'paragraph',
        content: [],
        [random.pick(['id', 'html', 'style'])]: 'x',
      });
      return { input: base, code: 'unknown_field' };
    default:
      base.blocks.push({
        type: 'list',
        style: 'unordered',
        items: [
          {
            content: [],
            children: [{ content: [], children: [{ content: [], children: [{ content: [] }] }] }],
          },
        ],
      });
      return { input: base, code: 'unknown_field' };
  }
}
