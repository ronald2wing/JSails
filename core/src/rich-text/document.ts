/**
 * Rich-text document contract: the general, framework-owned surface for a
 * versioned, strictly bounded list of typed content blocks.
 *
 * A `RichTextDocument` is the persisted shape of a rich-text body (e.g. a
 * post/page body). It is built with `defineData`, so the frozen descriptor
 * exposes `.schema` (a strict Zod object), `.jsonSchema`, and
 * `.outputJsonSchema` alongside the inferred `RichTextDocument` type.
 *
 * This module owns the *shape* of the contract only. It never sanitizes HTML:
 * sanitization belongs to a renderer at output time, never to the persisted
 * document. Every length/count bound is an exported constant so editors and
 * renderers can share the same limits.
 */

import { z } from 'zod';

import { defineData, type DataValue } from 'jsails/data';
import type { FieldError } from 'jsails/validation';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** The only accepted `version` of a rich-text document. */
export const RICH_TEXT_VERSION = 1;

/** Maximum number of blocks in one document. */
export const MAX_BLOCKS = 200;

/** Maximum length of a block or media id. */
export const MAX_BLOCK_ID_LENGTH = 190;

/** Maximum length of plain text (paragraph/heading/quote/callout text, list items). */
export const MAX_BLOCK_TEXT_LENGTH = 2000;

/** Maximum length of an image/gallery alt description. */
export const MAX_ALT_LENGTH = 255;

/** Maximum length of an image caption. */
export const MAX_CAPTION_LENGTH = 255;

/** Maximum number of items in a list block. */
export const MAX_LIST_ITEMS = 100;

/** Maximum number of media ids in a gallery block. */
export const MAX_GALLERY_ITEMS = 25;

/** Lowest allowed heading level. */
export const MIN_HEADING_LEVEL = 2;

/** Highest allowed heading level. */
export const MAX_HEADING_LEVEL = 6;

/** Maximum length of a code block body. */
export const MAX_CODE_LENGTH = 20000;

/** Maximum length of a code language tag. */
export const MAX_LANGUAGE_LENGTH = 64;

/** Maximum length of an embed url or CTA href. */
export const MAX_URL_LENGTH = 2048;

/** Maximum length of a CTA label. */
export const MAX_CTA_LABEL_LENGTH = 120;

/** Maximum length of a quote citation. */
export const MAX_CITATION_LENGTH = 500;

// ---------------------------------------------------------------------------
// Block kinds
// ---------------------------------------------------------------------------

/** The block kinds a document may contain, in declaration order. */
export const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'list',
  'quote',
  'code',
  'image',
  'gallery',
  'embed',
  'callout',
  'cta',
  'divider',
] as const;

/** A block's discriminator value. */
export type RichTextBlockType = (typeof BLOCK_TYPES)[number];

/** List marker style for a list block. */
export const LIST_STYLES = ['ordered', 'unordered'] as const;

/** Callout tone for a callout block. */
export const CALLOUT_TONES = ['info', 'success', 'warning', 'danger'] as const;

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(MAX_BLOCK_ID_LENGTH);
const textSchema = z.string().max(MAX_BLOCK_TEXT_LENGTH);
const altSchema = z.string().max(MAX_ALT_LENGTH).optional();
const captionSchema = z.string().max(MAX_CAPTION_LENGTH).optional();
const headingLevelSchema = z.number().int().min(MIN_HEADING_LEVEL).max(MAX_HEADING_LEVEL);
const listStyleSchema = z.enum(LIST_STYLES);
const calloutToneSchema = z.enum(CALLOUT_TONES);
const mediaIdSchema = z.string().min(1).max(MAX_BLOCK_ID_LENGTH);

// ---------------------------------------------------------------------------
// Block variants
// ---------------------------------------------------------------------------

const paragraphSchema = z.strictObject({
  id: idSchema,
  type: z.literal('paragraph'),
  text: textSchema,
});

const headingSchema = z.strictObject({
  id: idSchema,
  type: z.literal('heading'),
  level: headingLevelSchema,
  text: textSchema,
});

const listSchema = z.strictObject({
  id: idSchema,
  type: z.literal('list'),
  style: listStyleSchema,
  items: z.array(textSchema).max(MAX_LIST_ITEMS),
});

