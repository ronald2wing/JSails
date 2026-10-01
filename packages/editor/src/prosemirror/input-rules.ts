/**
 * Markdown-style input rules at the start of a paragraph: `- `, `* ` or `+ `
 * starts a bulleted list, `1. ` a numbered one, `[ ] ` or `[x] ` a task list
 * (with that first item unchecked or checked), `> ` a quote, `## ` to
 * `###### ` a heading of that level (`# ` is level 2, since level 1 belongs
 * to the page title), and three backticks a code block. A new list joins a
 * list of the same style right before it. Rules never fire inside code.
 */

import type { Node as ProseMirrorNode } from 'prosemirror-model';
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import type { Plugin } from 'prosemirror-state';
import { canJoin, findWrapping } from 'prosemirror-transform';

import { MAX_HEADING_LEVEL, MIN_HEADING_LEVEL, type ListStyle } from 'jsails/rich-text';

import { nodeType } from './schema.js';

function sameStyle(
  style: ListStyle,
): (match: RegExpMatchArray, before: ProseMirrorNode) => boolean {
  return (_match, before) => before.attrs.style === style;
}

/** `[ ] ` or `[x] `: wrap the paragraph in a task list whose first item carries the box's state. */
function taskListRule(): InputRule {
  const list = nodeType('list');
  const item = nodeType('list_item');
  return new InputRule(/^\s*\[([ xX])\]\s$/, (state, match, start, end) => {
    const tr = state.tr.delete(start, end);
    const range = tr.doc.resolve(start).blockRange();
    const wrapping = range && findWrapping(range, list, { style: 'task' });
    if (range === null || wrapping === null) {
      return null;
    }
    const checked = match[1] !== ' ';
    tr.wrap(
      range,
      wrapping.map((wrapper) =>
        wrapper.type === item ? { type: item, attrs: { checked } } : wrapper,
      ),
    );
    const before = tr.doc.resolve(start - 1).nodeBefore;
    if (before?.type === list && before.attrs.style === 'task' && canJoin(tr.doc, start - 1)) {
      tr.join(start - 1);
    }
    return tr;
  });
}

/** The input-rules plugin of the editor. */
export function richTextInputRules(): Plugin {
  const list = nodeType('list');
  return inputRules({
    rules: [
      wrappingInputRule(/^\s*([-+*])\s$/, list, { style: 'unordered' }, sameStyle('unordered')),
      wrappingInputRule(/^(\d+)\.\s$/, list, { style: 'ordered' }, sameStyle('ordered')),
      taskListRule(),
      textblockTypeInputRule(/^>\s$/, nodeType('quote')),
      textblockTypeInputRule(/^```$/, nodeType('code_block')),
      textblockTypeInputRule(/^(#{1,6})\s$/, nodeType('heading'), (match) => ({
        level: Math.min(Math.max((match[1] ?? '').length, MIN_HEADING_LEVEL), MAX_HEADING_LEVEL),
      })),
    ],
  });
}
