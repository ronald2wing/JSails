/**
 * Reading the rich-text field's source input in the browser: the JSON text
 * the server wrote (`contract.ts`) read with `parseRichText`, the only
 * reader. A value that is not JSON is refused with the same value-free issue
 * `parseRichText` gives any non-document, so nothing of the stored text
 * reaches the page.
 */

import { parseRichText, type RichTextDocument, type RichTextIssue } from 'jsails/rich-text';

/** The field's source value read as a document, or the issues that refuse it. */
export type FieldSourceRead =
  | { readonly ok: true; readonly document: RichTextDocument }
  | { readonly ok: false; readonly issues: readonly RichTextIssue[] };

/** Read the JSON text of a field's source input. */
export function readFieldSource(raw: string): FieldSourceRead {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Not JSON: read as no value, which parseRichText refuses as not a document.
    value = undefined;
  }
  const read = parseRichText(value);
  return read.ok ? { ok: true, document: read.value } : { ok: false, issues: read.issues };
}
