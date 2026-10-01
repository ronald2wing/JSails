/**
 * The rich-text editor with its editing UI, `mountRichTextEditor` of
 * `@jsails/editor`: the headless ProseMirror mount (`../mount.ts`) plus the
 * toolbar, the insert menu, the dialog, the task checkboxes, the node views
 * of the blocks that carry values, and the keyboard map.
 *
 * Built inside the given element, in order: the toolbar, the insert menu,
 * the dialog, the editable surface (`role="textbox"`, `aria-multiline`,
 * labelled by `label`) and a polite status line that says when an edit was
 * refused because the document would pass its size budget, laid out by the
 * zero-specificity UI stylesheet the mount adopts (`../editor-styles.ts`).
 * Mounting is synchronous; nothing is saved or mirrored in the background, and
 * `getDocument()` decodes the current state when asked.
 *
 * Keys added to the headless editor's: Mod-k opens the link dialog, Alt-F10
 * moves focus to the toolbar (Escape there returns), Mod-Alt-0 makes a
 * paragraph and Mod-Alt-2 to Mod-Alt-6 a heading, Mod-Shift-8, -7 and -9
 * toggle a bulleted, numbered and task list, and Mod-Enter checks or
 * unchecks a task item. Tab is left to the browser, so focus never gets
 * trapped in the editor.
 */

import { keymap } from 'prosemirror-keymap';
import { Plugin, type Command } from 'prosemirror-state';
import type { EditorView, NodeViewConstructor } from 'prosemirror-view';

import { isLinkHref, type RichTextDocument } from 'jsails/rich-text';

import { decode } from '../codec.js';
import { EDITOR_UI_CSS, adoptEditorStyles } from '../editor-styles.js';
import { mountHeadlessRichTextEditor, type HeadlessRichTextEditorHandle } from '../mount.js';
import { atomView } from '../node-views/atom-view.js';
import { textblockView } from '../node-views/textblock-view.js';
import { acceptsAttribute } from '../schema.js';
import { createBlockMenu, type BlockMenuItem } from './block-menu.js';
import {
  activeLinkHref,
  canLink,
  insertAtomCommand,
  removeLinkCommand,
  setBlockTypeCommand,
  setLinkCommand,
  toggleListCommand,
  toggleTaskCommand,
  type AtomName,
} from './commands.js';
import { createFieldDialog, type DialogField } from './field-dialog.js';
import { isMediaPickerUrl } from './media-picker.js';
import { richTextTaskCheckboxes } from './task-checkboxes.js';
import { createToolbar } from './toolbar.js';

/**
 * Options for {@link mountRichTextEditor}.
 *
 * @public
 */
export interface MountRichTextEditorOptions {
  /** The element the editor is built in; its existing children are kept. */
  readonly element: HTMLElement;
  /** The initial document; it must pass `parseRichText`. */
  readonly document: RichTextDocument;
  /** The accessible name of the editable surface. Defaults to `Rich text`. */
  readonly label?: string;
  /** The id of the editable surface; a `<label for>` naming it focuses the editor. */
  readonly id?: string;
  /**
   * A same-origin endpoint answering with the media library's paged
   * `{ assets, total }` envelope, offered by the image and gallery blocks.
   * A value that is not a root-relative path or an http(s) URL is ignored.
   */
  readonly mediaPickerUrl?: string;
  /** Called with the current document after every change to it. */
  readonly onChange?: (document: RichTextDocument) => void;
}

/**
 * A mounted editor.
 *
 * @public
 */
export interface RichTextEditorHandle {
  /** The ProseMirror view: every transaction it dispatches passes the editor's rules and budget. */
  readonly view: EditorView;
  /** The current document, decoded from the editor state: canonical and within budget. */
  getDocument(): RichTextDocument;
  /** Replace the content and start a new undo history; the document must pass `parseRichText`. */
  setDocument(document: RichTextDocument): void;
  /** Move focus into the editable surface. */
  focus(): void;
  /** Remove the editor and its listeners. Idempotent. */
  destroy(): void;
}

const BUDGET_TEXT = 'That change was not made: the document would pass its size limit.';

const TEXT_CHECK_MESSAGE =
  'Use one line of text without control characters, within the length limit.';
const LINK_CHECK_MESSAGE =
  'Enter a path such as /pricing, a #fragment, an http(s) URL, mailto: or tel:.';

let editorCount = 0;

