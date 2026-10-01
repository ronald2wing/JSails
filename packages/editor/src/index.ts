/**
 * Editor.js rich-text editor (`@jsails/editor`): the first-party
 * {@link RichTextEditorAdapter} plus pure, DOM-free conversion between the
 * persisted {@link RichTextDocument} and an Editor.js output payload.
 *
 * Every persisted block kind has an Editor.js representation: paragraph
 * (built-in), heading, list, quote, code, and divider via the official tools,
 * and dedicated image/gallery/embed/callout/cta tools in `editorjs/tools.ts`.
 * The DOM mount and the custom tools are wired by the Preact island
 * (`@jsails/editor/preact`); the server renderer is `@jsails/editor/server`.
 * The persisted document model itself is `jsails/rich-text`.
 */

export { editorJsAdapter } from './editorjs/adapter.js';

export {
  editorJsToRichText,
  richTextToEditorJs,
  EditorConversionError,
  type EditorConversionErrorCode,
  type EditorJsBlock,
  type EditorJsBuildFailure,
  type EditorJsBuildOutcome,
  type EditorJsBuildResult,
  type EditorJsOutputData,
  type RichTextToEditorJsFailure,
  type RichTextToEditorJsOutcome,
  type RichTextToEditorJsResult,
} from './editorjs/conversion.js';
