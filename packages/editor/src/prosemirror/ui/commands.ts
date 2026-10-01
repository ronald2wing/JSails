/**
 * The editing commands the toolbar, the insert menu, the dialogs and the
 * keymap run, and the state queries that tell them what is active and what
 * applies. Every command is a ProseMirror `Command`: called without
 * `dispatch` it only answers whether it applies, so the toolbar enables
 * exactly the controls whose command would change the document.
 *
 * - Block types (paragraph, heading 2 to 6, quote, callout, code) are
 *   textblock conversions; inside a list item, whose content must start with
 *   a paragraph, none applies.
 * - Lists: a list command wraps the selected paragraphs in a list of its
 *   style, changes the style of the list around the selection (nested items
 *   follow the root list's style), or, for the list's own style, moves the
 *   item out until it is a paragraph again.
 * - Links: every href is checked with `isLinkHref` before it reaches a mark,
 *   whose attribute validation would otherwise refuse it by throwing.
 * - Atoms (divider, image, gallery, embed, cta) are top-level blocks: one is
 *   inserted after the block holding the selection (in place of an empty
 *   paragraph), followed by an empty paragraph when nothing editable
 *   follows, so the author can always keep typing after it.
 */

import { setBlockType, toggleMark } from 'prosemirror-commands';
import type { Mark, MarkType, Node as ProseMirrorNode, NodeType } from 'prosemirror-model';
import { wrapInList } from 'prosemirror-schema-list';
import {
  EditorState,
  Selection,
  TextSelection,
  type Command,
  type Transaction,
} from 'prosemirror-state';

import { MAX_LIST_DEPTH, isLinkHref, type InlineMark, type ListStyle } from 'jsails/rich-text';

import { liftRichTextListItem, sinkRichTextListItem } from '../list-commands.js';
import { LIST_ITEM_NODES, nodeType, richTextEditorSchema } from '../schema.js';

/** The block types the block-type control offers, by value. */
export type BlockTypeValue =
  | 'paragraph'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'
  | 'quote'
  | 'callout'
  | 'code';

/** The block-type values in the order the control lists them, with their labels. */
export const BLOCK_TYPES: readonly { readonly value: BlockTypeValue; readonly label: string }[] =
  Object.freeze([
    { value: 'paragraph', label: 'Paragraph' },
    { value: 'heading-2', label: 'Heading 2' },
    { value: 'heading-3', label: 'Heading 3' },
    { value: 'heading-4', label: 'Heading 4' },
    { value: 'heading-5', label: 'Heading 5' },
    { value: 'heading-6', label: 'Heading 6' },
    { value: 'quote', label: 'Quote' },
    { value: 'callout', label: 'Callout' },
    { value: 'code', label: 'Code block' },
  ]);

function blockTarget(value: BlockTypeValue): {
  readonly type: NodeType;
  readonly attrs: Readonly<Record<string, unknown>>;
} {
  if (value.startsWith('heading-')) {
    return { type: nodeType('heading'), attrs: { level: Number(value.slice('heading-'.length)) } };
  }
  switch (value) {
    case 'quote':
      return { type: nodeType('quote'), attrs: {} };
    case 'callout':
      return { type: nodeType('callout'), attrs: {} };
    case 'code':
      return { type: nodeType('code_block'), attrs: {} };
    default:
      return { type: nodeType('paragraph'), attrs: {} };
  }
}

/** Turn the selected textblocks into `value`. */
export function setBlockTypeCommand(value: BlockTypeValue): Command {
  const { type, attrs } = blockTarget(value);
  return setBlockType(type, attrs);
}

/**
 * The block type of the textblock holding the selection, or `undefined` when
 * the selection spans blocks of different types or sits in no textblock the
 * control offers (a list item's paragraph counts as a paragraph).
 */
export function activeBlockType(state: EditorState): BlockTypeValue | undefined {
  const { $from, $to } = state.selection;
  const kind = (node: ProseMirrorNode): BlockTypeValue | undefined => {
    switch (node.type.name) {
      case 'paragraph':
        return 'paragraph';
      case 'heading':
        return `heading-${String(node.attrs.level)}` as BlockTypeValue;
      case 'quote':
        return 'quote';
      case 'callout':
        return 'callout';
      case 'code_block':
        return 'code';
      default:
        return undefined;
    }
  };
  const from = kind($from.parent);
  return from !== undefined && from === kind($to.parent) ? from : undefined;
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

function markType(mark: InlineMark): MarkType {
  return richTextEditorSchema.marks[mark];
}

/** Toggle `mark` on the selection (or the stored marks at an empty selection). */
export function toggleMarkCommand(mark: InlineMark): Command {
  return toggleMark(markType(mark));
}

/** True when `type` is active: on the whole selection, or in the marks typing would use. */
export function isMarkActive(state: EditorState, type: MarkType): boolean {
  const { from, to, empty, $from } = state.selection;
  if (empty) {
    return type.isInSet(state.storedMarks ?? $from.marks()) !== undefined;
  }
  let all = true;
  let any = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      any = true;
      all &&= type.isInSet(node.marks) !== undefined;
    }
  });
  return any && all;
}