/** A dialog field checked with the schema's rule for `owner.attribute`. */
function attributeField(
  owner: string,
  attribute: string,
  label: string,
  message: string,
  optional = false,
): DialogField {
  return {
    key: attribute,
    label,
    check: (value) =>
      (optional && value === '') || acceptsAttribute(owner, attribute, value) ? undefined : message,
  };
}

/**
 * Mount the rich-text editor for `document` into `element`, synchronously.
 *
 * @public
 */
export function mountRichTextEditor(options: MountRichTextEditorOptions): RichTextEditorHandle {
  editorCount += 1;
  const editorId = options.id ?? `rich-text-editor-${String(editorCount)}`;
  const pickerUrl =
    options.mediaPickerUrl !== undefined && isMediaPickerUrl(options.mediaPickerUrl)
      ? options.mediaPickerUrl
      : undefined;

  const root = document.createElement('div');
  root.className = 'rich-text-editor-ui';
  const surface = document.createElement('div');
  surface.className = 'rich-text-editor-surface';
  const status = document.createElement('p');
  status.className = 'rich-text-editor-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  // The view does not exist yet while the plugins are built; the commands
  // below run only on user input, after the mount assigned it.
  let view: EditorView | undefined;
  const run = (command: Command): boolean =>
    view === undefined ? false : command(view.state, view.dispatch, view);
  const focusEditor = (): void => {
    view?.focus();
  };

  const dialog = createFieldDialog(focusEditor);

  const openLinkDialog = (): void => {
    if (view === undefined || !canLink(view.state)) {
      return;
    }
    const href = activeLinkHref(view.state);
    dialog.open({
      title: href === undefined ? 'Add link' : 'Edit link',
      applyLabel: 'Apply',
      fields: [
        {
          key: 'href',
          label: 'Link',
          value: href ?? '',
          check: (value) => (isLinkHref(value) ? undefined : LINK_CHECK_MESSAGE),
        },
      ],
      onApply: (values) => {
        run(setLinkCommand(values['href'] ?? ''));
      },
      ...(href === undefined
        ? {}
        : {
            actions: [
              {
                label: 'Remove link',
                run: () => {
                  run(removeLinkCommand);
                },
              },
            ],
          }),
    });
  };

  const insertWithDialog = (
    name: AtomName,
    title: string,
    fields: readonly DialogField[],
    attrs: (values: Readonly<Record<string, string>>) => Readonly<Record<string, unknown>>,
    picker?: { readonly field: string; readonly mode: 'replace' | 'append' },
  ): void => {
    dialog.open({
      title,
      applyLabel: 'Insert',
      fields,
      onApply: (values) => {
        run(insertAtomCommand(name, attrs(values)));
      },
      ...(picker === undefined || pickerUrl === undefined
        ? {}
        : { picker: { url: pickerUrl, ...picker } }),
    });
  };

  const lines = (value: string): string[] =>
    value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

  const menuItems: BlockMenuItem[] = [
    {
      label: 'Divider',
      run: () => {
        run(insertAtomCommand('divider'));
        focusEditor();
      },
    },
    {
      label: 'Image…',
      run: () => {
        insertWithDialog(
          'image',
          'Insert image',
          [
            attributeField('image', 'mediaId', 'Media id', 'Enter a media id on one line.'),
            attributeField('image', 'alt', 'Alt text', TEXT_CHECK_MESSAGE, true),
            attributeField('image', 'caption', 'Caption', TEXT_CHECK_MESSAGE, true),
          ],
          (values) => ({
            mediaId: values['mediaId'],
            alt: values['alt'] ?? '',
            caption: values['caption'] ?? '',
          }),
          { field: 'mediaId', mode: 'replace' },
        );
      },
    },
    {
      label: 'Gallery…',
      run: () => {
        insertWithDialog(
          'gallery',
          'Insert gallery',
          [
            {
              key: 'mediaIds',
              label: 'Media ids (one per line)',
              multiline: true,
              check: (value) =>
                acceptsAttribute('gallery', 'mediaIds', lines(value))
                  ? undefined
                  : 'Enter at least one media id, one per line, within the gallery limit.',
            },
            attributeField('gallery', 'alt', 'Alt text', TEXT_CHECK_MESSAGE, true),
          ],
          (values) => ({ mediaIds: lines(values['mediaIds'] ?? ''), alt: values['alt'] ?? '' }),
          { field: 'mediaIds', mode: 'append' },
        );
      },
    },
    {
      label: 'Embed…',
      run: () => {
        insertWithDialog(
          'embed',
          'Insert embed',
          [
            attributeField(
              'embed',
              'url',
              'Embed URL',
              'Enter an https:// URL with a host and no user name.',
            ),
          ],
          (values) => ({ url: values['url'] }),
        );
      },
    },
    {
      label: 'Call to action…',
      run: () => {
        insertWithDialog(
          'cta',
          'Insert call to action',
          [
            attributeField('cta', 'label', 'Button label', TEXT_CHECK_MESSAGE),
            attributeField('cta', 'href', 'Link', LINK_CHECK_MESSAGE),
          ],
          (values) => ({ label: values['label'], href: values['href'] }),
        );
      },
    },
  ];
  const menu = createBlockMenu(menuItems);

  let toolbar: ReturnType<typeof createToolbar> | undefined;
  const uiKeymap = keymap({
    'Mod-k': () => {
      if (view === undefined || !canLink(view.state)) {
        return false;
      }
      openLinkDialog();
      return true;
    },
    'Alt-F10': () => {
      toolbar?.focus();
      return toolbar !== undefined;
    },
    'Mod-Alt-0': setBlockTypeCommand('paragraph'),
    'Mod-Alt-2': setBlockTypeCommand('heading-2'),
    'Mod-Alt-3': setBlockTypeCommand('heading-3'),
    'Mod-Alt-4': setBlockTypeCommand('heading-4'),
    'Mod-Alt-5': setBlockTypeCommand('heading-5'),
    'Mod-Alt-6': setBlockTypeCommand('heading-6'),
    'Mod-Shift-8': toggleListCommand('unordered'),
    'Mod-Shift-7': toggleListCommand('ordered'),
    'Mod-Shift-9': toggleListCommand('task'),
    'Mod-Enter': toggleTaskCommand,
  });
  const onChange = options.onChange;
  const uiView = new Plugin({
    view: () => ({
      update(current, previous) {
        toolbar?.update(current.state);
        if (current.state.doc !== previous.doc) {
          status.textContent = '';
          onChange?.(decode(current.state.doc));
        }
      },
    }),
  });

  const nodeViews: Record<string, NodeViewConstructor> = {
    image: atomView('image', pickerUrl),
    gallery: atomView('gallery', pickerUrl),
    embed: atomView('embed', pickerUrl),
    cta: atomView('cta', pickerUrl),
    callout: textblockView('callout'),
    quote: textblockView('quote'),
    code_block: textblockView('code_block'),
  };

  // A mount that fails part way (a refused document, a browser error while
  // building the UI) leaves nothing behind: a live view would keep observing
  // the page's selection, and the menu its clicks, with no handle to stop them.
  let headless: HeadlessRichTextEditorHandle | undefined;
  try {
    headless = mountHeadlessRichTextEditor({
      element: surface,
      document: options.document,
      plugins: [uiKeymap, richTextTaskCheckboxes(), uiView],
      nodeViews,
      attributes: { id: editorId, 'aria-label': options.label ?? 'Rich text' },
      onBudgetExceeded: () => {
        status.textContent = BUDGET_TEXT;
      },
    });
    view = headless.view;
    adoptEditorStyles(options.element.ownerDocument, EDITOR_UI_CSS);
    toolbar = createToolbar(headless.view, editorId, {
      openLinkDialog,
      insertButton: menu.button,
    });
    toolbar.update(headless.view.state);
    root.append(toolbar.element, menu.menu, dialog.element, surface, status);
    options.element.append(root);
  } catch (error) {
    headless?.destroy();
    menu.destroy();
    root.remove();
    view = undefined;
    throw error;
  }

  // A `<label for>` naming the surface cannot focus a contenteditable by
  // itself, so a click on it does.
  const labels = Array.from(options.element.ownerDocument.querySelectorAll('label')).filter(
    (label) => label.htmlFor === editorId,
  );
  for (const label of labels) {
    label.addEventListener('click', focusEditor);
  }

  let destroyed = false;
  const handle: RichTextEditorHandle = {
    view: headless.view,
    getDocument: () => headless.getDocument(),
    setDocument: (document) => {
      headless.setDocument(document);
      toolbar?.update(headless.view.state);
    },
    focus: focusEditor,
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      for (const label of labels) {
        label.removeEventListener('click', focusEditor);
      }
      menu.destroy();
      headless.destroy();
      root.remove();
    },
  };
  return handle;
}
