/**
 * List commands for the schema's per-depth list nodes.
 *
 * `prosemirror-schema-list` assumes one item type nested in one list type, so
 * its sink and lift move an item without changing its type, which this schema
 * refuses (an item one level deeper is a different node type). Splitting
 * keeps types, so {@link splitRichTextListItem} is the library's command over
 * the three item types; {@link sinkRichTextListItem} and
 * {@link liftRichTextListItem} rebuild the moved items at their new depth.
 *
 * Sink and lift act on the item holding the selection, when the selection
 * lies in that item's own paragraph. Sinking nests the item (with its
 * children) at the end of the previous sibling's children and is refused
 * when it would pass the third level; lifting moves it after its parent
 * item, taking the following siblings as its children, and lifting a root
 * item turns it into a paragraph between the two halves of its list.
 */

import { Fragment, type Node as ProseMirrorNode, type NodeType } from 'prosemirror-model';
import { TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { splitListItem } from 'prosemirror-schema-list';

import { LIST_ITEM_NODES, LIST_NODES, nodeType } from './schema.js';

type Depth = 0 | 1 | 2;

const ITEM_TYPES: readonly NodeType[] = LIST_ITEM_NODES.map(nodeType);
const NESTED_LIST_TYPES: readonly NodeType[] = LIST_NODES.map(nodeType);

/**
 * Split the list item at the selection (Enter): the new item is unchecked;
 * an empty nested item moves out one level instead.
 */
export const splitRichTextListItem: Command = splitListItem([...ITEM_TYPES], { checked: false });

interface ItemContext {
  readonly depth: Depth;
  readonly item: ProseMirrorNode;
  /** Position before the item. */
  readonly itemPos: number;
  readonly list: ProseMirrorNode;
  /** Position before the list holding the item. */
  readonly listPos: number;
  readonly index: number;
}

/** The list item whose paragraph holds the whole selection. */
function itemAt(state: EditorState): ItemContext | undefined {
  const { $from, $to } = state.selection;
  if ($from.depth < 3 || !$from.sameParent($to) || $from.index(-1) !== 0) {
    return undefined;
  }
  const depth = ITEM_TYPES.indexOf($from.node(-1).type);
  if (depth < 0) {
    return undefined;
  }
  return {
    depth: depth as Depth,
    item: $from.node(-1),
    itemPos: $from.before(-1),
    list: $from.node(-2),
    listPos: $from.before(-2),
    index: $from.index(-2),
  };
}

/** Levels of items in `item`'s subtree, itself included. */
function height(item: ProseMirrorNode): number {
  const nested = item.childCount > 1 ? item.lastChild : null;
  if (nested === null) {
    return 1;
  }
  let deepest = 0;
  nested.forEach((child) => {
    deepest = Math.max(deepest, height(child));
  });
  return 1 + deepest;
}

function children(item: ProseMirrorNode): ProseMirrorNode[] {
  const nested = item.childCount > 1 ? item.lastChild : null;
  const out: ProseMirrorNode[] = [];
  nested?.forEach((child) => out.push(child));
  return out;
}

/** An item of `depth` holding `paragraph` and, when there are any, `items` as children. */
function buildItem(
  depth: Depth,
  attrs: ProseMirrorNode['attrs'],
  paragraph: ProseMirrorNode,
  items: readonly ProseMirrorNode[],
): ProseMirrorNode {
  const content = [paragraph];
  if (items.length > 0) {
    content.push((NESTED_LIST_TYPES[depth + 1] as NodeType).createChecked(null, items));
  }
  return (ITEM_TYPES[depth] as NodeType).createChecked(attrs, content);
}

/** `item` and its subtree rebuilt at `depth` (the caller checked the height fits). */
function retype(item: ProseMirrorNode, depth: Depth): ProseMirrorNode {
  const next = (depth + 1) as Depth;
  return buildItem(
    depth,
    item.attrs,
    item.firstChild as ProseMirrorNode,
    children(item).map((child) => retype(child, next)),
  );
}

function slice(list: ProseMirrorNode, from: number, to: number): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = [];
  for (let index = from; index < to; index += 1) {
    out.push(list.child(index));
  }
  return out;
}

