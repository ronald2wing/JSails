/**
 * Editor adapter contract: a canonical rich-text document plus an optional
 * editor-owned native payload.
 *
 * The canonical {@link RichTextDocument} is the framework-owned, renderable,
 * searchable shape. An editor adapter can additionally preserve its own JSON
 * state in {@link EditorDocument.native}; that payload is never rendered by the
 * core renderer. It exists so an editor whose full state is richer than the
 * canonical blocks does not lose it on every save.
 *
 * `native` is optional on purpose:
 * - an adapter whose data already is canonical (`@jsails/editor`'s Editor.js
 *   adapter) omits it;
 * - an adapter with richer state stores it and uses `fromContent` only as the
 *   fallback when the envelope names another editor or carries no payload.
 *
 * The adapter is deliberately data-shaped and package-agnostic: it carries an
 * id, a browser island name, a Zod payload schema, and two pure conversion
 * functions. Mounting, rendering, and UI remain editor-package concerns.
 */

import { z } from 'zod';

import { richTextSchema, type RichTextDocument } from './document.js';
import { JsailsError } from '../errors/jsails-error.js';

/** The default browser island name used by a canonical rich-text field. */
export const DEFAULT_RICH_TEXT_ISLAND = 'rich-text';

/** The only accepted version of an {@link EditorDocument} envelope. */
export const EDITOR_DOCUMENT_VERSION = 1;

/** A JSON-compatible value. Kept local so this subpath stays dependency-free. */
export type EditorJsonValue =
  | string
  | number
  | boolean
  | null
  | EditorJsonValue[]
  | { readonly [key: string]: EditorJsonValue };

/** Recursive schema for {@link EditorJsonValue}. */
const editorJsonValueSchema: z.ZodType<EditorJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(editorJsonValueSchema),
    z.record(z.string(), editorJsonValueSchema),
  ]),
);

/** A persisted editor document: canonical content plus optional native payload. */
export const editorDocumentSchema = z.object({
  version: z.literal(EDITOR_DOCUMENT_VERSION),
  /** Stable adapter id, e.g. `editorjs` or a custom editor's id. */
  editor: z.string().min(1).max(190),
  /** Canonical content used for rendering, search, exports, and fallback. */
  content: richTextSchema,
  /** Optional editor-owned JSON, opaque to the framework. */
  native: editorJsonValueSchema.optional(),
});

/** A persisted editor document. */
export type EditorDocument = z.infer<typeof editorDocumentSchema>;

/** An adapter's opaque payload schema. */
export type EditorPayloadSchema<TPayload> = z.ZodType<TPayload>;

/** Options passed to an adapter's optional full-fidelity renderer. */
export type EditorRenderOptions = Readonly<Record<string, unknown>>;

/**
 * A pluggable rich-text editor.
 *
 * Implementations must be pure with respect to content conversion: no I/O, no
 * DOM, no global state. The browser island is registered separately under
 * {@link RichTextEditorAdapter.island}; this contract only describes the data
 * boundary used by the admin field and persistence.
 */
export interface RichTextEditorAdapter<TPayload = EditorJsonValue> {
  /** Stable id persisted in {@link EditorDocument.editor}. */
  readonly id: string;
  /** Browser island name the admin field hydrates. */
  readonly island: string;
  /** Schema for the adapter-owned payload. */
  readonly payloadSchema: EditorPayloadSchema<TPayload>;
  /** Project the native payload onto the canonical document. */
  toContent(payload: TPayload): RichTextDocument;
  /** Build a native payload from canonical content. */
  fromContent(content: RichTextDocument): TPayload;
  /**
   * Optional full-fidelity server renderer. When omitted, callers should render
   * `content` with the framework's canonical renderer.
   */
  render?(payload: TPayload, options?: EditorRenderOptions): string;
}

/** Stable machine codes carried by {@link EditorAdapterError}. */
export type EditorAdapterErrorCode = 'invalid_adapter' | 'invalid_document';

