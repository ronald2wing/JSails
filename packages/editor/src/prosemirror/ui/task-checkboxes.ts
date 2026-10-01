/**
 * Checkboxes for task items. A widget decoration puts a real checkbox at the
 * start of every item of a task list, at any depth; clicking it toggles the
 * item's `checked` through a transaction, so the change is undoable and the
 * decoration is redrawn from the new state. The checkbox is not part of the
 * document and carries no `name`, so it never reaches a form submission.
 *
 * Decorations rather than a node view: one plugin covers the three item
 * types, and an item cannot see its root list's style, which the plugin reads
 * from the document as it walks it.
 */

import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

import { LIST_ITEM_NODES, nodeType } from '../schema.js';

const ITEM_NAMES: ReadonlySet<string> = new Set(LIST_ITEM_NODES);

/** The key of the {@link richTextTaskCheckboxes} plugin. */
export const taskCheckboxesKey: PluginKey = new PluginKey('richTextTaskCheckboxes');

function checkbox(
  view: EditorView,
  getPos: () => number | undefined,
  checked: boolean,
): HTMLElement {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'rich-text-editor-task-checkbox';
  box.checked = checked;
  box.contentEditable = 'false';
  box.setAttribute('aria-label', checked ? 'Done' : 'Not done');
  // A press must not move the caret into the item.
  box.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
  box.addEventListener('click', (event) => {
    event.preventDefault();
    const pos = getPos();
    if (pos === undefined) {
      return;
    }
    // The widget sits at the start of the item's paragraph: item, then paragraph.
    const itemPos = pos - 2;
    const item = view.state.doc.nodeAt(itemPos);
    if (item !== null && ITEM_NAMES.has(item.type.name)) {
      view.dispatch(
        view.state.tr.setNodeAttribute(itemPos, 'checked', item.attrs.checked !== true),
      );
    }
  });
  return box;
}

function decorations(doc: ProseMirrorNode): DecorationSet {
  const list = nodeType('list');
  const widgets: Decoration[] = [];
  doc.forEach((block, offset) => {
    if (block.type !== list || block.attrs.style !== 'task') {
      return;
    }
    block.descendants((node, pos) => {
      if (ITEM_NAMES.has(node.type.name)) {
        const checked = node.attrs.checked === true;
        widgets.push(
          Decoration.widget(
            offset + 1 + pos + 2,
            (view, getPos) => checkbox(view, getPos, checked),
            {
              side: -1,
              ignoreSelection: true,
              stopEvent: () => true,
              key: checked ? 'task-checked' : 'task-open',
            },
          ),
        );
      }
      return !node.isTextblock;
    });
  });
  return DecorationSet.create(doc, widgets);
}

/** The plugin drawing the task checkboxes. */
export function richTextTaskCheckboxes(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: taskCheckboxesKey,
    state: {
      init: (_config, state) => decorations(state.doc),
      apply: (tr, previous) => (tr.docChanged ? decorations(tr.doc) : previous),
    },
    props: {
      decorations(state) {
        return taskCheckboxesKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}
