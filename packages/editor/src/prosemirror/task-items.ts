/**
 * Checked state belongs to the items of task lists, as in the model, where
 * only a task list's items carry `checked`. Every item node has a `checked`
 * attribute (an item cannot see its root list's style), so
 * {@link richTextTaskItems} clears it, in an appended transaction, on every
 * item of a list that is not a task list and that a transaction touched.
 * Without it, an item would keep a state the document no longer shows: it
 * would come back checked when its list became a task list again, and pasted
 * HTML could plant it in a bulleted list.
 */

import { Plugin, PluginKey } from 'prosemirror-state';

import { changedRanges } from './changed-ranges.js';
import { nodeType } from './schema.js';

/** The key of the {@link richTextTaskItems} plugin. */
export const taskItemsKey: PluginKey = new PluginKey('richTextTaskItems');

/**
 * A plugin that clears `checked` on the items of every list a transaction
 * touched whose style is not `task`, in an appended transaction (so undo
 * takes the change back together with the edit that needed it).
 */
export function richTextTaskItems(): Plugin {
  return new Plugin({
    key: taskItemsKey,
    appendTransaction(transactions, _oldState, state) {
      if (!transactions.some((tr) => tr.docChanged)) {
        return null;
      }
      const list = nodeType('list');
      const checked = new Set<number>();
      for (const [from, to] of changedRanges(transactions)) {
        // Lists sit at the top level only, so no descent is needed to find them.
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type === list && node.attrs.style !== 'task') {
            node.descendants((child, offset) => {
              if (child.attrs.checked === true) {
                checked.add(pos + 1 + offset);
              }
              return !child.isTextblock;
            });
          }
          return false;
        });
      }
      if (checked.size === 0) {
        return null;
      }
      const tr = state.tr;
      for (const pos of checked) {
        tr.setNodeAttribute(pos, 'checked', false);
      }
      return tr;
    },
  });
}
