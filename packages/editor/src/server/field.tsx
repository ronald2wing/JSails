/**
 * `RichTextField`, the server-rendered markup of a rich-text form field: the
 * `rich-text` island marker, its source input and the fallback a reader
 * without JavaScript sees (`../field/contract.ts` states the contract).
 *
 * The stored value is read with `parseRichText`. A readable document goes in
 * the source input under the field name, so a submit before the editor
 * starts sends it back unchanged. An unreadable value goes in without a name,
 * beside a panel listing the issues, so such a submit omits the field and
 * the server keeps the stored value; the island shows the same panel, with
 * an explicit way to discard the value.
 */

import type { VNode } from 'preact';

import { parseRichText } from 'jsails/rich-text';

import {
  FIELD_FALLBACK_TEXT,
  FIELD_WRAPPER_CLASS,
  RICH_TEXT_ISLAND,
  RICH_TEXT_SOURCE_ATTRIBUTE,
  UNREADABLE_KEPT_TEXT,
  UNREADABLE_TITLE,
  describeIssues,
  type RichTextFieldIslandProps,
} from '../field/contract.js';

/**
 * Props of {@link RichTextField}.
 *
 * @public
 */
export interface RichTextFieldProps {
  /** The form field name the document is submitted under. */
  readonly name: string;
  /**
   * The stored value, as read from storage (a document object, not its JSON
   * text). A value `parseRichText` refuses is shown as unreadable.
   */
  readonly value: unknown;
  /** The editor's accessible name. */
  readonly label?: string;
  /** The id of the editable surface, for a `<label for>`. */
  readonly id?: string;
  /** The media library endpoint the image and gallery blocks offer. */
  readonly mediaPickerUrl?: string;
}

/** The JSON text of a value, or empty when it has none (`undefined`, a cycle, a bigint). */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Not serialisable: there are no original bytes to carry.
    return '';
  }
}

/**
 * The markup of a rich-text form field for `value`. Register the island
 * (`richTextIsland` from `@jsails/editor/preact`) in the client entry for it
 * to become an editor.
 *
 * @public
 */
export function RichTextField(props: RichTextFieldProps): VNode {
  const read = parseRichText(props.value);
  const islandProps: RichTextFieldIslandProps = {
    name: props.name,
    ...(props.label === undefined ? {} : { label: props.label }),
    ...(props.id === undefined ? {} : { id: props.id }),
    ...(props.mediaPickerUrl === undefined ? {} : { mediaPickerUrl: props.mediaPickerUrl }),
  };
  const sourceAttributes = { [RICH_TEXT_SOURCE_ATTRIBUTE]: '' };
  if (read.ok) {
    return (
      <div data-jsails-island={RICH_TEXT_ISLAND} data-jsails-props={JSON.stringify(islandProps)}>
        <input
          type="hidden"
          {...sourceAttributes}
          name={props.name}
          value={JSON.stringify(read.value)}
        />
        <div class={FIELD_WRAPPER_CLASS} data-state="loading">
          <p class="rich-text-editor-fallback">{FIELD_FALLBACK_TEXT}</p>
        </div>
      </div>
    );
  }
  const { lines, more } = describeIssues(read.issues);
  return (
    <div data-jsails-island={RICH_TEXT_ISLAND} data-jsails-props={JSON.stringify(islandProps)}>
      <input type="hidden" {...sourceAttributes} value={jsonText(props.value)} />
      <div class={FIELD_WRAPPER_CLASS} data-state="unreadable">
        <div class="rich-text-editor-unreadable" role="group" aria-label={UNREADABLE_TITLE}>
          <p class="rich-text-editor-unreadable-title">{UNREADABLE_TITLE}</p>
          <ul>
            {lines.map((line) => (
              <li>{line}</li>
            ))}
          </ul>
          {more > 0 && <p>{`And ${String(more)} more.`}</p>}
          <p>{UNREADABLE_KEPT_TEXT}</p>
        </div>
      </div>
    </div>
  );
}
