/**
 * The size budget as an editor invariant: {@link richTextLimits} refuses every
 * transaction that would leave the document over `measureRichText`'s budget,
 * so an over-budget state is unreachable rather than unsaveable. Typing,
 * pasting, undo and appended transactions all pass the same filter.
 *
 * The measure is the model's own, taken on the decoded document. Decoding
 * reuses every block a transaction left untouched (`codec.ts` caches by node
 * identity) and each document's measure is cached, so a keystroke costs one
 * JSON serialisation of the document and the decoding of the blocks it
 * changed.
 */

import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';

import {
  MAX_BLOCK_CHARS,
  MAX_BLOCKS,
  MAX_DOCUMENT_BYTES,
  MAX_LIST_ITEMS,
  measureRichText,
  type RichTextMeasure,
} from 'jsails/rich-text';

import { decodeUnchecked } from './codec.js';

const measures = new WeakMap<ProseMirrorNode, RichTextMeasure>();

/** The model's measure of an editor document, cached per document node. */
export function measureEditorDocument(doc: ProseMirrorNode): RichTextMeasure {
  const cached = measures.get(doc);
  if (cached !== undefined) {
    return cached;
  }
  const measure = measureRichText(decodeUnchecked(doc));
  measures.set(doc, measure);
  return measure;
}

/** True when `after` exceeds a limit and is larger than `before` in some exceeded quantity. */
function grewPastBudget(before: RichTextMeasure, after: RichTextMeasure): boolean {
  const over = (value: number, limit: number, previous: number): boolean =>
    value > Math.max(previous, limit);
  return (
    over(after.bytes, MAX_DOCUMENT_BYTES, before.bytes) ||
    over(after.blocks, MAX_BLOCKS, before.blocks) ||
    over(after.maxBlockChars, MAX_BLOCK_CHARS, before.maxBlockChars) ||
    over(after.maxListItems, MAX_LIST_ITEMS, before.maxListItems)
  );
}

/**
 * Options for {@link richTextLimits}.
 */
export interface RichTextLimitsOptions {
  /** Called with the refused document's measure each time a transaction is refused. */
  readonly onRefuse?: (measure: RichTextMeasure) => void;
}

/** The key of the {@link richTextLimits} plugin. */
export const limitsKey: PluginKey = new PluginKey('richTextLimits');

/**
 * A plugin that refuses any transaction taking the document past the budget.
 * A state that starts over budget (only reachable by building one by hand;
 * the mount refuses such a document) still accepts every transaction that
 * grows no exceeded quantity, so the author can always delete their way back.
 */
export function richTextLimits(options: RichTextLimitsOptions = {}): Plugin {
  return new Plugin({
    key: limitsKey,
    filterTransaction(tr, state) {
      if (!tr.docChanged) {
        return true;
      }
      const after = measureEditorDocument(tr.doc);
      if (after.withinBudget || !grewPastBudget(measureEditorDocument(state.doc), after)) {
        return true;
      }
      options.onRefuse?.(after);
      return false;
    },
  });
}
