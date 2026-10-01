/**
 * The `<style>` blocks of a `.jsails` component (sfc-plan §2.1, D2): each
 * block's CSS as the app's one stylesheet holds it, the scope id of
 * `<style scoped>`, the marker attribute the template lowering writes, and
 * the virtual id that names one block.
 *
 * A `<style>` block is global CSS, copied as written. A `<style scoped>`
 * block is wrapped in a native `@scope` rule, with no selector rewriting:
 *
 * ```css
 * @scope (:has(> [data-s="h"]), [data-s="h"]:root)
 *     to (:scope:not([data-s="h"]) > :not([data-s="h"]), [data-s]:not([data-s="h"])) { … }
 * ```
 *
 * Every compiled template writes `data-s="h"` on its outermost elements and
 * on the outermost elements of the content it passes to a component
 * (`template-jsx.ts`). The scoping root is the parent of such an element,
 * not the element itself, because inside `@scope` a selector without
 * `:scope` matches descendants of the root only: rooted at the marked
 * element, `.card` could never style the component's own root. The first
 * limit removes the parent's other children, the second ends the scope at
 * another component's marked element (a child component's root, or content
 * another component passed in), and `[data-s="h"]:root` roots a layout whose
 * root is `<html>`, which has no parent element. So a scoped rule reaches the
 * elements its template renders, slot content it passes included, and
 * elements a TSX component renders inside them, down to the next marked
 * element. `:scope` there names the parent, never the component's root, and
 * so do a top-level `&` and a declaration written outside a rule, which CSS
 * nesting reads as `:where(:scope)`; all three are refused.
 *
 * The scope id `h` depends only on the component's normalized posix project
 * path (the component path for a folder too, and lower-cased), so the
 * server, the browser and a static export agree, and builds are reproducible
 * on every platform.
 *
 * Blocks are joined into one sheet (`style-sheet.ts`), where one block's
 * unclosed comment, string or bracket would swallow the blocks after it, a
 * stray `}` would close a scope early, text left after a block's last rule
 * (a selector with no `{ }` block, a declaration, an at-rule with no `;`)
 * would become the selector of the next block's first rule, and `@import` is
 * ignored after the first rule. {@link checkStyleBlock} reports those, and
 * what a scoped block cannot scope, with a lexical scan: it reads comments,
 * strings, escapes, `url()`, brackets and at-keywords, follows which rule
 * list each `{ }` block opens, and rewrites nothing.
 */

import { createHash } from 'node:crypto';

import { defineErrors, type ErrorRegistry } from '../../errors/registry.js';
import type { SfcStyleBlock } from './blocks.js';
import type { SfcDiagnostics } from './diagnostics.js';
import { isProjectRelativeName } from './segments.js';
import type { SourceSpace } from './source-space.js';

/** The attribute that marks a compiled template's outermost elements with its scope id. */
export const SCOPE_ATTRIBUTE = 'data-s';

const SFC_STYLE_ERRORS = {
  invalid_path: {
    kind: 'internal',
    message: 'a scope id is derived from a normalized posix project path',
    suggestion: 'pass the path relative to the project root with / separators (toPosixId)',
  },
  scope_collision: {
    kind: 'conflict',
    message: 'the components {first} and {second} have the same scope id',
    context: { first: 'relative-path', second: 'relative-path' },
    suggestion: 'rename one of the two components',
  },
  duplicate_file: {
    kind: 'internal',
    message: 'the styles of {file} were collected twice',
    context: { file: 'relative-path' },
  },
} as const;

/**
 * The scoped-style registry: `sfc_style.*`.
 *
 * @internal
 */
export const SfcStyleErrors: ErrorRegistry<'sfc_style', typeof SFC_STYLE_ERRORS> = defineErrors(
  'sfc_style',
  SFC_STYLE_ERRORS,
);

/** One `<style>` block, as the app's stylesheet holds it. */
export interface SfcStyle {
  /** Its virtual id (`sfcStyleId`). */
  readonly id: string;
  /** Its index among the component's style blocks, in source order. */
  readonly index: number;
  readonly scoped: boolean;
  /** The block's CSS: as written, a scoped block inside its `@scope` rule; ends with a line break. */
  readonly css: string;
}

