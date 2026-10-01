/**
 * Pure adapter between an Editor.js `OutputData` payload and the persisted
 * {@link RichTextDocument} (`jsails/rich-text`).
 *
 * This module is model-agnostic: it depends only on the persisted contract plus
 * local *structural* types for the Editor.js payload, so it compiles without
 * the `@editorjs/editorjs` package and without a DOM. It is the single seam the
 * mount (`editorjs/mount.ts`) uses both ways: the mounted Editor.js surface
 * loads a document through {@link richTextToEditorJs} and persists a change
 * through {@link editorJsToRichText}.
 *
 * ## Data hygiene
 *
 * Editor.js text fields may carry inline HTML. A `RichTextDocument` has no
 * inline marks, so on the forward path (`editorJsToRichText`) every text field
 * is normalized to plain text before it reaches the schema: tags are stripped
 * and the common SGML entities are decoded. Untrusted markup is therefore never
 * persisted. On the reverse path (`richTextToEditorJs`) plain text is escaped so
 * that the `<` and `&` of a round-trip survive Editor.js's own HTML handling;
 * code bodies are emitted literally (they are source, not inline HTML).
 *
 * Required fields (a non-empty image `mediaId`, a non-empty `cta` label/href, a
 * valid `embed` URL, and so on) are not hand-validated on the forward path:
 * they are mapped verbatim and the assembled document is validated through
 * {@link richTextSchema}, which returns value-free field errors. Empty or
 * malformed required fields therefore fail the boundary rather than being
 * coerced into a silently invalid block. Optional text fields (`alt`,
 * `caption`, `citation`, `language`) are dropped when absent or empty.
 *
 * ## Block ids
 *
 * A non-empty `block.id` is preserved in both directions; otherwise the
 * document position is the id (`block-<index>`). Because the schema bounds id
 * length/content but does not enforce uniqueness, collisions (a duplicate
 * producer id, or a generated id equal to an explicit one) are resolved on the
 * forward path by suffixing rather than left to the schema.
 */

import { richTextSchema, type RichTextBlock, type RichTextDocument } from 'jsails/rich-text';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Machine-readable reason for an {@link EditorConversionError}. */
export type EditorConversionErrorCode = 'invalid_document' | 'unsupported_block';

/** A value-free conversion failure. Messages never echo block content or input. */
export class EditorConversionError extends Error {
  readonly code: EditorConversionErrorCode;

