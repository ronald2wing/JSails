/**
 * The rich-text document model, version 2: a list of typed blocks whose text
 * is a flat list of inline runs, each run carrying its marks and an optional
 * link.
 *
 * This module is the persisted shape only: types, bounds, and the strict Zod
 * schema behind {@link richTextContract}. The schema holds what makes a value
 * safe and structurally sound (URL predicates, well-formed text without
 * controls or bidi overrides, nesting depth, field lengths) and has no
 * transforms, so `richTextContract.jsonSchema` describes it exactly. What
 * makes a document *unique* (merged runs, sorted marks, no empty optionals)
 * is the canonical form in `canonical.ts`, and size is the budget in
 * `measure.ts`; `parseRichText` (`parse.ts`) applies all three and is the only
 * way to read a stored or submitted document.
 *
 * The model is browser-safe and editor-agnostic: an editor encodes it into its
 * own state and decodes back to it, and nothing editor-specific is persisted.
 */

import { z } from 'zod';

import { defineData, type DataContract } from '../data/define-data.js';
import { isEmbedUrl, isLinkHref, MAX_URL_LENGTH, type EmbedUrl, type LinkHref } from './url.js';

// ---------------------------------------------------------------------------
// Version and fingerprint
// ---------------------------------------------------------------------------

/**
 * The only `version` a stored document may carry. A document of any other
 * version, version 1 included, is refused by number; `upgradeRichTextDocument`
 * is the explicit path from version 1.
 *
 * @public
 */
export const RICH_TEXT_VERSION = 2;

/**
 * SHA-256 of what version {@link RICH_TEXT_VERSION} means: the stable JSON of
 * `richTextContract.jsonSchema` and the committed accept and reject corpora
 * under `core/test/rich-text/corpus/v2/`. A test recomputes all three, so a
 * change to the schema or to the accepted language that does not also bump
 * the version (and add a corpus for the new one) fails the build.
 */
export const RICH_TEXT_FINGERPRINT: {
  readonly version: number;
  readonly schema: string;
  readonly accept: string;
  readonly reject: string;
} = Object.freeze({
  version: 2,
  schema: '52b63ec0a5eda53d7586614c3eceaf9ed5fd789bf6194611c1c130e92d332d86',
  accept: '1be100eb03db140110dd683f4eebc56865b38c3c0920ae2a9421244063ccd149',
  reject: 'cda8b04cdecff2b551e2105bdf7895af57e6d1a1ea486d6f01336f402bc0ec67',
});

// ---------------------------------------------------------------------------
// Budgets and bounds
// ---------------------------------------------------------------------------

/**
 * Largest stored document: the UTF-8 length of its JSON.
 *
 * @public
 */
export const MAX_DOCUMENT_BYTES: number = 256 * 1024;

/**
 * Most blocks in one document.
 *
 * @public
 */
export const MAX_BLOCKS = 500;

/**
 * Most text in one block, in UTF-16 code units: its run texts, code, citation,
 * alt, caption and label together (for a list, every item at every depth).
 *
 * @public
 */
export const MAX_BLOCK_CHARS = 20_000;

/**
 * Most items in one list block, nested items included.
 *
 * @public
 */
export const MAX_LIST_ITEMS = 500;

/**
 * Deepest list nesting: an item may hold children, and they may hold
 * children, but no further.
 *
 * @public
 */
export const MAX_LIST_DEPTH = 3;

/**
 * Most media ids in a gallery block.
 *
 * @public
 */
export const MAX_GALLERY_ITEMS = 25;

/**
 * Longest media id.
 *
 * @public
 */
export const MAX_MEDIA_ID_LENGTH = 190;

/**
 * Longest image or gallery alt text.
 *
 * @public
 */
export const MAX_ALT_LENGTH = 255;

/**
 * Longest image caption.
 *
 * @public
 */
export const MAX_CAPTION_LENGTH = 255;

/**
 * Longest quote citation.
 *
 * @public
 */
export const MAX_CITATION_LENGTH = 500;

/**
 * Longest code-block language tag.
 *
 * @public
 */
export const MAX_LANGUAGE_LENGTH = 64;

/**
 * Longest call-to-action label.
 *
 * @public
 */
export const MAX_CTA_LABEL_LENGTH = 120;

/**
 * Lowest heading level (level 1 belongs to the page title).
 *
 * @public
 */
export const MIN_HEADING_LEVEL = 2;

/**
 * Highest heading level.
 *
 * @public
 */
export const MAX_HEADING_LEVEL = 6;

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * Block discriminators, in declaration order.
 *
 * @public
 */
export const BLOCK_TYPES = [
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
] as const;

/**
 * Inline marks, in canonical order: a run's `marks` list is sorted by this
 * order, and renderers nest the elements in it (outermost first).
 *
 * @public
 */
export const INLINE_MARKS = ['bold', 'italic', 'strike', 'code'] as const;

