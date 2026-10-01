/**
 * The part of the rich-text island loaded with `import()` the first time a
 * field hydrates or a `RichTextEditor` mounts: reading the field's source
 * with `parseRichText`, the empty document, and the editor with its UI
 * (ProseMirror, the toolbar and `jsails/rich-text`).
 *
 * The starter registers the island in the client entry every page loads, so
 * everything here stays out of that entry: a page without an editor never
 * downloads it.
 */

export { createEmptyRichTextDocument } from 'jsails/rich-text';

export { readFieldSource } from '../field/source.js';
export { mountRichTextEditor } from '../prosemirror/ui/rich-text-editor.js';
