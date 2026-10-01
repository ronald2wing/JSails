/**
 * The whitespace rule of `.jsails` templates (docs/design/sfc.md §5.2):
 * Prettier's own significance classification, so a formatted file always
 * renders the same HTML.
 *
 * Each run of HTML whitespace in a parent's children, inside a text node or
 * forming one, is removed where Prettier treats it as insignificant (at the
 * edges of a block-like or `inline-block` parent, next to a block-like
 * sibling, inside a `display: none` parent) and otherwise becomes one space.
 * Line breaks play no part. Comments are already gone, so the whitespace on
 * both sides of one is a single run. Whitespace between the branches of a
 * `js-if` chain is removed, since only one branch renders. Inside `<pre>`,
 * `<textarea>` and `js-pre` subtrees whitespace is kept exactly, with CRLF
 * read as LF as HTML reads it.
 *
 * The functions mirror Prettier's `isLeadingSpaceSensitive`,
 * `isTrailingSpaceSensitive` and `isDanglingSpaceSensitive`
 * (`prettier/plugins/html.mjs`) for the cases a template can reach.
 */

import { isBlockLikeDisplay } from './html-elements.js';
import type { ElementNode, InterpolationNode, TemplateNode, TextNode } from './template-ast.js';

/** A piece of raw text: literal source characters, or a decoded entity. */
export interface TextPart {
  readonly text: string;
  /** False for a decoded character reference, whose characters never condense. */
  readonly literal: boolean;
}

/** Text as parsed, before the rule: its parts and its source range. */
export interface TextRun {
  readonly kind: 'text';
  readonly start: number;
  readonly end: number;
  readonly parts: readonly TextPart[];
}

/** An element with what the rule needs to know about it. */
export interface ElementItem {
  readonly kind: 'element';
  readonly node: ElementNode;
  readonly display: string;
  /** Whether the element keeps its own whitespace (`white-space: pre*`). */
  readonly preformatted: boolean;
  /** Has `js-if` or `js-else-if`: a following else branch continues its chain. */
  readonly opensChain: boolean;
  /** Has `js-else-if` or `js-else`. */
  readonly continuesChain: boolean;
}

/** A child before the rule is applied. */
export type WhitespaceItem = TextRun | InterpolationNode | ElementItem;

/** What the rule needs to know about the parent. */
export interface WhitespaceParent {
  readonly display: string;
  /** Inside `<pre>`, `<textarea>` or `js-pre`: keep every character. */
  readonly keepWhitespace: boolean;
}

const HTML_WHITESPACE = /[ \t\n\f\r]/;

interface Analysed {
  readonly content: string;
  readonly leading: boolean;
  readonly trailing: boolean;
}

/** Split a run into its content (inner runs condensed) and edge whitespace. */
function analyse(run: TextRun): Analysed {
  let content = '';
  let leading = false;
  let pending = false;
  for (const part of run.parts) {
    if (!part.literal) {
      if (pending) {
        content += ' ';
      }
      pending = false;
      content += part.text;
      continue;
    }
    for (const char of part.text) {
      if (HTML_WHITESPACE.test(char)) {
        if (content === '') {
          leading = true;
        } else {
          pending = true;
        }
      } else {
        if (pending) {
          content += ' ';
        }
        pending = false;
        content += char;
      }
    }
  }
  return { content, leading, trailing: pending };
}

/** A child as Prettier sees it once whitespace-only text is removed. */
interface RuleNode {
  readonly item: TextRun | InterpolationNode | ElementItem;
  readonly content: string;
  readonly textLike: boolean;
  readonly display: string;
  readonly preformatted: boolean;
}

type Token =
  | { readonly kind: 'node'; readonly node: RuleNode }
  | { readonly kind: 'gap'; readonly start: number; readonly end: number };

function ruleNode(item: TextRun | InterpolationNode | ElementItem, content: string): RuleNode {
  if (item.kind === 'element') {
    return {
      item,
      content,
      textLike: false,
      display: item.display,
      preformatted: item.preformatted,
    };
  }
  return { item, content, textLike: true, display: 'inline', preformatted: false };
}

/** Prettier's `Vs`/`Us`: the parent's edges keep whitespace. */
function edgeSensitiveParent(display: string): boolean {
  return !isBlockLikeDisplay(display) && display !== 'inline-block';
}

function leadingSensitive(
  node: RuleNode,
  prev: RuleNode | undefined,
  parent: WhitespaceParent,
): boolean {
  if (node.textLike && prev?.textLike === true) {
    return true;
  }
  if (parent.display === 'none') {
    return false;
  }
  if (prev === undefined) {
    return !node.preformatted && edgeSensitiveParent(parent.display);
  }
  return !isBlockLikeDisplay(prev.display);
}