/**
 * List styles. Items of a `task` list carry `checked`; items of the other
 * styles never do.
 *
 * @public
 */
export const LIST_STYLES = ['ordered', 'unordered', 'task'] as const;

/**
 * Callout tones.
 *
 * @public
 */
export const CALLOUT_TONES = ['info', 'success', 'warning', 'danger'] as const;

/**
 * A block discriminator.
 *
 * @public
 */
export type RichTextBlockType = (typeof BLOCK_TYPES)[number];

/**
 * An inline mark.
 *
 * @public
 */
export type InlineMark = (typeof INLINE_MARKS)[number];

/**
 * A list style.
 *
 * @public
 */
export type ListStyle = (typeof LIST_STYLES)[number];

/**
 * A callout tone.
 *
 * @public
 */
export type CalloutTone = (typeof CALLOUT_TONES)[number];

/**
 * A heading level.
 *
 * @public
 */
export type HeadingLevel = 2 | 3 | 4 | 5 | 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A run of text sharing one set of marks and one link. `\n` in `text` is a
 * hard line break (never inside a heading).
 *
 * @public
 */
export interface InlineRun {
  readonly text: string;
  readonly marks?: readonly InlineMark[];
  readonly href?: LinkHref;
}

/**
 * The text of a block: runs in reading order.
 *
 * @public
 */
export type InlineContent = readonly InlineRun[];

/**
 * A paragraph.
 *
 * @public
 */
export interface ParagraphBlock {
  readonly type: 'paragraph';
  readonly content: InlineContent;
}

/**
 * A section heading.
 *
 * @public
 */
export interface HeadingBlock {
  readonly type: 'heading';
  readonly level: HeadingLevel;
  readonly content: InlineContent;
}

/**
 * A block quotation with an optional citation.
 *
 * @public
 */
export interface QuoteBlock {
  readonly type: 'quote';
  readonly content: InlineContent;
  readonly citation?: string;
}

/**
 * A highlighted note.
 *
 * @public
 */
export interface CalloutBlock {
  readonly type: 'callout';
  readonly tone: CalloutTone;
  readonly content: InlineContent;
}

/**
 * Literal source code; `\n` and `\t` are kept as written.
 *
 * @public
 */
export interface CodeBlock {
  readonly type: 'code';
  readonly code: string;
  readonly language?: string;
}

/**
 * One list item, with nested items of the same list.
 *
 * @public
 */
export interface ListItem {
  readonly content: InlineContent;
  readonly checked?: boolean;
  readonly children?: readonly ListItem[];
}

/**
 * An ordered, unordered or task list.
 *
 * @public
 */
export interface ListBlock {
  readonly type: 'list';
  readonly style: ListStyle;
  readonly items: readonly ListItem[];
}

/**
 * An image from the media library.
 *
 * @public
 */
export interface ImageBlock {
  readonly type: 'image';
  readonly mediaId: string;
  readonly alt?: string;
  readonly caption?: string;
}

/**
 * Several images from the media library.
 *
 * @public
 */
export interface GalleryBlock {
  readonly type: 'gallery';
  readonly mediaIds: readonly string[];
  readonly alt?: string;
}

/**
 * An embedded frame from an `https:` URL.
 *
 * @public
 */
export interface EmbedBlock {
  readonly type: 'embed';
  readonly url: EmbedUrl;
}

/**
 * A call-to-action link.
 *
 * @public
 */
export interface CtaBlock {
  readonly type: 'cta';
  readonly label: string;
  readonly href: LinkHref;
}

/**
 * A thematic break.
 *
 * @public
 */
export interface DividerBlock {
  readonly type: 'divider';
}

/**
 * One block of a document.
 *
 * @public
 */
export type RichTextBlock =
  | ParagraphBlock
  | HeadingBlock
  | QuoteBlock
  | CalloutBlock
  | CodeBlock
  | ListBlock
  | ImageBlock
  | GalleryBlock
  | EmbedBlock
  | CtaBlock
  | DividerBlock;

/**
 * A rich-text document.
 *
 * @public
 */
export interface RichTextDocument {
  readonly version: typeof RICH_TEXT_VERSION;
  readonly blocks: readonly RichTextBlock[];
}

// ---------------------------------------------------------------------------
// Text rules
// ---------------------------------------------------------------------------

/**
 * Character classes refused in text, as regular-expression source so the
 * JSON Schema carries them as `pattern`. Every class refuses C0 controls
 * (except where noted), DEL, C1 controls, and the bidi embedding, override
 * and isolate controls, which can make text read differently from how it is
 * stored.
 */
const REFUSED_ALWAYS = '\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069';

/** No line breaks or tabs: titles, labels, alt text, ids. */
const LINE_PATTERN = new RegExp(`^[^\\u0000-\\u000a${REFUSED_ALWAYS}]*$`);

/** `\n` allowed: run text. */
const RUN_PATTERN = new RegExp(`^[^\\u0000-\\u0009${REFUSED_ALWAYS}]*$`);

