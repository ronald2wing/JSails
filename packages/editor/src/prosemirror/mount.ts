/**
 * The headless rich-text editor: ProseMirror over `richTextEditorSchema`, with
 * the base keymap, history, input rules, the model's text and task-item
 * rules, the structure guard and the size budget, and no toolbar. The editing
 * UI (`ui/rich-text-editor.ts`) mounts through it, adding its own plugins
 * (ahead of these, so its keys win), node views and view attributes.
 *
 * {@link mountHeadlessRichTextEditor} is fully synchronous: it reads the document with
 * `parseRichText` (a refused document throws `rich_text_editor.invalid_document`
 * carrying the issues, so the caller shows them instead of an editor),
 * encodes it, and returns a handle whose `getDocument()` decodes the current
 * state. Nothing is mirrored or saved in the background: the document is
 * computed from the state when asked for. {@link createRichTextEditorState}
 * builds the same state without a view. The mount adopts the CSS ProseMirror
 * requires into the element's document (`editor-styles.ts`).
 *
 * Keys beyond ProseMirror's base keymap: Enter splits a list item (an empty
 * nested item moves out a level), Mod-] and Mod-[ nest and un-nest it,
 * Shift-Enter inserts a line break, Mod-z, Shift-Mod-z and Mod-y undo and
 * redo, Backspace right after an input rule undoes the rule, and Mod-b,
 * Mod-i, Mod-Shift-s and Mod-e toggle bold, italic, strike and code.
 */