const quoteSchema = z.strictObject({
  id: idSchema,
  type: z.literal('quote'),
  text: textSchema,
  citation: z.string().max(MAX_CITATION_LENGTH).optional(),
});

const codeSchema = z.strictObject({
  id: idSchema,
  type: z.literal('code'),
  code: z.string().max(MAX_CODE_LENGTH),
  language: z.string().max(MAX_LANGUAGE_LENGTH).optional(),
});

const imageSchema = z.strictObject({
  id: idSchema,
  type: z.literal('image'),
  mediaId: mediaIdSchema,
  alt: altSchema,
  caption: captionSchema,
});

const gallerySchema = z.strictObject({
  id: idSchema,
  type: z.literal('gallery'),
  mediaIds: z.array(mediaIdSchema).max(MAX_GALLERY_ITEMS),
  alt: altSchema,
});

const embedSchema = z.strictObject({
  id: idSchema,
  type: z.literal('embed'),
  // An embed must be an absolute URL (the oEmbed/frame resolver needs it).
  url: z.string().url().max(MAX_URL_LENGTH),
});

const calloutSchema = z.strictObject({
  id: idSchema,
  type: z.literal('callout'),
  tone: calloutToneSchema,
  text: textSchema,
});

const ctaSchema = z.strictObject({
  id: idSchema,
  type: z.literal('cta'),
  label: z.string().min(1).max(MAX_CTA_LABEL_LENGTH),
  // A CTA href may be an internal path (/pricing) or an absolute URL.
  href: z.string().min(1).max(MAX_URL_LENGTH),
});

const dividerSchema = z.strictObject({
  id: idSchema,
  type: z.literal('divider'),
});

const blockSchema = z.discriminatedUnion('type', [
  paragraphSchema,
  headingSchema,
  listSchema,
  quoteSchema,
  codeSchema,
  imageSchema,
  gallerySchema,
  embedSchema,
  calloutSchema,
  ctaSchema,
  dividerSchema,
]);

/** A single content block (a discriminated union over {@link RichTextBlockType}). */
export type RichTextBlock = z.infer<typeof blockSchema>;

// ---------------------------------------------------------------------------
// Document contract
// ---------------------------------------------------------------------------

/** The `defineData` descriptor for a rich-text document (frozen, with lazy JSON Schemas). */
export const richTextContract = defineData({
  name: 'RichTextDocument',
  description: 'A versioned list of typed content blocks.',
  properties: {
    version: z.literal(RICH_TEXT_VERSION),
    blocks: z.array(blockSchema).max(MAX_BLOCKS),
  },
});

/** The strict Zod object schema for a rich-text document. */
export const richTextSchema = richTextContract.schema;

/** A validated rich-text document: `{ version: 1, blocks: RichTextBlock[] }`. */
export type RichTextDocument = DataValue<typeof richTextContract>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A new, empty rich-text document at the current version. */
export function createEmptyRichTextDocument(): RichTextDocument {
  return { version: RICH_TEXT_VERSION, blocks: [] };
}

/** The result of {@link validateRichTextDocument}: the parsed value or field errors. */
export type RichTextValidationResult =
  | { readonly ok: true; readonly value: RichTextDocument }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

/**
 * Validate an untrusted value against the rich-text document contract without
 * throwing. On success returns the parsed value; on failure returns value-free
 * field errors (dotted paths, never the offending input).
 */
export function validateRichTextDocument(input: unknown): RichTextValidationResult {
  const result = richTextSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }

  const errors: FieldError[] = [];
  for (const issue of result.error.issues) {
    // Expand unrecognized keys so each unknown key is its own entry, with the
    // (caller-supplied) key name only in the field path — never in the message.
    if (issue.code === 'unrecognized_keys') {
      const prefix = issue.path.map(String).join('.');
      for (const key of issue.keys) {
        errors.push({
          field: prefix === '' ? key : `${prefix}.${key}`,
          message: 'unrecognized field',
        });
      }
      continue;
    }
    const field = issue.path.length > 0 ? issue.path.map(String).join('.') : '_root';
    errors.push({ field, message: issue.message });
  }
  return { ok: false, errors };
}
