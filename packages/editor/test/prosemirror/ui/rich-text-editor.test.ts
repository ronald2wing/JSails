/**
 * The editor with its UI in a DOM: the toolbar's ARIA and roving focus, mark
 * and list buttons, the link dialog (refused and accepted hrefs, Enter not
 * submitting the page's form), the insert menu's keyboard contract and its
 * dialogs, the node views' checked attribute controls and Remove button, the
 * task checkboxes, the budget status line, the label hook, `onChange`, and
 * teardown, including after a mount that fails part way.
 */

import { assertNode, attachedElement, closeEditorDom, editorWindow } from '../editor-dom.js';

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { MAX_BLOCK_CHARS, type RichTextDocument } from 'jsails/rich-text';

import { mountRichTextEditor } from '../../../src/index.js';
import { RichTextEditorErrors } from '../../../src/prosemirror/editor-errors.js';

after(closeEditorDom);

function press(target: Element, key: string, modifiers: { ctrlKey?: boolean } = {}): boolean {
  const event = new editorWindow.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  target.dispatchEvent(event as unknown as Event);
  return event.defaultPrevented;
}

function click(target: Element): void {
  (target as HTMLElement).click();
}

function select(view: EditorView, from: number, to = from): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

function button(root: Element, label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  assert.ok(found !== undefined, `a button labelled ${label}`);
  return found;
}

function setValue(control: Element, value: string): void {
  (control as HTMLInputElement).value = value;
}

const PARAGRAPH: RichTextDocument = {
  version: 2,
  blocks: [{ type: 'paragraph', content: [{ text: 'hello world' }] }],
};