/** True when `mark` is active at the selection. */
export function isInlineMarkActive(state: EditorState, mark: InlineMark): boolean {
  return isMarkActive(state, markType(mark));
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const linkType = (): MarkType => richTextEditorSchema.marks.link;

/** The extent of the link around an empty selection: the run of text sharing its link mark. */
function linkRangeAt(state: EditorState): { from: number; to: number; mark: Mark } | undefined {
  const { $from } = state.selection;
  const parent = $from.parent;
  const start = $from.start();
  const index = $from.index();
  const before = $from.textOffset === 0 && index > 0 ? index - 1 : index;
  const at = parent.maybeChild(before);
  const mark = at === null ? undefined : linkType().isInSet(at.marks);
  if (mark === undefined) {
    return undefined;
  }
  let first = before;
  while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) {
    first -= 1;
  }
  let last = before;
  while (last + 1 < parent.childCount && mark.isInSet(parent.child(last + 1).marks)) {
    last += 1;
  }
  let from = start;
  for (let child = 0; child < first; child += 1) {
    from += parent.child(child).nodeSize;
  }
  let to = from;
  for (let child = first; child <= last; child += 1) {
    to += parent.child(child).nodeSize;
  }
  return { from, to, mark };
}

/** The href of the link at the selection, if any (for the link dialog's initial value). */
export function activeLinkHref(state: EditorState): string | undefined {
  const { empty, from, to } = state.selection;
  if (empty) {
    const range = linkRangeAt(state);
    return range === undefined ? undefined : String(range.mark.attrs.href);
  }
  let href: string | undefined;
  state.doc.nodesBetween(from, to, (node) => {
    const mark = node.isText ? linkType().isInSet(node.marks) : undefined;
    if (href === undefined && mark !== undefined) {
      href = String(mark.attrs.href);
    }
  });
  return href;
}

/** True when the selection is in text a link mark may cover (not in a code block or heading-only atom). */
function linkAllowed(state: EditorState): boolean {
  const { $from, $to } = state.selection;
  return (
    $from.parent.inlineContent &&
    $to.parent.inlineContent &&
    $from.parent.type.allowsMarkType(linkType()) &&
    $to.parent.type.allowsMarkType(linkType())
  );
}

/**
 * Link the selection to `href` (which must pass `isLinkHref`): a selected
 * range gets the link, an empty selection inside a link changes that link's
 * target, and an empty selection elsewhere inserts `href` as linked text.
 */