/**
 * The scope id of the component at the normalized posix project path `file`:
 * the first 40 bits of the SHA-256 of its lower-cased spelling, in base36,
 * eight characters. Lower-cased, because a case-insensitive file system can
 * reach one file under two spellings (a server and a client graph importing
 * it differently), and both must write the markers its CSS selects; two
 * files that differ only in case are refused when the sheet is collected
 * (`style-sheet.ts`). Throws
 * `sfc_style.invalid_path` for a path with a backslash, a colon (a drive
 * letter), a leading `/` or an empty, `.` or `..` segment, whose id would
 * depend on the machine; normalize with `toPosixId`.
 */
export function sfcScopeId(file: string): string {
  if (!isProjectRelativeName(file)) throw new SfcStyleErrors.Error('invalid_path');
  const digest = createHash('sha256').update(file.toLowerCase(), 'utf8').digest();
  return digest.readUIntBE(0, 5).toString(36).padStart(8, '0');
}

/** The marker attribute as the template lowering writes it: ` data-s="h"`. */
export function scopeMarker(scopeId: string): string {
  return ` ${SCOPE_ATTRIBUTE}="${scopeId}"`;
}

/**
 * The marker of a `<component :is>` bound to `binding`: written only when
 * the bound type is a tag name, because a component's attributes are its
 * props, and the component marks its own elements.
 */
export function dynamicScopeMarker(binding: string, scopeId: string): string {
  return ` {...(typeof ${binding} === "string" ? { "${SCOPE_ATTRIBUTE}": "${scopeId}" } : {})}`;
}

function withLineBreak(css: string): string {
  return css.endsWith('\n') ? css : `${css}\n`;
}

/** A scoped block's body inside the `@scope` rule of `scopeId` (see the module comment). */
export function scopedCss(body: string, scopeId: string): string {
  const own = `[${SCOPE_ATTRIBUTE}="${scopeId}"]`;
  return (
    `@scope (:has(> ${own}), ${own}:root) ` +
    `to (:scope:not(${own}) > :not(${own}), [${SCOPE_ATTRIBUTE}]:not(${own})) {\n` +
    `${withLineBreak(body)}}\n`
  );
}

const STYLE_QUERY = '?jsails&type=style&index=';
const STYLE_ID = /^(.+)\?jsails&type=style&index=(0|[1-9]\d{0,8})&lang\.css$/s;

/** The virtual id of the style block `index` of the component `file`. */
export function sfcStyleId(file: string, index: number): string {
  return `${file}${STYLE_QUERY}${index}&lang.css`;
}

/** The component and block index a style id names, or `undefined` for any other id. */
export function parseSfcStyleId(
  id: string,
): { readonly file: string; readonly index: number } | undefined {
  const match = STYLE_ID.exec(id);
  if (match === null) return undefined;
  return Object.freeze({ file: match[1] as string, index: Number(match[2]) });
}

/**
 * The style blocks of a component as its stylesheet holds them, after each
 * block is checked ({@link checkStyleBlock}). A block's CSS is its body, from
 * the line after its start tag to its end tag.
 */
export function lowerStyles(
  blocks: readonly SfcStyleBlock[],
  context: {
    readonly file: string;
    readonly scopeId: string;
    readonly space: SourceSpace;
    readonly diagnostics: SfcDiagnostics;
  },
): readonly SfcStyle[] {
  return Object.freeze(
    blocks.map((block, index) => {
      const body = context.space.slice(block.bodyStart, block.contentEnd);
      checkStyleBlock(body, block.bodyStart, block.scoped, context.diagnostics);
      return Object.freeze({
        id: sfcStyleId(context.file, index),
        index,
        scoped: block.scoped,
        css: block.scoped ? scopedCss(body, context.scopeId) : withLineBreak(body),
      });
    }),
  );
}

/** At-rules the joined sheet ignores after its first rule. */
const STATEMENT_RULES: ReadonlySet<string> = new Set(['import', 'charset', 'namespace']);

/** At-rules that define a document-wide name or apply to the document, which no scope limits. */
const DOCUMENT_RULES: ReadonlySet<string> = new Set([
  'keyframes',
  '-webkit-keyframes',
  '-moz-keyframes',
  '-o-keyframes',
  'font-face',
  'property',
  'counter-style',
  'font-feature-values',
  'font-palette-values',
  'color-profile',
  'function',
  'page',
  'position-try',
  'view-transition',
]);