function trailingSensitive(
  node: RuleNode,
  next: RuleNode | undefined,
  parent: WhitespaceParent,
): boolean {
  if (node.textLike && next?.textLike === true) {
    return true;
  }
  if (parent.display === 'none') {
    return false;
  }
  if (next === undefined) {
    return !node.preformatted && edgeSensitiveParent(parent.display);
  }
  return !isBlockLikeDisplay(next.display);
}

/**
 * Prettier's `isDanglingSpaceSensitive`: whitespace is a parent's only child.
 * Unlike the edges, a `display: none` parent keeps it.
 */
function danglingSensitive(parent: WhitespaceParent): boolean {
  return edgeSensitiveParent(parent.display);
}

function textNode(value: string, start: number, end: number): TextNode {
  return Object.freeze({ kind: 'text', value, start, end });
}

/** Apply the whitespace rule to one parent's children. */
export function condenseChildren(
  items: readonly WhitespaceItem[],
  parent: WhitespaceParent,
): readonly TemplateNode[] {
  if (parent.keepWhitespace) {
    return keepChildren(items);
  }

  const tokens: Token[] = [];
  const pushGap = (start: number, end: number): void => {
    const last = tokens.at(-1);
    if (last?.kind === 'gap') {
      tokens[tokens.length - 1] = { kind: 'gap', start: last.start, end };
    } else {
      tokens.push({ kind: 'gap', start, end });
    }
  };
  for (const item of items) {
    if (item.kind !== 'text') {
      tokens.push({ kind: 'node', node: ruleNode(item, '') });
      continue;
    }
    const analysed = analyse(item);
    if (analysed.content === '') {
      if (analysed.leading) {
        pushGap(item.start, item.end);
      }
      continue;
    }
    if (analysed.leading) {
      pushGap(item.start, item.start);
    }
    tokens.push({ kind: 'node', node: ruleNode(item, analysed.content) });
    if (analysed.trailing) {
      pushGap(item.end, item.end);
    }
  }

  const nodes = tokens.flatMap((token) => (token.kind === 'node' ? [token.node] : []));
  const leading = new Map<RuleNode, boolean>();
  const trailing = new Map<RuleNode, boolean>();
  nodes.forEach((node, index) => {
    leading.set(node, leadingSensitive(node, nodes[index - 1], parent));
    trailing.set(node, trailingSensitive(node, nodes[index + 1], parent));
  });

  const out: TemplateNode[] = [];
  const append = (node: TemplateNode): void => {
    const last = out.at(-1);
    if (node.kind === 'text' && last?.kind === 'text') {
      out[out.length - 1] = textNode(
        last.value + node.value,
        Math.min(last.start, node.start),
        Math.max(last.end, node.end),
      );
      return;
    }
    out.push(node);
  };

  tokens.forEach((token, index) => {
    if (token.kind === 'node') {
      const { item } = token.node;
      if (item.kind === 'text') {
        append(textNode(token.node.content, item.start, item.end));
      } else {
        append(item.kind === 'element' ? item.node : item);
      }
      return;
    }
    const left = previousNode(tokens, index);
    const right = nextNode(tokens, index);
    if (keepsGap(left, right, parent, leading, trailing)) {
      append(textNode(' ', token.start, token.end));
    }
  });
  return Object.freeze(out);
}

function previousNode(tokens: readonly Token[], index: number): RuleNode | undefined {
  const token = tokens[index - 1];
  return token?.kind === 'node' ? token.node : undefined;
}

function nextNode(tokens: readonly Token[], index: number): RuleNode | undefined {
  const token = tokens[index + 1];
  return token?.kind === 'node' ? token.node : undefined;
}

function keepsGap(
  left: RuleNode | undefined,
  right: RuleNode | undefined,
  parent: WhitespaceParent,
  leading: ReadonlyMap<RuleNode, boolean>,
  trailing: ReadonlyMap<RuleNode, boolean>,
): boolean {
  if (right === undefined) {
    return left === undefined ? danglingSensitive(parent) : trailing.get(left) === true;
  }
  if (left === undefined) {
    return leading.get(right) === true;
  }
  if (
    left.item.kind === 'element' &&
    right.item.kind === 'element' &&
    left.item.opensChain &&
    right.item.continuesChain
  ) {
    return false;
  }
  return trailing.get(left) === true && leading.get(right) === true;
}

/**
 * HTML's input-stream rule: a CRLF pair or a lone CR in the source is a line
 * feed, so kept whitespace renders the same from a checkout with either line
 * ending. A decoded `&#13;` is content and stays.
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Children of a whitespace-preserving parent: text kept character for character, newlines normalized. */
function keepChildren(items: readonly WhitespaceItem[]): readonly TemplateNode[] {
  const out: TemplateNode[] = [];
  for (const item of items) {
    if (item.kind === 'text') {
      const value = item.parts
        .map((part) => (part.literal ? normalizeNewlines(part.text) : part.text))
        .join('');
      if (value !== '') {
        out.push(textNode(value, item.start, item.end));
      }
    } else {
      out.push(item.kind === 'element' ? item.node : item);
    }
  }
  return Object.freeze(out);
}