/** `\n` and `\t` allowed: code. */
const CODE_PATTERN = new RegExp(`^[^\\u0000-\\u0008${REFUSED_ALWAYS}]*$`);

/** True when `value` has no lone surrogate. */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * The issue code a schema check reports, carried in the custom issue's
 * `params` so `parseRichText` can report it without echoing the value.
 */
export type RichTextCheckCode = 'invalid_text' | 'invalid_link' | 'invalid_embed';

function checkParams(code: RichTextCheckCode): { readonly params: { readonly richText: string } } {
  return { params: { richText: code } };
}

function text(pattern: RegExp): z.ZodString {
  return z.string().regex(pattern).refine(isWellFormed, checkParams('invalid_text'));
}

const lineText = (max: number): z.ZodString => text(LINE_PATTERN).max(max);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const linkHrefSchema = z
  .string()
  .max(MAX_URL_LENGTH)
  .refine(isLinkHref, checkParams('invalid_link'))
  .brand<'LinkHref'>();

const embedUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH)
  .refine(isEmbedUrl, checkParams('invalid_embed'))
  .brand<'EmbedUrl'>();

const marksSchema = z.array(z.enum(INLINE_MARKS)).max(INLINE_MARKS.length);

function inlineSchema(pattern: RegExp): z.ZodType<InlineContent> {
  return z.array(
    z.strictObject({
      text: text(pattern),
      marks: marksSchema.optional(),
      href: linkHrefSchema.optional(),
    }),
  );
}

const inline = inlineSchema(RUN_PATTERN);
const headingInline = inlineSchema(LINE_PATTERN);

// Three explicit item levels keep the nesting bound in the schema itself and
// the JSON Schema free of recursion.
const deepestItem = z.strictObject({ content: inline, checked: z.boolean().optional() });
const middleItem = z.strictObject({
  content: inline,
  checked: z.boolean().optional(),
  children: z.array(deepestItem).optional(),
});
const listItem = z.strictObject({
  content: inline,
  checked: z.boolean().optional(),
  children: z.array(middleItem).optional(),
});

const blockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('paragraph'), content: inline }),
  z.strictObject({
    type: z.literal('heading'),
    level: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
    content: headingInline,
  }),
  z.strictObject({
    type: z.literal('quote'),
    content: inline,
    citation: lineText(MAX_CITATION_LENGTH).optional(),
  }),
  z.strictObject({ type: z.literal('callout'), tone: z.enum(CALLOUT_TONES), content: inline }),
  z.strictObject({
    type: z.literal('code'),
    code: text(CODE_PATTERN),
    language: lineText(MAX_LANGUAGE_LENGTH).optional(),
  }),
  z.strictObject({ type: z.literal('list'), style: z.enum(LIST_STYLES), items: z.array(listItem) }),
  z.strictObject({
    type: z.literal('image'),
    mediaId: lineText(MAX_MEDIA_ID_LENGTH).min(1),
    alt: lineText(MAX_ALT_LENGTH).optional(),
    caption: lineText(MAX_CAPTION_LENGTH).optional(),
  }),
  z.strictObject({
    type: z.literal('gallery'),
    mediaIds: z.array(lineText(MAX_MEDIA_ID_LENGTH).min(1)).max(MAX_GALLERY_ITEMS),
    alt: lineText(MAX_ALT_LENGTH).optional(),
  }),
  z.strictObject({ type: z.literal('embed'), url: embedUrlSchema }),
  z.strictObject({
    type: z.literal('cta'),
    label: lineText(MAX_CTA_LABEL_LENGTH).min(1),
    href: linkHrefSchema,
  }),
  z.strictObject({ type: z.literal('divider') }),
]);

const blocksSchema: z.ZodType<readonly RichTextBlock[]> = z.array(blockSchema);

/**
 * The `defineData` descriptor of a document: the strict schema plus its lazy
 * JSON Schemas. The schema accepts safe, well-structured documents; only
 * `parseRichText` also enforces the canonical form and the budget.
 *
 * @public
 */
export const richTextContract: DataContract<{
  readonly version: z.ZodLiteral<typeof RICH_TEXT_VERSION>;
  readonly blocks: z.ZodType<readonly RichTextBlock[]>;
}> = defineData({
  name: 'RichTextDocument',
  description: 'A versioned list of typed content blocks with inline runs.',
  properties: {
    version: z.literal(RICH_TEXT_VERSION),
    blocks: blocksSchema,
  },
});

/**
 * The strict Zod schema of a document (structure and safety, not canonical
 * form or budget).
 *
 * @public
 */
export const richTextSchema: typeof richTextContract.schema = richTextContract.schema;

/**
 * A new, empty document at the current version.
 *
 * @public
 */
export function createEmptyRichTextDocument(): RichTextDocument {
  return { version: RICH_TEXT_VERSION, blocks: [] };
}