describe('mountRichTextEditor (with its UI)', () => {
  it('builds a labelled surface and a toolbar that controls it, with one tab stop', () => {
    const element = attachedElement();
    const editor = mountRichTextEditor({ element, document: PARAGRAPH, label: 'Body', id: 'body' });
    const toolbar = element.querySelector('[role="toolbar"]');
    assert.ok(toolbar !== null);
    assert.equal(toolbar.getAttribute('aria-controls'), 'body');
    assert.equal(toolbar.getAttribute('aria-label'), 'Formatting');
    const surface = element.querySelector('[role="textbox"]');
    assert.equal(surface?.id, 'body');
    assert.equal(surface?.getAttribute('aria-label'), 'Body');
    assert.equal(surface?.getAttribute('aria-multiline'), 'true');
    const controls = Array.from(toolbar.querySelectorAll('select, button'));
    assert.deepEqual(
      controls.map((control) => (control as HTMLElement).tabIndex),
      controls.map((_, index) => (index === 0 ? 0 : -1)),
    );
    (controls[0] as HTMLElement).focus();
    assert.ok(press(toolbar, 'ArrowRight'));
    assertNode(editorWindow.document.activeElement, controls[1]);
    assert.equal((controls[1] as HTMLElement).tabIndex, 0);
    assert.ok(press(toolbar, 'End'));
    assertNode(editorWindow.document.activeElement, controls.at(-1));
    assert.ok(press(toolbar, 'ArrowRight'));
    assertNode(editorWindow.document.activeElement, controls[0]);
    editor.destroy();
  });

  it('toggles bold from the toolbar and reflects it in aria-pressed', () => {
    const element = attachedElement();
    const editor = mountRichTextEditor({ element, document: PARAGRAPH });
    select(editor.view, 1, 6);
    const bold = button(element, 'Bold');
    assert.equal(bold.getAttribute('aria-pressed'), 'false');
    assert.match(bold.title, /^Bold \((Ctrl|Cmd)\+B\)$/);
    click(bold);
    assert.deepEqual(editor.getDocument().blocks, [
      { type: 'paragraph', content: [{ text: 'hello', marks: ['bold'] }, { text: ' world' }] },
    ]);
    assert.equal(bold.getAttribute('aria-pressed'), 'true');
    editor.destroy();
  });

  it('makes a task list from the toolbar and toggles an item with its checkbox', () => {
    const element = attachedElement();
    const editor = mountRichTextEditor({ element, document: PARAGRAPH });
    select(editor.view, 2);
    const tasks = button(element, 'Task list');
    click(tasks);
    assert.equal(tasks.getAttribute('aria-pressed'), 'true');
    const box = element.querySelector('input.rich-text-editor-task-checkbox');
    assert.ok(box !== null);
    assert.equal(box.getAttribute('aria-label'), 'Not done');
    click(box);
    assert.deepEqual(editor.getDocument().blocks, [
      {
        type: 'list',
        style: 'task',
        items: [{ content: [{ text: 'hello world' }], checked: true }],
      },
    ]);
    const redrawn = element.querySelector('input.rich-text-editor-task-checkbox');
    assert.equal((redrawn as HTMLInputElement | null)?.checked, true);
    assert.ok(press(editor.view.dom, 'Enter', { ctrlKey: true }));
    assert.deepEqual(editor.getDocument().blocks, [
      {
        type: 'list',
        style: 'task',
        items: [{ content: [{ text: 'hello world' }], checked: false }],
      },
    ]);
    editor.destroy();
  });

  it('opens the link dialog with Mod-k, refuses a javascript: href and applies a path', () => {
    const element = attachedElement();
    const form = editorWindow.document.createElement('form');
    element.append(form as unknown as Node);
    const editor = mountRichTextEditor({
      element: form as unknown as HTMLElement,
      document: PARAGRAPH,
    });
    let submitted = false;
    form.addEventListener('submit', () => {
      submitted = true;
    });
    select(editor.view, 7, 12);
    assert.ok(press(editor.view.dom, 'k', { ctrlKey: true }));
    const dialog = (form as unknown as HTMLElement).querySelector('[role="dialog"]');
    assert.ok(dialog !== null && !(dialog as HTMLElement).hidden);
    assert.equal(dialog.getAttribute('aria-modal'), 'false');
    const input = dialog.querySelector('input');
    assert.ok(input !== null);
    assertNode(editorWindow.document.activeElement, input);
    assert.equal(input.getAttribute('name'), null, 'dialog fields are never submitted');
    setValue(input, 'javascript:alert(1)');
    click(button(dialog, 'Apply'));
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    const error = dialog.querySelector(`#${input.getAttribute('aria-describedby') ?? ''}`);
    assert.match(error?.textContent ?? '', /path/);
    assert.deepEqual(editor.getDocument(), PARAGRAPH);
    setValue(input, '/world');
    assert.ok(press(input, 'Enter'));
    assert.equal(submitted, false, 'Enter in the dialog does not submit the page form');
    assert.equal((dialog as HTMLElement).hidden, true);
    assert.deepEqual(editor.getDocument().blocks, [
      { type: 'paragraph', content: [{ text: 'hello ' }, { text: 'world', href: '/world' }] },
    ]);
    // Reopened inside the link: Remove link takes it off.
    select(editor.view, 9);
    click(button(form as unknown as Element, 'Link'));
    assert.equal(dialog.querySelector('input')?.value, '/world');
    click(button(dialog, 'Remove link'));
    assert.deepEqual(editor.getDocument(), PARAGRAPH);
    editor.destroy();
  });

  it('applies on Enter in its own field inside an app role="group", but not from the picker search', () => {
    const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const requests: string[] = [];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (url: string) => {
        requests.push(url);
        return { ok: true, json: async () => ({ assets: [], total: 0 }) };
      },
    });
    try {
      const form = editorWindow.document.createElement('form');
      attachedElement().append(form as unknown as Node);
      // An app grouping its fields accessibly puts the editor under its own group.
      const group = editorWindow.document.createElement('div');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Content');
      form.append(group);
      const editor = mountRichTextEditor({
        element: group as unknown as HTMLElement,
        document: PARAGRAPH,
        mediaPickerUrl: '/admin/media',
      });
      select(editor.view, 7, 12);
      assert.ok(press(editor.view.dom, 'k', { ctrlKey: true }));
      const dialog = (group as unknown as HTMLElement).querySelector(
        '[role="dialog"]',
      ) as HTMLElement;
      const href = dialog.querySelector('input') as HTMLInputElement;
      setValue(href, '/pricing');
      assert.ok(press(href, 'Enter'), 'Enter is taken from the app form');
      assert.equal(dialog.hidden, true);
      assert.deepEqual(editor.getDocument().blocks, [
        { type: 'paragraph', content: [{ text: 'hello ' }, { text: 'world', href: '/pricing' }] },
      ]);

      click(button(group as unknown as Element, 'Insert'));
      click(button(group as unknown as Element, 'Image…'));
      assert.equal(dialog.hidden, false);
      const search = dialog.querySelector('input[type="search"]') as HTMLInputElement;
      const mediaId = dialog.querySelector('input[type="text"]') as HTMLInputElement;
      search.value = 'logo';
      assert.ok(press(search, 'Enter'), 'the picker search takes its own Enter');
      assert.deepEqual(requests, ['/admin/media?limit=50&q=logo']);
      assert.equal(dialog.hidden, false, 'searching does not apply the dialog');
      assert.equal(mediaId.getAttribute('aria-invalid'), null);
      editor.destroy();
    } finally {
      if (previousFetch === undefined) {
        Reflect.deleteProperty(globalThis, 'fetch');
      } else {
        Object.defineProperty(globalThis, 'fetch', previousFetch);
      }
    }
  });

  it('closes the dialog with Escape without applying', () => {
    const element = attachedElement();
    const editor = mountRichTextEditor({ element, document: PARAGRAPH });
    select(editor.view, 1, 6);
    click(button(element, 'Link'));
    const dialog = element.querySelector('[role="dialog"]') as HTMLElement;
    setValue(dialog.querySelector('input') as Element, '/x');
    assert.ok(press(dialog.querySelector('input') as Element, 'Escape'));
    assert.equal(dialog.hidden, true);
    assert.deepEqual(editor.getDocument(), PARAGRAPH);
    editor.destroy();
  });

  it('runs the insert menu by keyboard and inserts an embed through its dialog', () => {
    const element = attachedElement();
    const editor = mountRichTextEditor({ element, document: PARAGRAPH });
    select(editor.view, 12);
    const insert = button(element, 'Insert');
    assert.equal(insert.getAttribute('aria-haspopup'), 'menu');
    const menu = element.querySelector('[role="menu"]') as HTMLElement;
    assert.equal(insert.getAttribute('aria-controls'), menu.id);
    assert.ok(press(insert, 'ArrowDown'));
    assert.equal(insert.getAttribute('aria-expanded'), 'true');
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    assert.deepEqual(
      items.map((item) => item.textContent),
      ['Divider', 'Image…', 'Gallery…', 'Embed…', 'Call to action…'],
    );
    assertNode(editorWindow.document.activeElement, items[0]);
    assert.ok(press(items[0] as Element, 'ArrowUp'));
    assertNode(editorWindow.document.activeElement, items.at(-1));
    assert.ok(press(items.at(-1) as Element, 'Escape'));
    assert.equal(menu.hidden, true);
    assertNode(editorWindow.document.activeElement, insert);

    click(insert);
    click(items[3] as Element);
    assert.equal(menu.hidden, true);
    const dialog = element.querySelector('[role="dialog"]') as HTMLElement;
    const url = dialog.querySelector('input') as HTMLInputElement;
    setValue(url, 'http://insecure.example/v');
    click(button(dialog, 'Insert'));
    assert.equal(url.getAttribute('aria-invalid'), 'true');
    setValue(url, 'https://video.example/v');
    click(button(dialog, 'Insert'));
    assert.deepEqual(editor.getDocument().blocks, [
      PARAGRAPH.blocks[0],
      { type: 'embed', url: 'https://video.example/v' },
      { type: 'paragraph', content: [] },
    ]);
    const figure = element.querySelector('figure[data-rich-text="embed"]');
    assert.ok(figure !== null);
    assert.equal(figure.getAttribute('contenteditable'), 'false');
    editor.destroy();
  });

  it('checks node view values with the model before writing them, and removes the block', () => {
    const element = attachedElement();
    const document: RichTextDocument = {
      version: 2,
      blocks: [
        { type: 'image', mediaId: 'm1', alt: 'A <b> tag' },
        { type: 'callout', tone: 'info', content: [{ text: 'note' }] },
      ],
    };
    const editor = mountRichTextEditor({ element, document });
    const figure = element.querySelector('figure[data-rich-text="image"]') as HTMLElement;
    const [mediaId, alt] = Array.from(figure.querySelectorAll('input'));
    assert.equal(alt?.value, 'A <b> tag');
    setValue(mediaId as Element, '');
    mediaId?.dispatchEvent(new editorWindow.Event('change') as unknown as Event);
    assert.equal(mediaId?.getAttribute('aria-invalid'), 'true');
    assert.deepEqual(editor.getDocument(), document);
    setValue(mediaId, 'm2');
    assert.ok(press(mediaId, 'Enter'));
    assert.deepEqual(editor.getDocument().blocks[0], {
      type: 'image',
      mediaId: 'm2',
      alt: 'A <b> tag',
    });

    const tone = element.querySelector('aside select') as HTMLSelectElement;
    tone.value = 'warning';
    tone.dispatchEvent(new editorWindow.Event('change') as unknown as Event);
    assert.deepEqual(editor.getDocument().blocks[1], {
      type: 'callout',
      tone: 'warning',
      content: [{ text: 'note' }],
    });
    assert.equal(element.querySelector('aside')?.getAttribute('data-tone'), 'warning');

    click(button(figure, 'Remove image'));
    assert.deepEqual(editor.getDocument().blocks, [
      { type: 'callout', tone: 'warning', content: [{ text: 'note' }] },
    ]);
    editor.destroy();
  });

  it('says when an edit is refused for the budget, and reports changes', () => {
    const element = attachedElement();
    const changes: RichTextDocument[] = [];
    const editor = mountRichTextEditor({
      element,
      document: {
        version: 2,
        blocks: [{ type: 'paragraph', content: [{ text: 'x'.repeat(MAX_BLOCK_CHARS) }] }],
      },
      onChange: (document) => changes.push(document),
    });
    const status = element.querySelector('[role="status"]');
    assert.equal(status?.getAttribute('aria-live'), 'polite');
    const { view } = editor;
    select(view, 2);
    view.dispatch(view.state.tr.insertText('y'));
    assert.match(status?.textContent ?? '', /size limit/);
    assert.equal(changes.length, 0);
    select(view, 1, 3);
    view.dispatch(view.state.tr.deleteSelection());
    assert.equal(status?.textContent, '');
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0], editor.getDocument());
    editor.destroy();
  });

  it('focuses the surface from a label naming it, and removes everything on destroy', () => {
    const element = attachedElement();
    const label = editorWindow.document.createElement('label');
    label.htmlFor = 'story';
    label.textContent = 'Story';
    element.append(label as unknown as Node);
    const editor = mountRichTextEditor({ element, document: PARAGRAPH, id: 'story' });
    (label as unknown as HTMLElement).click();
    assertNode(editorWindow.document.activeElement, editor.view.dom);
    editor.destroy();
    editor.destroy();
    assertNode(element.querySelector('.rich-text-editor-ui'), null);
    assertNode(element.querySelector('label'), label);
  });

  it('leaves no listener and no view behind when the mount fails part way', () => {
    // Every listener the document holds by the end, counted as added minus removed.
    const doc = editorWindow.document;
    const add = doc.addEventListener;
    const remove = doc.removeEventListener;
    const live = new Map<string, number>();
    doc.addEventListener = function (this: Document, ...args: Parameters<typeof add>) {
      live.set(args[0], (live.get(args[0]) ?? 0) + 1);
      Reflect.apply(add, this, args);
    };
    doc.removeEventListener = function (this: Document, ...args: Parameters<typeof remove>) {
      live.set(args[0], (live.get(args[0]) ?? 0) - 1);
      Reflect.apply(remove, this, args);
    };
    try {
      // A browser error while placing the built editor in its element.
      const element = attachedElement();
      element.append = () => {
        throw new Error('append failed');
      };
      assert.throws(() => mountRichTextEditor({ element, document: PARAGRAPH }), /append failed/);
      assert.equal(element.children.length, 0);
      // A document the model refuses, after the insert menu was built.
      assert.throws(
        () =>
          mountRichTextEditor({
            element: attachedElement(),
            document: { version: 1, blocks: [] } as unknown as RichTextDocument,
          }),
        (error: unknown) => RichTextEditorErrors.is(error, 'invalid_document'),
      );
      assert.ok(live.size > 0, 'the mounts added document listeners');
      assert.deepEqual(
        [...live].filter(([, count]) => count !== 0),
        [],
        'every document listener was removed',
      );
    } finally {
      doc.addEventListener = add;
      doc.removeEventListener = remove;
    }
  });
});