  constructor(code: EditorConversionErrorCode, message: string) {
    super(message);
    this.name = 'EditorConversionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Local Editor.js structural types (no Editor.js dependency)
// ---------------------------------------------------------------------------

/** An Editor.js output block: a discriminated tool name plus its free-form data. */
export interface EditorJsBlock {
  /** Stable per-block id when the producer recorded one; may be absent. */
  readonly id?: string;
  /** The block tool name (e.g. `paragraph`, `header`, `delimiter`). */
  readonly type: string;
  /** Tool-specific payload, structurally `Record<string, unknown>`. */
  readonly data: Record<string, unknown>;
}

/** The Editor.js serialized output shape this adapter accepts. */
export interface EditorJsOutputData {
  /** Optional save timestamp, ignored by this adapter. */
  readonly time?: number;
  /** The block list, in document order. */
  readonly blocks: readonly EditorJsBlock[];
  /** Optional output schema version, ignored by this adapter. */
  readonly version?: string;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** A successful Editor.js payload-to-document conversion. */
export interface EditorJsBuildResult {
  readonly ok: true;
  /** The assembled, schema-validated document. */
  readonly document: RichTextDocument;
}

/** A failed Editor.js payload-to-document conversion. */
export interface EditorJsBuildFailure {
  readonly ok: false;
  readonly error: EditorConversionError;
}

export type EditorJsBuildOutcome = EditorJsBuildResult | EditorJsBuildFailure;

/** A failed document-to-Editor.js conversion. */
export interface RichTextToEditorJsFailure {
  readonly ok: false;
  readonly error: EditorConversionError;
}

/** A successful document-to-Editor.js conversion. */
export interface RichTextToEditorJsResult {
  readonly ok: true;
  /** The Editor.js payload to feed `editor.render(...)`. */
  readonly output: EditorJsOutputData;
}

export type RichTextToEditorJsOutcome = RichTextToEditorJsResult | RichTextToEditorJsFailure;

// ---------------------------------------------------------------------------
// Tool type registry
// ---------------------------------------------------------------------------

/** The Editor.js tool names this adapter can map to a persisted block kind. */
const SUPPORTED_TOOL_TYPES: ReadonlySet<string> = new Set([
  'paragraph',
  'header',
  'list',
  'quote',
  'code',
  'delimiter',
  'image',
  'gallery',
  'embed',
  'callout',
  'cta',
]);

// ---------------------------------------------------------------------------
// HTML -> plain text normalization
// ---------------------------------------------------------------------------

/** The common SGML entities Editor.js inline HTML may emit, decoded to text. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode one HTML entity reference (`&...;`) without pulling in an HTML parser. */
function decodeEntity(entity: string): string {
  // `entity` includes the `&` and `;`; slice the name between them.
  const name = entity.slice(1, -1);
  const code =
    name.startsWith('#x') || name.startsWith('#X')
      ? Number.parseInt(name.slice(2), 16)
      : name.startsWith('#')
        ? Number.parseInt(name.slice(1), 10)
        : Number.NaN;
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
    return NAMED_ENTITIES[name] ?? entity;
  }
  // A lone surrogate is not a valid code point for String.fromCodePoint.
  if (code >= 0xd800 && code <= 0xdfff) return entity;
  return String.fromCodePoint(code);
}

/** Strip tags and decode the common entities, leaving plain text. */
function toPlainText(raw: string): string {
  if (raw === '') return '';
  const withoutTags = raw.replace(/<[^>]*>/g, '');
  return withoutTags.replace(/&(?:#x[0-9a-f]+|#\d+|[a-z]+);?/gi, decodeEntity);
}

/**
 * Escape the characters that would otherwise be treated as markup by Editor.js
 * text tools, so a `<`/`&` in plain text survives a forward round-trip intact.
 * This is the inverse of {@link toPlainText} for the five named entities; a
 * numeric or unknown entity reference never appears in the persisted source.
 */
function escapeText(raw: string): string {
  return raw === '' ? '' : raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

/** Read a string field from an Editor.js block `data`, or `undefined`. */
function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a text field (HTML-normalized) from an Editor.js block `data`. */
function textField(data: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(data, key);
  return value === undefined ? undefined : toPlainText(value);
}

/** Include `key` only when it decodes to a non-empty string. */
function optionalString(
  data: Record<string, unknown>,
  key: string,
): { readonly [key: string]: string } | Record<string, never> {
  const value = textField(data, key);
  return value !== undefined && value !== '' ? { [key]: value } : {};
}

/** Include `key` only when the persisted block carries a non-empty value. */
function optionalEscaped(
  value: string | undefined,
  key: string,
): { readonly [key: string]: string } | Record<string, never> {
  return value !== undefined && value !== '' ? { [key]: escapeText(value) } : {};
}

/** Include a raw custom-tool field; its input renders/values text, not HTML. */
function optionalRaw(
  value: string | undefined,
  key: string,
): { readonly [key: string]: string } | Record<string, never> {
  return value !== undefined && value !== '' ? { [key]: value } : {};
}

/**
 * Return `candidate` guaranteed not to collide with any id already in
 * `usedIds`, registering the chosen id. Collisions are resolved by appending
 * `-<n>` for the smallest `n` that yields a free id.
 */
function uniqueId(candidate: string, usedIds: Set<string>): string {
  let id = candidate;
  let n = 1;
  while (usedIds.has(id)) {
    id = `${candidate}-${n}`;
    n += 1;
  }
  usedIds.add(id);
  return id;
}

/**
 * Clamp an Editor.js header `level` to the contract bound (2..6), leaving a
 * non-numeric value as `NaN` so the schema rejects it rather than silently
 * reassigning a level.
 */
function clampHeadingLevel(level: unknown): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) return Number.NaN;
  return Math.min(6, Math.max(2, Math.round(level)));
}

// ---------------------------------------------------------------------------
// Reverse mapping: RichTextDocument -> Editor.js blocks
// ---------------------------------------------------------------------------

/** Map one persisted block to an Editor.js block (tool name + data). */
function richTextBlockToEditorJs(block: RichTextBlock): EditorJsBlock {
  const id = block.id;
  switch (block.type) {
    case 'paragraph':
      return { id, type: 'paragraph', data: { text: escapeText(block.text) } };
    case 'heading':
      return { id, type: 'header', data: { level: block.level, text: escapeText(block.text) } };
    case 'list':
      return {
        id,
        type: 'list',
        data: { style: block.style, items: block.items.map(escapeText) },
      };
    case 'quote':
      return {
        id,
        type: 'quote',
        data: { text: escapeText(block.text), ...optionalEscaped(block.citation, 'citation') },
      };
    case 'code':
      return {
        id,
        type: 'code',
        // Code is literal source: it must survive the round-trip byte-for-byte.
        data: { code: block.code, ...optionalEscaped(block.language, 'language') },
      };
    case 'divider':
      return { id, type: 'delimiter', data: {} };
    case 'image':
      return {
        id,
        type: 'image',
        data: {
          mediaId: block.mediaId,
          ...optionalRaw(block.alt, 'alt'),
          ...optionalRaw(block.caption, 'caption'),
        },
      };
    case 'gallery':
      return {
        id,
        type: 'gallery',
        data: { mediaIds: [...block.mediaIds], ...optionalRaw(block.alt, 'alt') },
      };
    case 'embed':
      return { id, type: 'embed', data: { url: block.url } };
    case 'callout':
      return { id, type: 'callout', data: { tone: block.tone, text: block.text } };
    case 'cta':
      return { id, type: 'cta', data: { label: block.label, href: block.href } };
  }
}

// ---------------------------------------------------------------------------
// Forward mapping: Editor.js blocks -> RichTextBlock
// ---------------------------------------------------------------------------

/**
 * Map one Editor.js block to a schema-bound block (with a unique `id`
 * assigned), or `null` when the tool type has no representation.
 *
 * `usedIds` is the running set of ids already assigned; a candidate id that
 * collides (an explicit id equal to another block's id, or a generated id equal
 * to an explicit one) is suffixed until unique. The schema bounds id length and
 * content but does not enforce uniqueness, so uniqueness is guaranteed here.
 */
function editorJsBlockToBlock(
  block: EditorJsBlock,
  index: number,
  usedIds: Set<string>,
): RichTextBlock | null {
  const id = uniqueId(
    typeof block.id === 'string' && block.id !== '' ? block.id : `block-${index}`,
    usedIds,
  );
  const data = typeof block.data === 'object' && block.data !== null ? block.data : {};

  switch (block.type) {
    case 'paragraph':
      // The schema rejects a missing/oversized `text`; '' is the empty default.
      return { id, type: 'paragraph', text: textField(data, 'text') ?? '' };
    case 'header':
      return {
        id,
        type: 'heading',
        level: clampHeadingLevel(data.level),
        text: textField(data, 'text') ?? '',
      };
    case 'list': {
      const style = stringField(data, 'style') ?? 'unordered';
      const rawItems = data.items;
      const items = Array.isArray(rawItems)
        ? rawItems.map((item) => (typeof item === 'string' ? toPlainText(item) : ''))
        : [];
      return {
        id,
        type: 'list',
        // A non-'ordered' value passes through so the enum rejects an unknown
        // style instead of silently reinterpreting it; 'unordered' is the
        // default when the field is absent.
        style: style as 'ordered' | 'unordered',
        items,
      };
    }
    case 'quote':
      return {
        id,
        type: 'quote',
        text: textField(data, 'text') ?? '',
        ...optionalString(data, 'citation'),
      };
    case 'code':
      return {
        id,
        type: 'code',
        // Code is literal source, not inline HTML: preserve tags and entities.
        code: stringField(data, 'code') ?? '',
        ...optionalString(data, 'language'),
      };
    case 'delimiter':
      return { id, type: 'divider' };
    case 'image': {
      const mediaId = data.mediaId;
      return {
        id,
        type: 'image',
        mediaId: typeof mediaId === 'string' ? mediaId : '',
        ...optionalString(data, 'alt'),
        ...optionalString(data, 'caption'),
      };
    }
    case 'gallery': {
      const raw = data.mediaIds;
      const mediaIds = Array.isArray(raw)
        ? raw.filter((mediaId): mediaId is string => typeof mediaId === 'string')
        : [];
      return {
        id,
        type: 'gallery',
        mediaIds,
        ...optionalString(data, 'alt'),
      };
    }
    case 'embed':
      return { id, type: 'embed', url: stringField(data, 'url') ?? '' };
    case 'callout': {
      const tone = stringField(data, 'tone');
      return {
        id,
        type: 'callout',
        // A non-callout tone passes through so the enum rejects unknown values.
        tone: (tone ?? 'info') as 'info' | 'success' | 'warning' | 'danger',
        text: textField(data, 'text') ?? '',
      };
    }
    case 'cta':
      return {
        id,
        type: 'cta',
        label: textField(data, 'label') ?? '',
        href: stringField(data, 'href') ?? '',
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Build and validate a rich-text document from an Editor.js output payload.
 *
 * Unknown tool types fail with `unsupported_block` and are never silently
 * dropped. Mapped blocks are assembled (with a generated id when the producer
 * supplied none) and the whole document is validated through {@link
 * richTextSchema}, so malformed or empty required fields fail the boundary with
 * value-free field errors rather than being persisted.
 */
export function editorJsToRichText(input: unknown): EditorJsBuildOutcome {
  if (
    typeof input !== 'object' ||
    input === null ||
    !Array.isArray((input as { blocks?: unknown }).blocks)
  ) {
    return {
      ok: false,
      error: new EditorConversionError(
        'invalid_document',
        'input is not an Editor.js output payload',
      ),
    };
  }

  const source = input as EditorJsOutputData;
  const blocks: RichTextBlock[] = [];
  const usedIds = new Set<string>();
  for (let i = 0; i < source.blocks.length; i++) {
    const sourceBlock = source.blocks[i];
    if (typeof sourceBlock?.type !== 'string' || !SUPPORTED_TOOL_TYPES.has(sourceBlock.type)) {
      const label = typeof sourceBlock?.type === 'string' ? sourceBlock.type : 'unknown';
      return {
        ok: false,
        error: new EditorConversionError(
          'unsupported_block',
          `Editor.js block of type "${label}" has no rich-text representation`,
        ),
      };
    }
    const mapped = editorJsBlockToBlock(sourceBlock, i, usedIds);
    // A supported type always maps; guarding keeps the switch's `default`
    // total without a non-exhaustive fallthrough.
    if (mapped === null) {
      return {
        ok: false,
        error: new EditorConversionError(
          'unsupported_block',
          `Editor.js block of type "${sourceBlock.type}" has no rich-text representation`,
        ),
      };
    }
    blocks.push(mapped);
  }

  const validated = richTextSchema.safeParse({ version: 1, blocks });
  if (!validated.success) {
    return {
      ok: false,
      error: new EditorConversionError(
        'invalid_document',
        'Editor.js payload does not produce a valid rich-text document',
      ),
    };
  }

  return { ok: true, document: validated.data };
}

/**
 * Build an Editor.js output payload from a validated rich-text document, to
 * load existing content into the editor.
 *
 * The input is validated through {@link richTextSchema} first, so its block ids
 * are non-empty, bounded, and unique. Every block maps to its Editor.js tool
 * representation, text fields are escaped so `<`/`&` survive a round-trip, and
 * code bodies are emitted literally. The payload carries `version: 1` matching
 * the persisted document and a `time` stamp so `editor.render` never mistakes
 * it for stale data.
 */
export function richTextToEditorJs(input: unknown): RichTextToEditorJsOutcome {
  const validated = richTextSchema.safeParse(input);
  if (!validated.success) {
    return {
      ok: false,
      error: new EditorConversionError('invalid_document', 'input is not a rich-text document'),
    };
  }

  const document = validated.data;
  return {
    ok: true,
    output: {
      time: Date.now(),
      version: '1',
      blocks: document.blocks.map(richTextBlockToEditorJs),
    },
  };
}
