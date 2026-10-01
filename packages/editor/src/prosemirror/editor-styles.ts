/**
 * The editor's own styles, applied by the editor when it mounts, so an app
 * that registers the island needs no stylesheet import for it to work.
 *
 * - {@link PROSEMIRROR_CSS} is what `prosemirror-view` requires of the page
 *   (its `style/prosemirror.css`): above all `white-space: break-spaces` (or
 *   `pre-wrap`) on the editable element, without which the browser collapses
 *   runs of spaces the document keeps, the caret drifts from the text, and
 *   ProseMirror warns. The headless mount applies it.
 * - {@link EDITOR_UI_CSS} lays out the toolbar, the insert menu, the dialog,
 *   the media picker and the block controls. Every selector is wrapped in
 *   `:where()`, so its specificity is zero and any rule of the app wins; it
 *   sets no text or background colour of its own (borders and the pressed
 *   state mix `currentColor`), so contrast stays the app's. The editor with
 *   its UI applies it.
 *
 * The sheets are constructed stylesheets adopted by the document
 * (`document.adoptedStyleSheets`), once per document: no `<style>` element
 * is written, so a Content-Security-Policy without `'unsafe-inline'` styles
 * does not block them. A document that cannot adopt sheets is left as it is.
 */

/** The rules `prosemirror-view` expects, from its `style/prosemirror.css`. */
export const PROSEMIRROR_CSS = `
.ProseMirror {
  position: relative;
  word-wrap: break-word;
  white-space: pre-wrap;
  white-space: break-spaces;
  -webkit-font-variant-ligatures: none;
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0;
}
.ProseMirror pre { white-space: pre-wrap; }
.ProseMirror li { position: relative; }
.ProseMirror-hideselection *::selection { background: transparent; }
.ProseMirror-hideselection { caret-color: transparent; }
.ProseMirror [draggable][contenteditable=false] { user-select: text; }
.ProseMirror-selectednode { outline: 2px solid Highlight; }
li.ProseMirror-selectednode { outline: none; }
li.ProseMirror-selectednode::after {
  content: "";
  position: absolute;
  inset: -2px -2px -2px -32px;
  border: 2px solid Highlight;
  pointer-events: none;
}
img.ProseMirror-separator {
  display: inline !important;
  border: none !important;
  margin: 0 !important;
}
`;

const LINE = '1px solid color-mix(in srgb, currentColor 30%, transparent)';

/** The layout of the editing UI, at zero specificity; each selector list stays on one line. */
export const EDITOR_UI_CSS: string = `
:where(.rich-text-editor-ui) { display: flex; flex-direction: column; gap: 0.5rem; }
:where(.rich-text-editor-toolbar) {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem;
}
:where(.rich-text-editor-ui) :where(button, select, input, textarea) {
  font: inherit; color: inherit;
}
:where(.rich-text-editor-toolbar, .rich-text-editor-menu, .rich-text-editor-dialog-actions, .rich-text-editor-picker, .rich-text-editor-block-controls) :where(button, select) {
  padding: 0.25rem 0.5rem; border: ${LINE}; border-radius: 0.25rem; background: transparent;
}
:where(.rich-text-editor-toolbar) :where(button[aria-pressed="true"]) {
  background: color-mix(in srgb, currentColor 15%, transparent);
}
:where(.rich-text-editor-menu) {
  display: flex; flex-direction: column; align-items: flex-start; gap: 0.25rem;
}
:where(.rich-text-editor-dialog) {
  display: grid; gap: 0.5rem; padding: 0.75rem; border: ${LINE}; border-radius: 0.375rem;
}
:where(.rich-text-editor-dialog-title) { margin: 0; font-weight: 600; }
:where(.rich-text-editor-dialog-field, .rich-text-editor-attribute) { display: grid; gap: 0.25rem; }
:where(.rich-text-editor-dialog-field, .rich-text-editor-attribute) :where(input, textarea) {
  padding: 0.25rem 0.5rem; border: ${LINE}; border-radius: 0.25rem; background: transparent;
}
:where(.rich-text-editor-dialog-error, .rich-text-editor-attribute-error) {
  margin: 0; font-weight: 600;
}
:where(.rich-text-editor-dialog-error:empty, .rich-text-editor-attribute-error:empty) {
  display: none;
}
:where(.rich-text-editor-dialog-actions, .rich-text-editor-picker, .rich-text-editor-block-controls) {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem;
}
:where(.rich-text-editor-picker-results) {
  flex-basis: 100%; max-height: 12rem; overflow: auto; margin: 0; padding: 0; list-style: none;
}
:where(.rich-text-editor-status, .rich-text-editor-picker-status) { margin: 0; font-size: 0.875em; }
:where(.rich-text-editor-status:empty, .rich-text-editor-picker-status:empty) { display: none; }
:where(.rich-text-editor-surface) :where(.ProseMirror) {
  min-height: 8rem; padding: 0.75rem; border: ${LINE}; border-radius: 0.375rem;
}
:where(.rich-text-editor-surface) :where(.ProseMirror:focus-visible) {
  outline: 2px solid Highlight; outline-offset: 2px;
}
:where(.rich-text-editor-block, .rich-text-editor-callout, .rich-text-editor-quote, .rich-text-editor-code) {
  display: grid; gap: 0.5rem; margin: 0.5rem 0; padding: 0.5rem; border: ${LINE};
  border-radius: 0.25rem;
}
:where(.rich-text-editor-block) :where(figcaption) { font-weight: 600; }
:where(.rich-text-editor-task-checkbox) { margin-inline-end: 0.5em; }
:where(.rich-text-editor-ui [hidden]) { display: none; }
`;

const adopted = new WeakMap<Document, Set<string>>();

/**
 * Adopt `css` into `document` once, as a constructed stylesheet placed after
 * the sheets it already adopted. Nothing happens in a document whose window
 * cannot construct or adopt sheets.
 */
export function adoptEditorStyles(document: Document, css: string): void {
  const done = adopted.get(document) ?? new Set<string>();
  if (done.has(css)) {
    return;
  }
  const view = document.defaultView;
  if (view === null || !('CSSStyleSheet' in view) || !('adoptedStyleSheets' in document)) {
    return;
  }
  // A sheet must be built by the realm of the document that adopts it.
  const sheet = new view.CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  done.add(css);
  adopted.set(document, done);
}
