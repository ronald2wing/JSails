/**
 * Rich-text editor foundation (`src/editor/`).
 *
 * Pure, DOM-gnostic conversion between the persisted {@link RichTextDocument}
 * and an Editor.js output payload, plus the DOM mount seam and the custom block
 * tools for the structured block kinds. Every persisted block kind has an
 * Editor.js representation: paragraph (built-in), heading, list, quote, code,
 * and divider via the official tools, and dedicated image/gallery/embed/callout/
 * cta tools in `editorjs/tools.ts`.
 *
 * The mount stays DOM-gnostic; the Preact island owns the host element and the
 * hidden input.
 */

export * from 'jsails/rich-text';

export { EDITOR_JS_ADAPTER_ID, editorJsAdapter } from './editorjs/adapter-definition.js';

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
} from './editorjs/adapter.js';

export {
  mountRichTextEditor,
  EditorError,
  type EditorElement,
  type EditorErrorCode,
  type EditorJsInstance,
  type MountRichTextEditorOptions,
  type RichTextEditorHandle,
} from './editorjs/mount.js';

export {
  CalloutTool,
  CtaTool,
  EmbedTool,
  GalleryTool,
  ImageTool,
  type CalloutData,
  type CtaData,
  type EmbedData,
  type GalleryData,
  type ImageData,
  type MediaPickerToolConfig,
} from './editorjs/tools.js';

export {
  mapMediaAssetsToPickerItems,
  pickerItemLabel,
  validateMediaPickerUrl,
  type MediaPickerItem,
} from './editorjs/picker.js';
