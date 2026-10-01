/**
 * Schema validity as an editor invariant: {@link richTextStructureGuard}
 * refuses a transaction that leaves any node it touched with content its
 * type refuses, or with a mark set the schema would not build.
 *
 * ProseMirror validates the nodes a replace rebuilds but trusts the inside of
 * the slice it inserts, and its fitting can assemble a slice that is not
 * valid for a schema like this one, whose list items must start with a
 * paragraph (pasting part of a nested list at the start of a callout yields
 * an item holding only an empty nested list). Such a document cannot be
 * decoded faithfully, so the transaction is refused instead. Only the nodes
 * around each changed range are checked, so the cost follows the edit, not
 * the document.
 */

import { Mark, type Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';

import { changedRanges } from './changed-ranges.js';

function marksValid(node: ProseMirrorNode): boolean {
  let rebuilt = Mark.none;
  for (const mark of node.marks) {
    rebuilt = mark.addToSet(rebuilt);
  }
  return Mark.sameSet(rebuilt, node.marks);
}

/** True when every node overlapping `[from, to]` (and the document) is valid. */
function rangeValid(doc: ProseMirrorNode, from: number, to: number): boolean {
  let valid = doc.type.validContent(doc.content);
  doc.nodesBetween(from, to, (node) => {
    if (valid && !((node.isText || node.type.validContent(node.content)) && marksValid(node))) {
      valid = false;
    }
    return valid;
  });
  return valid;
}

/** The key of the {@link richTextStructureGuard} plugin. */
export const structureGuardKey: PluginKey = new PluginKey('richTextStructureGuard');

/** A plugin that refuses any transaction leaving a node it touched invalid. */
export function richTextStructureGuard(): Plugin {
  return new Plugin({
    key: structureGuardKey,
    filterTransaction(tr) {
      return (
        !tr.docChanged || changedRanges([tr]).every(([from, to]) => rangeValid(tr.doc, from, to))
      );
    },
  });
}
