/**
 * The model's character rules for editor text, which a ProseMirror schema
 * cannot express (it validates attributes, not text).
 *
 * The clean functions bring a string within the rule of where it sits:
 * `\r\n` and `\r` become `\n`, unpaired surrogates become U+FFFD, and C0 and
 * C1 controls, DEL and the bidi embedding, override and isolate controls are
 * removed; code keeps `\n` and `\t`, run text turns `\t` into a space, and
 * line text (a heading) also turns `\n` into a space. `decode` applies them,
 * so it is total over every state, and {@link richTextTextRules} applies them
 * to the text each transaction touched, so typed, pasted or dropped text that
 * breaks a rule is corrected in the state itself and the editor shows what
 * `decode` returns. In a paragraph, a `\n` becomes a `hard_break` node, the
 * editor's form of a run's line break.
 *
 * A line break in text that becomes a heading follows the same rule: it
 * becomes a space. ProseMirror instead deletes a `hard_break` that a block's
 * new type cannot hold (`setBlockType`, so the `## ` input rule, and joining
 * a paragraph into a heading), and splits the heading at each break of text
 * pasted into it. So the plugin writes a space where such a deletion removed
 * a break, and a paste into a heading arrives with the breaks of the text it
 * adds to the heading already written as spaces.
 */

import { Fragment, Slice, type Mark, type Node as ProseMirrorNode } from 'prosemirror-model';
import { isHistoryTransaction } from 'prosemirror-history';
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';

import { changedRanges } from './changed-ranges.js';
import { nodeType } from './schema.js';

/** Characters no text may hold, after line endings are normalised; code keeps `\t` and `\n`. */
const REFUSED = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** `text` within the rule for code: `\n` and `\t` kept. */
export function cleanCodeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(LONE_SURROGATE, '\ufffd').replace(REFUSED, '');
}

/** `text` within the rule for run text: `\n` kept as a line break, `\t` a space. */
export function cleanRunText(text: string): string {
  return cleanCodeText(text).replace(/\t/g, ' ');
}

/** `text` within the rule for a heading run: no line breaks. */
export function cleanLineText(text: string): string {
  return cleanRunText(text).replace(/\n/g, ' ');
}

/** The clean function for the text of a textblock of type `name`. */
export function cleanerFor(name: string): (text: string) => string {
  if (name === 'code_block') {
    return cleanCodeText;
  }
  return name === 'heading' ? cleanLineText : cleanRunText;
}

/** The nodes a text node becomes under its block's rule. */
function cleanedText(node: ProseMirrorNode, block: string): ProseMirrorNode[] {
  const text = cleanerFor(block)(node.text ?? '');
  const schema = node.type.schema;
  if (block === 'code_block' || block === 'heading') {
    return text === '' ? [] : [schema.text(text, node.marks)];
  }
  const out: ProseMirrorNode[] = [];
  text.split('\n').forEach((part, index) => {
    if (index > 0) {
      out.push(nodeType('hard_break').create(null, null, node.marks));
    }
    if (part !== '') {
      out.push(schema.text(part, node.marks));
    }
  });
  return out;
}

interface TextFix {
  readonly from: number;
  readonly to: number;
  readonly content: readonly ProseMirrorNode[];
}

function fixesIn(block: ProseMirrorNode, start: number, out: TextFix[]): void {
  block.forEach((child, offset) => {
    if (!child.isText) {
      return;
    }
    const content = cleanedText(child, block.type.name);
    const unchanged =
      content.length === 1 && content[0]?.isText === true && content[0].text === child.text;
    if (!unchanged) {
      const from = start + offset;
      out.push({ from, to: from + child.nodeSize, content });
    }
  });
}

/** True when `block` holds inline content but no line break (a heading or code). */
function refusesBreaks(block: ProseMirrorNode): boolean {
  return block.inlineContent && block.type.contentMatch.matchType(nodeType('hard_break')) === null;
}

/** The text a line break of `block`'s content becomes in `block`, which refuses breaks. */
function breakText(block: ProseMirrorNode, marks: readonly Mark[]): ProseMirrorNode {
  return block.type.schema.text(cleanerFor(block.type.name)('\n'), block.type.allowedMarks(marks));
}

interface RemovedBreak {
  /** Where the break was, in the last transaction's document. */
  readonly pos: number;
  readonly marks: readonly Mark[];
}