/**
 * The group rules CSS nesting reads the way it reads the rule they are
 * nested in: inside the `@scope` rule, `&` and a declaration in their body
 * still name the scoping root.
 */
const GROUP_RULES: ReadonlySet<string> = new Set([
  'media',
  'supports',
  'container',
  'layer',
  'starting-style',
]);

const NOT_A_RULE = 'This text is not a rule: a selector needs its { } block';

const OPENERS: Readonly<Record<string, string>> = Object.freeze({ '}': '{', ')': '(', ']': '[' });

/**
 * What a rule list holds, which decides what the check reports in it.
 *
 * - `rules`: the top level of a `<style>` block, or a group rule's body
 *   there. It holds rules only. A declaration, a `;` that ends no at-rule,
 *   or text with no `{ }` block becomes part of the selector of the rule
 *   after it, which the joined sheet takes from the next block.
 * - `scope`: the top level of a `<style scoped>` block, inside its `@scope`
 *   rule, or a group rule's body there. CSS nesting reads a declaration
 *   there, and `&`, as the scoping root: the parent the component is
 *   mounted in. An at-rule this check does not know is read as a group
 *   rule, and so is `@scope` with no start selector, whose root is that
 *   parent too.
 * - `declarations`: a style rule's body, a nested `@scope` rooted at its
 *   own selector, or a definition's body; nothing in it is reported.
 */
type RuleContext = 'rules' | 'scope' | 'declarations';

/** The construct a rule list is reading: from its first token to its `;` or `{ }` block. */
interface RuleItem {
  readonly start: number;
  /** The lower-cased at-keyword it starts with, or `undefined` for a qualified rule. */
  readonly atRule: string | undefined;
  /** Where its at-keyword ends. */
  readonly nameEnd: number;
  /** Set once it reads as a declaration and was reported, so its value is not reported again. */
  declaration: boolean;
}

interface RuleLevel {
  readonly context: RuleContext;
  item: RuleItem | undefined;
}

interface OpenBracket {
  readonly char: string;
  readonly start: number;
  readonly end: number;
  /** The rule list a `{` opened as a rule's block, `undefined` for any other bracket. */
  readonly level?: RuleLevel;
}

function isNameChar(char: string | undefined): boolean {
  if (char === undefined) return false;
  return /[A-Za-z0-9_-]/.test(char) || char.charCodeAt(0) >= 0x80;
}

function isNameStart(char: string | undefined): boolean {
  return isNameChar(char) && !/[0-9]/.test(char as string);
}

function nameEnd(text: string, from: number): number {
  let at = from;
  while (isNameChar(text[at])) at += 1;
  return at;
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

/**
 * The start of a declaration as CSS nesting reads one: an identifier,
 * optional whitespace, a colon. A selector like `a:hover` matches too; it is
 * told apart by the `{ }` block that follows it.
 */
const DECLARATION_START = /(?:--|-?[A-Za-z_\u0080-\uFFFF])[\w\-\u0080-\uFFFF]*[ \t\n\r\f]*:/y;

/** The start of a custom property declaration, whose value may hold a `{ }` block. */
const CUSTOM_PROPERTY_START = /--[\w\-\u0080-\uFFFF]*[ \t\n\r\f]*:/y;

function matchesAt(pattern: RegExp, text: string, start: number): boolean {
  pattern.lastIndex = start;
  return pattern.test(text);
}

/** The context of the rule list that `item`'s `{ }` block opens inside a list of `context`. */
function blockContext(context: RuleContext, item: RuleItem, body: string, at: number): RuleContext {
  if (context === 'declarations' || item.atRule === undefined) return 'declarations';
  if (GROUP_RULES.has(item.atRule)) return context;
  if (context === 'rules' || DOCUMENT_RULES.has(item.atRule)) return 'declarations';
  if (item.atRule === 'scope' && /^[ \t\n\r\f]*\(/.test(body.slice(item.nameEnd, at))) {
    return 'declarations';
  }
  return 'scope';
}

/**
 * The end of the string that opens at `start`, past its closing quote, or
 * `-1` when a line break or the text's end comes first: CSS ends an
 * unclosed string at its line.
 */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  let at = start + 1;
  while (at < text.length) {
    const char = text[at];
    if (char === quote) return at + 1;
    if (char === '\n' || char === '\r' || char === '\f') return -1;
    at += char === '\\' ? 2 : 1;
  }
  return -1;
}

/** The end of an unquoted `url(` whose content starts at `from`, past its `)`, or `-1`. */
function urlEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length) {
    const char = text[at];
    if (char === ')') return at + 1;
    at += char === '\\' ? 2 : 1;
  }
  return -1;
}

