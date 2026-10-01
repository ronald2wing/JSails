/**
 * The ranges of a document that a run of transactions changed, in the
 * coordinates of the last transaction's document: what the text rules, the
 * task-item rule and the structure guard re-examine instead of the whole
 * document.
 */

import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';

/**
 * The range where `before` and `after` differ, in `after`'s coordinates, or
 * null when they are equal.
 */
function differingRange(before: ProseMirrorNode, after: ProseMirrorNode): [number, number] | null {
  const start = before.content.findDiffStart(after.content);
  if (start === null) {
    return null;
  }
  const end = before.content.findDiffEnd(after.content)?.b ?? start;
  return [start, Math.max(start, end)];
}

/**
 * Every range `transactions` changed, mapped to the final document. A replace
 * step yields the ranges its step map records; a deletion yields an empty
 * range at the join, which still names the nodes around it. A step that
 * changes marks or attributes replaces nothing, so its step map is empty; it
 * yields the range where the documents before and after it differ.
 */
export function changedRanges(transactions: readonly Transaction[]): [number, number][] {
  let ranges: [number, number][] = [];
  for (const tr of transactions) {
    ranges = ranges.map(([from, to]) => [tr.mapping.map(from, -1), tr.mapping.map(to, 1)]);
    tr.steps.forEach((step, index) => {
      const rest = tr.mapping.slice(index + 1);
      let replaced = false;
      step.getMap().forEach((_oldStart, _oldEnd, start, end) => {
        replaced = true;
        ranges.push([rest.map(start, -1), rest.map(end, 1)]);
      });
      if (replaced) {
        return;
      }
      const before = tr.docs[index] as ProseMirrorNode;
      const changed = differingRange(before, tr.docs[index + 1] ?? tr.doc);
      if (changed !== null) {
        ranges.push([rest.map(changed[0], -1), rest.map(changed[1], 1)]);
      }
    });
  }
  return ranges;
}
