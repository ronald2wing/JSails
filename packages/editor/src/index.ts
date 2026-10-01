/**
 * The rich-text editor (`@jsails/editor`): `mountRichTextEditor` builds a
 * ProseMirror editor with its toolbar, insert menu, dialogs and keyboard map
 * in an element, for any page or framework. It edits the persisted
 * `RichTextDocument` of `jsails/rich-text` and nothing else: the editor's
 * schema holds exactly the documents the model accepts, so
 * `handle.getDocument()` is always canonical and within budget.
 *
 * The Preact component and the form-field island are
 * `@jsails/editor/preact`; the HTML renderer and the field's server markup
 * are `@jsails/editor/server`.
 */

export {
  mountRichTextEditor,
  type MountRichTextEditorOptions,
  type RichTextEditorHandle,
} from './prosemirror/ui/rich-text-editor.js';
export { RichTextEditorErrors } from './prosemirror/editor-errors.js';