/**
 * Report what breaks a block in the joined sheet, or does not do what its
 * block promises: `body` is the block's CSS, `base` its first offset in the
 * component's space. Besides the lexical constructs, it follows the rule
 * structure ({@link RuleContext}): every rule list must hold complete rules,
 * so no text is left over to join the selector of the next block's first
 * rule, and a scoped block's top level holds no `&` and no declaration. The
 * scan stops at the first unbalanced construct, after which nothing it would
 * read is meaningful.
 */
export function checkStyleBlock(
  body: string,
  base: number,
  scoped: boolean,
  diagnostics: SfcDiagnostics,
): void {
  const unbalanced = (message: string, start: number, end: number): void => {
    diagnostics.error('sfc.style_unbalanced', message, base + start, base + end);
  };
  const incomplete = (message: string, start: number, end: number): void => {
    diagnostics.error('sfc.style_incomplete', message, base + start, base + end);
  };
  const outsideRule = (context: RuleContext, start: number, end: number): void => {
    if (context === 'scope') {
      diagnostics.error(
        'sfc.scope_declaration',
        'In <style scoped>, a declaration outside a rule belongs to the element the component is mounted in, not its root; put it in a rule that selects the root by its class or tag',
        base + start,
        base + end,
      );
    } else {
      incomplete('This declaration is outside any rule; put it inside one', start, end);
    }
  };
  /** Report the construct `level` was reading when its list ended at `end`. */
  const unfinished = (level: RuleLevel, end: number): void => {
    const item = level.item;
    level.item = undefined;
    if (item === undefined || item.declaration || level.context === 'declarations') return;
    if (item.atRule !== undefined) {
      incomplete('This at-rule is not ended: end it with ; or its { } block', item.start, end);
    } else if (matchesAt(DECLARATION_START, body, item.start)) {
      outsideRule(level.context, item.start, end);
    } else {
      incomplete(NOT_A_RULE, item.start, end);
    }
  };
  const root: RuleLevel = { context: scoped ? 'scope' : 'rules', item: undefined };
  const levels: RuleLevel[] = [root];
  const stack: OpenBracket[] = [];
  /** The end of the last token that was not whitespace or a comment. */
  let tokenEnd = 0;
  let at = 0;
  while (at < body.length) {
    const char = body[at] as string;
    if (isWhitespace(char)) {
      at += 1;
      continue;
    }
    if (char === '/' && body[at + 1] === '*') {
      const close = body.indexOf('*/', at + 2);
      if (close === -1) {
        unbalanced('This comment is not closed', at, at + 2);
        return;
      }
      at = close + 2;
      continue;
    }
    const level = levels.at(-1) as RuleLevel;
    const top = stack.at(-1);
    const atLevel = top === undefined || top.level !== undefined;
    if (atLevel && level.context !== 'declarations' && char !== '}' && char !== ';') {
      const keyword = char === '@' && isNameStart(body[at + 1]);
      const end = keyword ? nameEnd(body, at + 1) : at;
      level.item ??= {
        start: at,
        atRule: keyword ? body.slice(at + 1, end).toLowerCase() : undefined,
        nameEnd: end,
        declaration: false,
      };
    }
    if (char === '"' || char === "'") {
      const end = stringEnd(body, at);
      if (end === -1) {
        unbalanced('This string is not closed on its line', at, at + 1);
        return;
      }
      at = end;
    } else if (char === '\\') {
      at += 2;
    } else if (char === '@' && isNameStart(body[at + 1])) {
      const end = nameEnd(body, at + 1);
      checkAtRule(
        body.slice(at + 1, end).toLowerCase(),
        base + at,
        base + end,
        scoped,
        diagnostics,
      );
      at = end;
    } else if (
      char === ':' &&
      scoped &&
      body.slice(at + 1, at + 6).toLowerCase() === 'scope' &&
      !isNameChar(body[at + 6])
    ) {
      diagnostics.error(
        'sfc.scope_selector',
        'In <style scoped>, :scope is the element the component is mounted in, not its root; select the root by its class or tag',
        base + at,
        base + at + 6,
      );
      at += 6;
    } else if (char === '&') {
      const item = level.item;
      if (
        level.context === 'scope' &&
        !(item !== undefined && matchesAt(CUSTOM_PROPERTY_START, body, item.start))
      ) {
        diagnostics.error(
          'sfc.scope_selector',
          'In <style scoped>, & outside a rule is the element the component is mounted in, not its root; select the root by its class or tag',
          base + at,
          base + at + 1,
        );
      }
      at += 1;
    } else if (isNameStart(char) && !isNameChar(body[at - 1]) && body[at - 1] !== '\\') {
      const end = nameEnd(body, at);
      if (body[end] !== '(') {
        at = end;
      } else {
        let content = end + 1;
        while (isWhitespace(body[content] ?? '')) content += 1;
        const quoted = body[content] === '"' || body[content] === "'";
        if (body.slice(at, end).toLowerCase() === 'url' && !quoted) {
          const close = urlEnd(body, content);
          if (close === -1) {
            unbalanced('This url( is not closed', at, end + 1);
            return;
          }
          at = close;
        } else {
          stack.push({ char: '(', start: at, end: end + 1 });
          at = end + 1;
        }
      }
    } else if (char === '{') {
      const item = level.item;
      if (
        atLevel &&
        item !== undefined &&
        (item.declaration ||
          (item.atRule === undefined && matchesAt(CUSTOM_PROPERTY_START, body, item.start)))
      ) {
        if (!item.declaration) outsideRule(level.context, item.start, at);
        item.declaration = true;
        stack.push({ char, start: at, end: at + 1 });
      } else if (atLevel) {
        // A rule list of `declarations` tracks no construct, so `item` is unset there only.
        const opened: RuleLevel = {
          context:
            item === undefined ? 'declarations' : blockContext(level.context, item, body, at),
          item: undefined,
        };
        levels.push(opened);
        stack.push({ char, start: at, end: at + 1, level: opened });
      } else {
        stack.push({ char, start: at, end: at + 1 });
      }
      at += 1;
    } else if (char === '(' || char === '[') {
      stack.push({ char, start: at, end: at + 1 });
      at += 1;
    } else if (char === '}' || char === ')' || char === ']') {
      const open = stack.pop();
      if (open === undefined || open.char !== OPENERS[char]) {
        unbalanced('This bracket closes nothing that is open here', at, at + 1);
        return;
      }
      if (open.level !== undefined) {
        unfinished(open.level, tokenEnd);
        levels.pop();
        (levels.at(-1) as RuleLevel).item = undefined;
      }
      at += 1;
    } else if (char === ';') {
      const item = level.item;
      if (atLevel && level.context !== 'declarations') {
        level.item = undefined;
        if (item === undefined) {
          if (level.context === 'rules') {
            incomplete(
              'This ; ends nothing: outside a rule it becomes part of the next selector',
              at,
              at + 1,
            );
          }
        } else if (item.atRule === undefined && !item.declaration) {
          if (matchesAt(DECLARATION_START, body, item.start)) {
            outsideRule(level.context, item.start, at + 1);
          } else {
            incomplete(NOT_A_RULE, item.start, at + 1);
          }
        }
      }
      at += 1;
    } else {
      at += 1;
    }
    tokenEnd = at;
  }
  const open = stack.at(-1);
  if (open !== undefined) {
    unbalanced('This bracket is not closed', open.start, open.end);
    return;
  }
  unfinished(root, tokenEnd);
}

function checkAtRule(
  name: string,
  start: number,
  end: number,
  scoped: boolean,
  diagnostics: SfcDiagnostics,
): void {
  if (STATEMENT_RULES.has(name)) {
    diagnostics.error(
      'sfc.style_at_rule',
      'Component styles are joined into one stylesheet, where this at-rule is ignored; import a stylesheet from <script> instead',
      start,
      end,
    );
  } else if (scoped && DOCUMENT_RULES.has(name)) {
    diagnostics.error(
      'sfc.scoped_global_rule',
      'This at-rule defines a document-wide name that no scope limits; write it in a <style> block',
      start,
      end,
    );
  }
}