export function setLinkCommand(href: string): Command {
  return (state, dispatch) => {
    if (!isLinkHref(href) || !linkAllowed(state)) {
      return false;
    }
    if (dispatch !== undefined) {
      const mark = linkType().create({ href });
      const { empty, from, to } = state.selection;
      const tr = state.tr;
      if (!empty) {
        tr.removeMark(from, to, linkType()).addMark(from, to, mark);
      } else {
        const range = linkRangeAt(state);
        if (range !== undefined) {
          tr.removeMark(range.from, range.to, linkType()).addMark(range.from, range.to, mark);
        } else {
          tr.insertText(href, from, to).addMark(from, from + href.length, mark);
        }
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Remove the link from the selection, or the whole link around an empty selection. */
export const removeLinkCommand: Command = (state, dispatch) => {
  const { empty, from, to } = state.selection;
  const range = empty ? linkRangeAt(state) : { from, to };
  if (range === undefined || !state.doc.rangeHasMark(range.from, range.to, linkType())) {
    return false;
  }
  dispatch?.(state.tr.removeMark(range.from, range.to, linkType()).scrollIntoView());
  return true;
};

/** True when a link may be set at the selection (the link control is enabled). */
export function canLink(state: EditorState): boolean {
  return linkAllowed(state);
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

interface RootList {
  readonly node: ProseMirrorNode;
  readonly pos: number;
}

/** The root list around the selection, if any. */
export function rootListAt(state: EditorState): RootList | undefined {
  const { $from } = state.selection;
  const list = nodeType('list');
  for (let depth = 1; depth <= $from.depth; depth += 1) {
    if ($from.node(depth).type === list) {
      return { node: $from.node(depth), pos: $from.before(depth) };
    }
  }
  return undefined;
}

/** The style of the list around the selection, if any. */
export function activeListStyle(state: EditorState): ListStyle | undefined {
  const root = rootListAt(state);
  return root === undefined ? undefined : (root.node.attrs.style as ListStyle);
}

/** Lift the item at the selection until it is a paragraph again. */
const unwrapListItem: Command = (state, dispatch) => {
  if (!liftRichTextListItem(state)) {
    return false;
  }
  if (dispatch === undefined) {
    return true;
  }
  // Each lift is computed on a plain state holding the previous lift's result
  // (the lift reads only the document and the selection) and its steps are
  // collected into one transaction, so the whole unwrap is one undo step.
  const tr = state.tr;
  let current: EditorState = state;
  for (let level = 0; level < MAX_LIST_DEPTH && rootListAt(current) !== undefined; level += 1) {
    let lifted: Transaction | undefined;
    liftRichTextListItem(current, (next) => {
      lifted = next;
    });
    if (lifted === undefined) {
      break;
    }
    for (const step of lifted.steps) {
      tr.step(step);
    }
    tr.setSelection(Selection.fromJSON(tr.doc, lifted.selection.toJSON()));
    current = EditorState.create({ doc: tr.doc, selection: tr.selection });
  }
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * The list command for `style`: wrap the selected paragraphs in a list of
 * that style, switch the surrounding list to it, or, when the surrounding
 * list already has it, move the item at the selection out of the list.
 */
export function toggleListCommand(style: ListStyle): Command {
  const wrap = wrapInList(nodeType('list'), { style });
  return (state, dispatch) => {
    const root = rootListAt(state);
    if (root === undefined) {
      return wrap(state, dispatch);
    }
    if (root.node.attrs.style === style) {
      return unwrapListItem(state, dispatch);
    }
    dispatch?.(state.tr.setNodeAttribute(root.pos, 'style', style).scrollIntoView());
    return true;
  };
}

/** Nest the list item at the selection one level deeper. */
export const indentCommand: Command = sinkRichTextListItem;

/** Move the list item at the selection out one level. */
export const outdentCommand: Command = liftRichTextListItem;

const ITEM_NAMES: ReadonlySet<string> = new Set(LIST_ITEM_NODES);

/** Toggle `checked` on the innermost task item holding the selection. */
export const toggleTaskCommand: Command = (state, dispatch) => {
  if (activeListStyle(state) !== 'task') {
    return false;
  }
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (ITEM_NAMES.has(node.type.name)) {
      dispatch?.(state.tr.setNodeAttribute($from.before(depth), 'checked', !node.attrs.checked));
      return true;
    }
  }
  return false;
};

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

/** The atom blocks the insert menu offers. */
export type AtomName = 'divider' | 'image' | 'gallery' | 'embed' | 'cta';

/**
 * Where an atom goes: after the top-level block holding the selection (an
 * atom is always a top-level block, so it never splits a paragraph or lands
 * inside a list), in place of that block when it is an empty paragraph, or
 * after a selected top-level node.
 */
function atomPlace(state: EditorState): { readonly from: number; readonly to: number } {
  const { $from, to } = state.selection;
  if ($from.depth === 0) {
    return { from: to, to };
  }
  const block = $from.node(1);
  if (block.type === nodeType('paragraph') && block.content.size === 0) {
    return { from: $from.before(1), to: $from.after(1) };
  }
  return { from: $from.after(1), to: $from.after(1) };
}

/**
 * Insert an atom of `name` with `attrs` (which its attribute validation
 * checks) after the block holding the selection, with an empty paragraph
 * after it when no textblock follows, and put the cursor in the textblock
 * after it.
 */
export function insertAtomCommand(
  name: AtomName,
  attrs: Readonly<Record<string, unknown>> = {},
): Command {
  return (state, dispatch) => {
    if (dispatch !== undefined) {
      const atom = nodeType(name).create(attrs);
      const { from, to } = atomPlace(state);
      const tr = state.tr.replaceWith(from, to, atom);
      const after = from + atom.nodeSize;
      const next = tr.doc.resolve(after).nodeAfter;
      if (next === null || !next.isTextblock) {
        tr.insert(after, nodeType('paragraph').create());
      }
      tr.setSelection(TextSelection.create(tr.doc, after + 1));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}
