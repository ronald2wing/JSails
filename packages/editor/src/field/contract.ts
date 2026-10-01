/**
 * The rich-text form field's markup contract, shared by the server renderer
 * of the field (`RichTextField` in `@jsails/editor/server`) and the island
 * that hydrates it (`RichTextIsland` in `@jsails/editor/preact`). An app or
 * plugin that renders the field itself (the admin does, without depending on
 * this package) follows the same shape:
 *
 * ```html
 * <div data-jsails-island="rich-text" data-jsails-props='{"name":"body","label":"Body"}'>
 *   <input type="hidden" data-rich-text-source name="body" value="{&quot;version&quot;:2,…}">
 *   <div class="rich-text-editor" data-state="loading">…fallback content…</div>
 * </div>
 * ```
 *
 * - The island element holds exactly two children, the source input and the
 *   wrapper (`data-state` is `loading` for a readable value, `unreadable`
 *   otherwise), because the island's first render is the same two elements:
 *   hydration then reuses both, and leaves the input's `name` and value, and
 *   the wrapper's attributes and content, as the server wrote them until the
 *   editor has read the source.
 * - The document travels in the source input, never in the island props,
 *   whose bounded JSON (65 536 characters) is smaller than the document
 *   budget (256 KiB).
 * - The source carries the field `name` only when its value is a document
 *   `parseRichText` reads: a submit without JavaScript, or after the editor
 *   failed to start, then sends the original value back unchanged. An
 *   unreadable value is carried without a `name`, so such a submit omits the
 *   field, which the server reads as "keep the stored value".
 * - The island props are `name`, and optionally `label` (the editor's
 *   accessible name), `id` (the id of the editable surface) and
 *   `mediaPickerUrl`.
 *
 * This module is plain data and text, safe for both the browser shell and
 * the server.
 */

import type { RichTextIssue } from 'jsails/rich-text';

/**
 * The island name the rich-text field hydrates under.
 *
 * @public
 */
export const RICH_TEXT_ISLAND = 'rich-text';

/**
 * The attribute that marks the field's source input, the hidden input
 * holding the document's JSON.
 */
export const RICH_TEXT_SOURCE_ATTRIBUTE = 'data-rich-text-source';

/** The class of the wrapper element the server renders and the island keeps. */
export const FIELD_WRAPPER_CLASS = 'rich-text-editor';

/** The props of the field island, as the server writes them. */
export interface RichTextFieldIslandProps {
  readonly name: string;
  readonly label?: string;
  readonly id?: string;
  readonly mediaPickerUrl?: string;
}

/** Shown by the server until the editor starts, and to a reader without JavaScript. */
export const FIELD_FALLBACK_TEXT =
  'Editing this field needs JavaScript. Saving the form keeps its content unchanged.';

/** The heading of the panel shown for a stored value the editor cannot read. */
export const UNREADABLE_TITLE = 'This content cannot be edited here.';

/** The panel's note on what a save does to the unreadable value. */
export const UNREADABLE_KEPT_TEXT = 'Saving the form keeps the stored content unchanged.';

/** At most this many issues are listed; the rest are counted. */
export const MAX_LISTED_ISSUES = 20;

/**
 * The lines the unreadable panel lists: each issue's path (`blocks.3.href`,
 * or `document` for the value as a whole) and message. Issues are
 * value-free, so no line repeats the stored text.
 */
export function describeIssues(issues: readonly RichTextIssue[]): {
  readonly lines: readonly string[];
  readonly more: number;
} {
  const lines = issues
    .slice(0, MAX_LISTED_ISSUES)
    .map(
      (issue) => `${issue.path.length === 0 ? 'document' : issue.path.join('.')}: ${issue.message}`,
    );
  return { lines, more: Math.max(0, issues.length - MAX_LISTED_ISSUES) };
}
