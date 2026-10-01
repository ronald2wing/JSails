/**
 * The error codes of the ProseMirror rich-text engine, `rich_text_editor.*`.
 *
 * Every code is value-free: an attribute refusal names the node or mark type
 * and the attribute, never the refused value, and a document refusal carries
 * `parseRichText`'s issues (a path and a rule, never the offending text).
 */

import { defineErrors, type ErrorRegistry, type Payload } from 'jsails/errors';
import type { RichTextIssue } from 'jsails/rich-text';

const RICH_TEXT_EDITOR_ERRORS = {
  invalid_attribute: {
    kind: 'invalid',
    message: 'attribute {attribute} of {owner} holds a value the rich-text model refuses',
    context: { owner: 'identifier', attribute: 'identifier' },
  },
  invalid_document: {
    kind: 'invalid',
    message: 'the value is not a readable rich-text document',
    suggestion: 'read stored values with parseRichText and show its issues instead of mounting',
    payload: {} as Payload<{ readonly issues: readonly RichTextIssue[] }>,
  },
  invalid_element: {
    kind: 'invalid',
    message: 'the rich-text editor needs a DOM element to mount into',
  },
  editor_destroyed: {
    kind: 'invalid',
    message: 'the rich-text editor was destroyed',
  },
  decode_refused: {
    kind: 'internal',
    message: 'decoding the editor state produced a document parseRichText refuses',
    payload: {} as Payload<{ readonly issues: readonly RichTextIssue[] }>,
  },
} as const;

/**
 * The engine's codes: an attribute value the model refuses (thrown from the
 * schema's attribute validation, so no node or mark can hold one), a mount or
 * `setDocument` input that `parseRichText` refuses, a mount target that is not
 * an element, a call on a destroyed editor, and the development-build check
 * that `decode` produced a readable document.
 *
 * @public
 */
export const RichTextEditorErrors: ErrorRegistry<
  'rich_text_editor',
  typeof RICH_TEXT_EDITOR_ERRORS
> = defineErrors('rich_text_editor', RICH_TEXT_EDITOR_ERRORS);