/** Raised for invalid adapter definitions or envelope construction. */
export class EditorAdapterError extends JsailsError {
  constructor(
    readonly code: EditorAdapterErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Freeze and validate an editor adapter. */
export function defineRichTextEditorAdapter<TPayload>(
  adapter: RichTextEditorAdapter<TPayload>,
): RichTextEditorAdapter<TPayload> {
  if (adapter === null || typeof adapter !== 'object') {
    throw new EditorAdapterError('invalid_adapter', 'editor adapter must be an object');
  }
  if (typeof adapter.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(adapter.id)) {
    throw new EditorAdapterError('invalid_adapter', 'editor adapter id must match [a-z][a-z0-9-]*');
  }
  if (typeof adapter.island !== 'string' || adapter.island.trim() === '') {
    throw new EditorAdapterError(
      'invalid_adapter',
      'editor adapter island must be a non-empty string',
    );
  }
  if (
    typeof adapter.toContent !== 'function' ||
    typeof adapter.fromContent !== 'function' ||
    typeof adapter.payloadSchema?.safeParse !== 'function'
  ) {
    throw new EditorAdapterError(
      'invalid_adapter',
      'editor adapter requires payloadSchema, toContent, and fromContent',
    );
  }
  if (adapter.render !== undefined && typeof adapter.render !== 'function') {
    throw new EditorAdapterError('invalid_adapter', 'editor adapter render must be a function');
  }
  return Object.freeze({
    id: adapter.id,
    island: adapter.island,
    payloadSchema: adapter.payloadSchema,
    toContent: adapter.toContent,
    fromContent: adapter.fromContent,
    ...(adapter.render === undefined ? {} : { render: adapter.render }),
  });
}

/**
 * Build a persisted envelope from an adapter and its native payload.
 *
 * The payload is projected to canonical content and validated as JSON so a
 * function, class instance, or circular value cannot reach a JSON column.
 */
export function createEditorDocument<TPayload>(
  adapter: RichTextEditorAdapter<TPayload>,
  payload: TPayload,
): EditorDocument {
  if (!adapter.payloadSchema.safeParse(payload).success) {
    throw new EditorAdapterError('invalid_document', 'editor payload is invalid');
  }
  const content = adapter.toContent(payload);
  const parsed = editorDocumentSchema.safeParse({
    version: EDITOR_DOCUMENT_VERSION,
    editor: adapter.id,
    content,
    native: payload,
  });
  if (!parsed.success) {
    throw new EditorAdapterError('invalid_document', 'editor document is invalid');
  }
  return parsed.data;
}

/** Build a canonical-only envelope (no native payload). */
export function createCanonicalEditorDocument(
  editor: string,
  content: RichTextDocument,
): EditorDocument {
  const parsed = editorDocumentSchema.safeParse({
    version: EDITOR_DOCUMENT_VERSION,
    editor,
    content,
  });
  if (!parsed.success) {
    throw new EditorAdapterError('invalid_document', 'editor document is invalid');
  }
  return parsed.data;
}

/** True for a valid editor envelope; does not validate adapter payloads. */
export function isEditorDocument(input: unknown): input is EditorDocument {
  return editorDocumentSchema.safeParse(input).success;
}

/**
 * Return canonical content from either a canonical document or an envelope.
 * Throws a value-free error for any other shape; callers that accept untrusted
 * form input should validate first.
 */
export function editorDocumentContent(input: unknown): RichTextDocument {
  if (isEditorDocument(input)) {
    return input.content;
  }
  const parsed = richTextSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }
  throw new EditorAdapterError('invalid_document', 'input is not a rich-text document');
}

/**
 * Resolve the native payload for an envelope with an adapter, falling back to
 * `adapter.fromContent(document.content)` when the envelope has no payload or
 * names a different editor.
 */
export function editorDocumentPayload<TPayload>(
  adapter: RichTextEditorAdapter<TPayload>,
  document: EditorDocument,
): TPayload {
  if (document.editor === adapter.id && document.native !== undefined) {
    const parsed = adapter.payloadSchema.safeParse(document.native);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return adapter.fromContent(document.content);
}