/** Replace `[from, to)` with `nodes`, keeping the selection at the same place inside the moved item. */
function replaceKeepingSelection(
  state: EditorState,
  from: number,
  to: number,
  nodes: readonly ProseMirrorNode[],
  delta: number,
): Transaction {
  const { $from, $to } = state.selection;
  const tr = state.tr.replaceWith(from, to, Fragment.from([...nodes]));
  tr.setSelection(TextSelection.create(tr.doc, $from.pos + delta, $to.pos + delta));
  return tr.scrollIntoView();
}

/**
 * Nest the list item at the selection under its previous sibling (one level
 * deeper), with its children. Refused for a first item and when the item's
 * subtree would pass the third level.
 */
export const sinkRichTextListItem: Command = (state, dispatch) => {
  const at = itemAt(state);
  if (at === undefined || at.index === 0 || at.depth + height(at.item) >= LIST_NODES.length) {
    return false;
  }
  if (dispatch !== undefined) {
    const next = (at.depth + 1) as Depth;
    const previous = at.list.child(at.index - 1);
    const kept = children(previous);
    const merged = buildItem(at.depth, previous.attrs, previous.firstChild as ProseMirrorNode, [
      ...kept,
      retype(at.item, next),
    ]);
    const previousPos = at.itemPos - previous.nodeSize;
    // In the merged item, the moved item follows the paragraph and the kept children.
    let movedPos = previousPos + 2 + (previous.firstChild as ProseMirrorNode).nodeSize;
    for (const child of kept) {
      movedPos += child.nodeSize;
    }
    dispatch(
      replaceKeepingSelection(
        state,
        previousPos,
        at.itemPos + at.item.nodeSize,
        [merged],
        movedPos - at.itemPos,
      ),
    );
  }
  return true;
};

/**
 * Move the list item at the selection out one level: after its parent item,
 * with the following siblings as its children. A root item becomes a
 * paragraph, splitting its list.
 */
export const liftRichTextListItem: Command = (state, dispatch) => {
  const at = itemAt(state);
  if (at === undefined) {
    return false;
  }
  if (dispatch === undefined) {
    return true;
  }
  const paragraph = at.item.firstChild as ProseMirrorNode;
  const following = slice(at.list, at.index + 1, at.list.childCount);
  if (at.depth === 0) {
    const before = slice(at.list, 0, at.index);
    const after = [...children(at.item).map((child) => retype(child, 0)), ...following];
    const nodes: ProseMirrorNode[] = [];
    if (before.length > 0) {
      nodes.push(at.list.type.createChecked(at.list.attrs, before));
    }
    const paragraphPos = at.listPos + (nodes[0]?.nodeSize ?? 0);
    nodes.push(paragraph);
    if (after.length > 0) {
      nodes.push(at.list.type.createChecked(at.list.attrs, after));
    }
    dispatch(
      replaceKeepingSelection(
        state,
        at.listPos,
        at.listPos + at.list.nodeSize,
        nodes,
        paragraphPos - (at.itemPos + 1),
      ),
    );
    return true;
  }
  const outer = (at.depth - 1) as Depth;
  const parent = state.selection.$from.node(-3);
  const parentPos = state.selection.$from.before(-3);
  const lifted = buildItem(outer, at.item.attrs, paragraph, [
    ...children(at.item).map((child) => retype(child, at.depth)),
    ...following,
  ]);
  const keptParent = buildItem(
    outer,
    parent.attrs,
    parent.firstChild as ProseMirrorNode,
    slice(at.list, 0, at.index),
  );
  dispatch(
    replaceKeepingSelection(
      state,
      parentPos,
      parentPos + parent.nodeSize,
      [keptParent, lifted],
      parentPos + keptParent.nodeSize - at.itemPos,
    ),
  );
  return true;
};
