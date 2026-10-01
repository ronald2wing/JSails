/**
 * The rich-text editor for Preact (`@jsails/editor/preact`): the
 * `RichTextEditor` component and the `rich-text` form-field island that
 * hydrates the field markup a server renders (`RichTextField` from
 * `@jsails/editor/server`, or an admin `richText` field).
 *
 * Register the island in a browser entry with the declarative map:
 *
 * ```ts
 * import { startClient } from 'jsails/client';
 * import { richTextIsland } from '@jsails/editor/preact';
 *
 * await startClient({ islands: richTextIsland });
 * ```
 */

export { RICH_TEXT_ISLAND } from '../field/contract.js';
export {
  RichTextEditor,
  RichTextIsland,
  richTextIsland,
  type RichTextEditorProps,
} from './editor.js';
export type { RichTextEditorHandle } from '../prosemirror/ui/rich-text-editor.js';