import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { undoInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { EditorState, type Command, type Plugin } from 'prosemirror-state';
import { EditorView, type NodeViewConstructor } from 'prosemirror-view';

import { parseRichText, type RichTextDocument, type RichTextMeasure } from 'jsails/rich-text';

import { decode, encode } from './codec.js';
import { RichTextEditorErrors } from './editor-errors.js';
import { PROSEMIRROR_CSS, adoptEditorStyles } from './editor-styles.js';
import { richTextInputRules } from './input-rules.js';
import { richTextLimits } from './limits.js';
import {
  liftRichTextListItem,
  sinkRichTextListItem,
  splitRichTextListItem,
} from './list-commands.js';
import { nodeType, richTextEditorSchema } from './schema.js';
import { richTextStructureGuard } from './structure-guard.js';
import { richTextTaskItems } from './task-items.js';
import { richTextTextRules } from './text-rules.js';

/** Shift-Enter: a line break where the block's text allows one (not in a heading). */
const insertHardBreak: Command = (state, dispatch) => {
  const hardBreak = nodeType('hard_break');
  const { $from } = state.selection;
  if (!$from.parent.canReplaceWith($from.index(), $from.indexAfter(), hardBreak)) {
    return false;
  }
  dispatch?.(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
  return true;
};

const markType = (name: 'bold' | 'italic' | 'strike' | 'code') => richTextEditorSchema.marks[name];

/**
 * Options for {@link richTextEditorPlugins}.
 */
export interface RichTextEditorPluginOptions {
  /** Called with the refused document's measure when an edit would pass the budget. */
  readonly onBudgetExceeded?: (measure: RichTextMeasure) => void;
}

/** The editor's plugins, in precedence order. */
export function richTextEditorPlugins(options: RichTextEditorPluginOptions = {}): Plugin[] {
  return [
    richTextInputRules(),
    keymap({
      Enter: splitRichTextListItem,
      'Mod-]': sinkRichTextListItem,
      'Mod-[': liftRichTextListItem,
      'Shift-Enter': insertHardBreak,
      'Mod-z': undo,
      'Shift-Mod-z': redo,
      'Mod-y': redo,
      Backspace: undoInputRule,
      'Mod-b': toggleMark(markType('bold')),
      'Mod-i': toggleMark(markType('italic')),
      'Mod-Shift-s': toggleMark(markType('strike')),
      'Mod-e': toggleMark(markType('code')),
    }),
    keymap(baseKeymap),
    history(),
    richTextTextRules(),
    richTextTaskItems(),
    richTextStructureGuard(),
    richTextLimits(
      options.onBudgetExceeded === undefined ? {} : { onRefuse: options.onBudgetExceeded },
    ),
  ];
}

/**
 * An editor state holding `document`, which must be one `parseRichText`
 * accepts (otherwise `rich_text_editor.invalid_document` with its issues).
 * `plugins` defaults to a fresh {@link richTextEditorPlugins}.
 */
export function createRichTextEditorState(
  document: RichTextDocument,
  plugins: readonly Plugin[] = richTextEditorPlugins(),
): EditorState {
  const parsed = parseRichText(document);
  if (!parsed.ok) {
    throw new RichTextEditorErrors.Error(
      'invalid_document',
      {},
      { payload: { issues: parsed.issues } },
    );
  }
  const doc = richTextEditorSchema.nodeFromJSON(encode(parsed.value));
  doc.check();
  return EditorState.create({ doc, plugins: [...plugins] });
}

/**
 * Options for {@link mountHeadlessRichTextEditor}.
 */
export interface MountHeadlessRichTextEditorOptions extends RichTextEditorPluginOptions {
  /** The element the editor is placed in. */
  readonly element: HTMLElement;
  /** The initial document; it must pass `parseRichText`. */
  readonly document: RichTextDocument;
  /** Plugins placed ahead of the editor's own, so their keys and props take precedence. */
  readonly plugins?: readonly Plugin[];
  /** Node views by node name. */
  readonly nodeViews?: Readonly<Record<string, NodeViewConstructor>>;
  /**
   * Attributes of the editable element, added to `role="textbox"` and
   * `aria-multiline="true"` (which they cannot replace).
   */
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * A mounted editor.
 */
export interface HeadlessRichTextEditorHandle {
  /**
   * The ProseMirror view, the seam the editing UI dispatches its commands
   * through. Every transaction it dispatches passes the editor's plugins.
   */
  readonly view: EditorView;
  /** The current document, decoded from the editor state (canonical, within budget). */
  getDocument(): RichTextDocument;
  /** Replace the content and start a new undo history; the document must pass `parseRichText`. */
  setDocument(document: RichTextDocument): void;
  /** Remove the editor from the element. Idempotent; `getDocument` keeps returning the last document. */
  destroy(): void;
}

function isElement(value: unknown): value is HTMLElement {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { readonly nodeType?: unknown }).nodeType === 1 &&
    typeof (value as { readonly appendChild?: unknown }).appendChild === 'function'
  );
}

/**
 * Mount an editor for `document` into `element`, synchronously.
 */
export function mountHeadlessRichTextEditor(
  options: MountHeadlessRichTextEditorOptions,
): HeadlessRichTextEditorHandle {
  if (!isElement(options.element)) {
    throw new RichTextEditorErrors.Error('invalid_element');
  }
  adoptEditorStyles(options.element.ownerDocument, PROSEMIRROR_CSS);
  const plugins = [
    ...(options.plugins ?? []),
    ...richTextEditorPlugins(
      options.onBudgetExceeded === undefined ? {} : { onBudgetExceeded: options.onBudgetExceeded },
    ),
  ];
  const view = new EditorView(options.element, {
    state: createRichTextEditorState(options.document, plugins),
    ...(options.nodeViews === undefined ? {} : { nodeViews: { ...options.nodeViews } }),
    attributes: { ...options.attributes, role: 'textbox', 'aria-multiline': 'true' },
  });
  let destroyed = false;
  return {
    view,
    getDocument: () => decode(view.state.doc),
    setDocument(document) {
      if (destroyed) {
        throw new RichTextEditorErrors.Error('editor_destroyed');
      }
      view.updateState(createRichTextEditorState(document, plugins));
    },
    destroy() {
      if (!destroyed) {
        destroyed = true;
        view.destroy();
      }
    },
  };
}