/**
 * The line breaks `transactions` deleted one at a time (a step that removes
 * a single `hard_break` and nothing else, which is how ProseMirror clears
 * one from a block whose new type refuses it), mapped to the last document.
 * Undo and redo are skipped: they replay recorded edits, and the space
 * written for a break was recorded with the edit that removed it.
 */
function removedBreaks(transactions: readonly Transaction[]): RemovedBreak[] {
  const hardBreak = nodeType('hard_break');
  let found: RemovedBreak[] = [];
  for (const tr of transactions) {
    found = found.flatMap((removed) => {
      const mapped = tr.mapping.mapResult(removed.pos);
      return mapped.deletedAcross ? [] : [{ pos: mapped.pos, marks: removed.marks }];
    });
    if (isHistoryTransaction(tr)) {
      continue;
    }
    tr.steps.forEach((step, index) => {
      const before = tr.docs[index] as ProseMirrorNode;
      const rest = tr.mapping.slice(index + 1);
      step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
        const node =
          oldEnd - oldStart === 1 && newStart === newEnd ? before.nodeAt(oldStart) : null;
        if (node?.type === hardBreak) {
          const mapped = rest.mapResult(newStart);
          if (!mapped.deletedAcross) {
            found.push({ pos: mapped.pos, marks: node.marks });
          }
        }
      });
    });
  }
  return found;
}

/**
 * `fragment` with `replace` applied to the textblock at the open start of a
 * slice `depth` levels deep: the textblock whose content a paste adds to the
 * block at the cursor.
 */
function mapOpenTextblock(
  fragment: Fragment,
  depth: number,
  replace: (block: ProseMirrorNode) => ProseMirrorNode,
): Fragment {
  const first = fragment.firstChild;
  if (first === null || depth === 0) {
    return fragment;
  }
  return fragment.replaceChild(
    0,
    first.isTextblock
      ? replace(first)
      : first.copy(mapOpenTextblock(first.content, depth - 1, replace)),
  );
}

/** `slice` as pasted into `target`: when `target` refuses breaks, the text it receives has none. */
function pastedInto(slice: Slice, target: ProseMirrorNode): Slice {
  if (!refusesBreaks(target)) {
    return slice;
  }
  const content = mapOpenTextblock(slice.content, slice.openStart, (block) => {
    const children: ProseMirrorNode[] = [];
    block.forEach((child) => {
      children.push(child.type === nodeType('hard_break') ? breakText(target, child.marks) : child);
    });
    return block.copy(Fragment.from(children));
  });
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

/** The key of the {@link richTextTextRules} plugin. */
export const textRulesKey: PluginKey = new PluginKey('richTextTextRules');

/**
 * A plugin that rewrites the text of every textblock a transaction touched to
 * the model's rule for that block, in an appended transaction (so undo takes
 * the correction back together with the edit that needed it), writes a
 * space where a transaction deleted a line break from a heading's text, and
 * writes the breaks of text pasted into a heading as spaces.
 */
export function richTextTextRules(): Plugin {
  return new Plugin({
    key: textRulesKey,
    props: {
      transformPasted: (slice, view) => pastedInto(slice, view.state.selection.$from.parent),
    },
    appendTransaction(transactions, _oldState, state) {
      if (!transactions.some((tr) => tr.docChanged)) {
        return null;
      }
      const tr = state.tr;
      for (const removed of removedBreaks(transactions).sort((a, b) => b.pos - a.pos)) {
        const block = state.doc.resolve(removed.pos).parent;
        if (refusesBreaks(block)) {
          tr.insert(removed.pos, breakText(block, removed.marks));
        }
      }
      const seen = new Set<number>();
      const fixes: TextFix[] = [];
      for (const [from, to] of changedRanges(transactions)) {
        tr.doc.nodesBetween(tr.mapping.map(from, -1), tr.mapping.map(to, 1), (node, pos) => {
          if (!node.isTextblock) {
            return true;
          }
          if (!seen.has(pos)) {
            seen.add(pos);
            fixesIn(node, pos + 1, fixes);
          }
          return false;
        });
      }
      for (const fix of fixes.sort((a, b) => b.from - a.from)) {
        tr.replaceWith(fix.from, fix.to, Fragment.from([...fix.content]));
      }
      return tr.docChanged ? tr : null;
    },
  });
}
