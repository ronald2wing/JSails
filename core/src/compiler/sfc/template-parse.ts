/**
 * The HTML-correct parser for the `<template>` blocks of a `.jsails` file
 * (sfc-plan §2.4 with the corrections of docs/design/sfc.md §9).
 *
 * Text is literal: `{`, `}` and a `>` are text, entities are decoded, and a
 * `<` starts a tag only before a letter, `/` or `!`. Void elements may omit
 * `/>`; any element may self-close. Comments are dropped. `{{ }}` is ended by
 * oxc expression parsing, so it is string- and template-literal-aware.
 * Attributes are plain (`name="text"`), bound (`:name`), events (`@event`),
 * slots (`#name`) or `js-*` directives, validated against the directive table.
 * A `js-pre` subtree is raw: no interpolation, no directives, whitespace kept,
 * and the element must be preceded by `<!-- prettier-ignore -->`, because
 * Prettier would otherwise reformat it. Whitespace follows Prettier's
 * significance rule (`whitespace.ts`).
 *
 * The parser never throws on input: every problem is a positioned, value-free
 * diagnostic, and it recovers (a missing end tag closes at its ancestor's, a
 * stray end tag is skipped) so one pass reports every error it can. Removed
 * syntax (`{expr}` text and attributes, `js-bind:x`, `js-on:x`, `js-submit`,
 * `js-call`, `js-intersect`, `js-visible`, `js-content`, `js-once`, `js-is`,
 * Vue's `v-*`) is reported with a fix.
 */

import {
  EVENT_MODIFIERS,
  HYDRATE_TRIGGERS,
  REMOVED_DIRECTIVE_PREFIXES,
  REMOVED_DIRECTIVES,
  directiveSpec,
  type DirectiveSpec,
} from '../directives.js';
import type { SfcDiagnostics, SfcEdit } from './diagnostics.js';
import {
  checkExpression,
  checkParameters,
  checkStatements,
  findInterpolationEnd,
} from './expressions.js';
import {
  DISPLAY_OVERRIDE_COMMENT,
  FORBIDDEN_TEMPLATE_ELEMENTS,
  LEADING_NEWLINE_ELEMENTS,
  TEXT_ONLY_ELEMENTS,
  VOID_ELEMENTS,
  closesParent,
  elementDisplay,
  keepsWhitespace,
  type ElementNamespace,
} from './html-elements.js';
import { readCharacterReference } from './html-entities.js';
import {
  findBinding,
  findDirective,
  isComponentTag,
  type DirectiveAttribute,
  type DirectiveValue,
  type ElementNode,
  type InterpolationNode,
  type SlotAttribute,
  type TemplateAttribute,
  type TemplateExpression,
  type TemplateNode,
  type TemplateRoot,
} from './template-ast.js';
import {
  condenseChildren,
  type ElementItem,
  type TextPart,
  type WhitespaceItem,
} from './whitespace.js';

/** The result of parsing one `<template>` block's content. */
export interface TemplateBlockParse {
  readonly root: TemplateRoot;
  /** The block's `</template>`, or `null` when the file ended first. */
  readonly closeTag: { readonly start: number; readonly end: number } | null;
}

/**
 * Parse the content of a `<template>` block that starts at `contentStart` (just
 * past the start tag's `>`) up to its own `</template>`, counting nested
 * `<template>` elements. Diagnostics go to `diagnostics`; offsets are offsets
 * into `source`, the whole file.
 */
export function parseTemplateBlock(
  source: string,
  contentStart: number,
  diagnostics: SfcDiagnostics,
): TemplateBlockParse {
  const parser = new TemplateParser(source, diagnostics);
  return parser.parseBlock(contentStart);
}

const HTML_WHITESPACE = /[ \t\n\f\r]/;
const TAG_NAME = /[A-Za-z][^\s/>]*/y;
const VALID_TAG_NAME = /^[A-Za-z][A-Za-z0-9_-]*(?:[.:][A-Za-z][A-Za-z0-9_-]*)*$/;
const ATTRIBUTE_NAME = /[^\s/>=]+/y;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const LEGACY_TEXT_INTERPOLATION = /\{[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\}/y;
const PLAIN_TEXT = /[^<&{]+/y;
/** Elements whose text is code or sample output, where `{name}` is not legacy syntax. */
const LITERAL_BRACE_ELEMENTS: ReadonlySet<string> = new Set(['code', 'pre', 'kbd', 'samp']);

interface Comment {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

interface ParentContext {
  /** The parent's tag, or `null` for the block root. */
  readonly tag: string | null;
  readonly display: string;
  /** The namespace this parent's children are in. */
  readonly namespace: ElementNamespace;
  /** Inside an svg `<foreignObject>`, where every element's display comes from the table. */
  readonly inForeignObject: boolean;
  readonly raw: boolean;
  readonly keepWhitespace: boolean;
  /** Inside `<code>`, `<pre>` and similar: braces in text are not legacy syntax. */
  readonly literalBraces: boolean;
  /** The parent is a component, so a child `<template #slot>` is legal. */
  readonly component: boolean;
  /** Tags of the open elements, outermost first; `template` for the block root. */
  readonly ancestors: readonly string[];
}

type CloseReason =
  | { readonly kind: 'own'; readonly start: number; readonly end: number }
  | { readonly kind: 'block'; readonly start: number; readonly end: number }
  | { readonly kind: 'ancestor' }
  | { readonly kind: 'eof' };

interface RawValue {
  /** The value as written, without quotes. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly quoted: boolean;
  /** Written as `name={…}`, the removed JSX-style binding. */
  readonly legacyBrace: boolean;
}

interface RawAttribute {
  readonly name: string;
  readonly start: number;
  readonly nameEnd: number;
  readonly end: number;
  readonly value: RawValue | null;
}

interface StartTag {
  readonly attributes: readonly RawAttribute[];
  readonly selfClosing: boolean;
  readonly end: number;
  readonly closed: boolean;
}

/** Decoded attribute code and a map from decoded index to file offset. */
interface DecodedCode {
  readonly code: string;
  readonly offsetAt: (index: number) => number;
}

class TemplateParser {
  private index = 0;

  constructor(
    private readonly source: string,
    private readonly diagnostics: SfcDiagnostics,
  ) {}

  parseBlock(contentStart: number): TemplateBlockParse {
    this.index = contentStart;
    const context: ParentContext = {
      tag: null,
      display: 'block',
      namespace: 'html',
      inForeignObject: false,
      raw: false,
      keepWhitespace: false,
      literalBraces: false,
      component: false,
      ancestors: ['template'],
    };
    const { children, close } = this.parseChildren(context);
    const end = close.kind === 'block' ? close.start : this.source.length;
    return {
      root: Object.freeze({ children, start: contentStart, end }),
      closeTag:
        close.kind === 'block' ? Object.freeze({ start: close.start, end: close.end }) : null,
    };
  }

  // ---------------------------------------------------------------- children

  private parseChildren(context: ParentContext): {
    children: readonly TemplateNode[];
    close: CloseReason;
  } {
    const items: WhitespaceItem[] = [];
    let run: { start: number; end: number; parts: TextPart[] } | undefined;
    let pendingComment: Comment | undefined;

    const addText = (text: string, literal: boolean, start: number, end: number): void => {
      if (run === undefined) {
        run = { start, end, parts: [] };
      }
      run.end = end;
      run.parts.push({ text, literal });
      if (!literal || !/^[ \t\n\f\r]*$/.test(text)) {
        pendingComment = undefined;
      }
    };
    const flush = (): void => {
      if (run !== undefined) {
        items.push(Object.freeze({ kind: 'text', ...run, parts: Object.freeze(run.parts) }));
        run = undefined;
      }
    };

    let close: CloseReason = { kind: 'eof' };
    const { source } = this;
    while (this.index < source.length) {
      const at = this.index;
      const char = source[at];

      if (char === '<') {
        if (source.startsWith('<!--', at)) {
          pendingComment = this.readComment();
          continue;
        }
        if (source.startsWith('</', at) && /[A-Za-z]/.test(source[at + 2] ?? '')) {
          const reason = this.readEndTag(context);
          if (reason === undefined) {
            continue;
          }
          close = reason;
          break;
        }
        if (source[at + 1] === '!' || source[at + 1] === '?') {
          this.skipUnsupportedMarkup();
          continue;
        }
        if (/[A-Za-z]/.test(source[at + 1] ?? '')) {
          flush();
          const element = this.parseElement(context, pendingComment);
          pendingComment = undefined;
          if (element !== undefined) {
            items.push(element);
          }
          continue;
        }
        addText('<', true, at, at + 1);
        this.index += 1;
        continue;
      }

      if (char === '&') {
        this.readTextReference(addText);
        continue;
      }

      if (char === '{') {
        if (!context.raw && source.startsWith('{{', at)) {
          const interpolation = this.readInterpolation();
          if (interpolation !== undefined) {
            flush();
            pendingComment = undefined;
            items.push(interpolation);
          } else {
            addText('{{', true, at, at + 2);
          }
          continue;
        }
        if (!context.raw && !context.literalBraces) {
          this.checkLegacyTextInterpolation(at);
        }
        addText('{', true, at, at + 1);
        this.index += 1;
        continue;
      }

      PLAIN_TEXT.lastIndex = at;
      const match = PLAIN_TEXT.exec(source);
      const text = match?.[0] ?? source.charAt(at);
      addText(text, true, at, at + text.length);
      this.index += text.length;
    }
    flush();

    this.checkChains(items);
    const children = condenseChildren(items, {
      display: context.display,
      keepWhitespace: context.keepWhitespace,
    });
    return { children, close };
  }

  /** `js-else-if` and `js-else` must follow a `js-if` or `js-else-if` sibling. */
  private checkChains(items: readonly WhitespaceItem[]): void {
    let open = false;
    for (const item of items) {
      if (item.kind === 'text') {
        if (item.parts.some((part) => !part.literal || !/^[ \t\n\f\r]*$/.test(part.text))) {
          open = false;
        }
        continue;
      }
      if (item.kind === 'interpolation') {
        open = false;
        continue;
      }
      if (item.continuesChain && !open && findDirective(item.node, 'js-if') === undefined) {
        const branch =
          findDirective(item.node, 'js-else-if') ?? findDirective(item.node, 'js-else');
        if (branch !== undefined) {
          this.diagnostics.error(
            'sfc.stray_else',
            'An else branch must directly follow an element with js-if or js-else-if',
            branch.start,
            branch.nameEnd,
          );
        }
      }
      open = item.opensChain;
    }
  }

  // ---------------------------------------------------------------- comments, markup

  private readComment(): Comment {
    const start = this.index;
    const close = this.source.indexOf('-->', start + 4);
    if (close === -1) {
      this.diagnostics.error(
        'sfc.unclosed_comment',
        'Comment is not closed with -->',
        start,
        start + 4,
      );
      this.index = this.source.length;
      return { value: this.source.slice(start + 4), start, end: this.index };
    }
    this.index = close + 3;
    return { value: this.source.slice(start + 4, close), start, end: this.index };
  }

  private skipUnsupportedMarkup(): void {
    const start = this.index;
    const close = this.source.indexOf('>', start);
    this.index = close === -1 ? this.source.length : close + 1;
    this.diagnostics.error(
      'sfc.unsupported_markup',
      'Doctypes, CDATA sections and processing instructions are not allowed in a template',
      start,
      this.index,
    );
  }

  // ---------------------------------------------------------------- text

  private readTextReference(
    addText: (text: string, literal: boolean, start: number, end: number) => void,
  ): void {
    const at = this.index;
    const reference = readCharacterReference(this.source, at, this.source.length, false);
    if (reference === undefined) {
      addText('&', true, at, at + 1);
      this.index += 1;
      return;
    }
    this.index = reference.end;
    if (reference.value !== undefined) {
      addText(reference.value, false, at, reference.end);
      return;
    }
    this.reportReference(reference.start, reference.end, reference.problem);
    addText(this.source.slice(at, reference.end), true, at, reference.end);
  }

  private reportReference(
    start: number,
    end: number,
    problem: 'unknown' | 'missing_semicolon' | undefined,
  ): void {
    if (problem === 'missing_semicolon') {
      this.diagnostics.error(
        'sfc.entity_missing_semicolon',
        'Character reference must end with a semicolon',
        start,
        end,
        { fix: { message: 'Add the semicolon', edits: [{ start: end, end, text: ';' }] } },
      );
      return;
    }
    this.diagnostics.error('sfc.unknown_entity', 'Unknown character reference', start, end, {
      fix: {
        message: 'Escape the ampersand as &amp;',
        edits: [{ start, end: start + 1, text: '&amp;' }],
      },
    });
  }

  /** `{name}` in text is the removed single-brace interpolation; text stays literal. */
  private checkLegacyTextInterpolation(at: number): void {
    LEGACY_TEXT_INTERPOLATION.lastIndex = at;
    const match = LEGACY_TEXT_INTERPOLATION.exec(this.source);
    if (match === null) {
      return;
    }
    const end = at + match[0].length;
    if (this.source[end] === '}') {
      return;
    }
    this.diagnostics.warn(
      'sfc.legacy_syntax',
      'Single braces are literal text; interpolation is written {{ expression }}',
      at,
      end,
      {
        fix: {
          message: 'Use {{ }} interpolation',
          edits: [
            { start: at, end: at + 1, text: '{{ ' },
            { start: end - 1, end, text: ' }}' },
          ],
        },
      },
    );
  }

  private readInterpolation(): InterpolationNode | undefined {
    const start = this.index;
    const codeStart = start + 2;
    const found = findInterpolationEnd(this.source, codeStart, this.source.length);
    if (found.kind === 'unterminated') {
      this.diagnostics.error(
        'sfc.unterminated_interpolation',
        'Interpolation has no closing }}',
        start,
        codeStart,
      );
      this.index = codeStart;
      return undefined;
    }
    const end = found.closeAt + 2;
    this.index = end;
    if (found.kind === 'empty') {
      this.diagnostics.error('sfc.empty_expression', 'Interpolation is empty', start, end);
      return undefined;
    }
    if (found.kind === 'invalid') {
      // An error at the end (an unfinished expression) points at the closing }}.
      const at = Math.min(found.offset, found.closeAt);
      this.diagnostics.error(
        'sfc.invalid_expression',
        'Interpolation is not a valid TypeScript expression',
        at,
        at < found.closeAt ? at + 1 : end,
      );
      return undefined;
    }
    return Object.freeze({
      kind: 'interpolation',
      expression: trimmedExpression(this.source, codeStart, found.closeAt),
      start,
      end,
    });
  }

  // ---------------------------------------------------------------- end tags

  /**
   * Read an end tag at `this.index` and decide what it closes. Returns
   * `undefined` when the tag was consumed as an error and parsing continues.
   */
  private readEndTag(context: ParentContext): CloseReason | undefined {
    const start = this.index;
    TAG_NAME.lastIndex = start + 2;
    const name = TAG_NAME.exec(this.source)?.[0] ?? '';
    const nameEnd = start + 2 + name.length;
    const gt = this.source.indexOf('>', nameEnd);
    const end = gt === -1 ? this.source.length : gt + 1;
    const between = this.source.slice(nameEnd, gt === -1 ? end : gt);

    const closesOwn = context.tag !== null && name === context.tag;
    const closesBlock = context.tag === null && name === 'template';
    const closesAncestor = !closesOwn && !closesBlock && context.ancestors.includes(name);
    if (closesAncestor) {
      return { kind: 'ancestor' };
    }
    if (gt === -1) {
      this.diagnostics.error('sfc.unclosed_start_tag', 'End tag is not closed with >', start, end);
    } else if (between.trim() !== '') {
      this.diagnostics.error(
        'sfc.end_tag_attribute',
        'An end tag cannot have attributes',
        nameEnd,
        gt,
        { fix: { message: 'Remove the text', edits: [{ start: nameEnd, end: gt, text: '' }] } },
      );
    }
    this.index = end;
    if (closesOwn) {
      return { kind: 'own', start, end };
    }
    if (closesBlock) {
      return { kind: 'block', start, end };
    }
    const deletion = { message: 'Remove the end tag', edits: [{ start, end, text: '' }] };
    if (VOID_ELEMENTS.has(name)) {
      this.diagnostics.error('sfc.void_end_tag', 'A void element has no end tag', start, end, {
        fix: deletion,
      });
    } else {
      this.diagnostics.error(
        'sfc.unexpected_end_tag',
        'End tag does not match an open element',
        start,
        end,
        { fix: deletion },
      );
    }
    return undefined;
  }

  // ---------------------------------------------------------------- elements

  private parseElement(
    parent: ParentContext,
    pendingComment: Comment | undefined,
  ): ElementItem | undefined {
    const { source } = this;
    const start = this.index;
    TAG_NAME.lastIndex = start + 1;
    const tag = TAG_NAME.exec(source)?.[0] ?? '';
    const tagEnd = start + 1 + tag.length;
    if (!VALID_TAG_NAME.test(tag)) {
      this.diagnostics.error('sfc.invalid_tag_name', 'Tag name is not valid', start + 1, tagEnd);
    }
    this.index = tagEnd;
    const startTag = this.readStartTag(start);
    const startTagEnd = startTag.end;

    if (FORBIDDEN_TEMPLATE_ELEMENTS.has(tag)) {
      this.diagnostics.error(
        'sfc.forbidden_tag',
        'A template cannot contain <script> or <style>; use the component blocks',
        start,
        startTagEnd,
      );
      if (startTag.closed && !startTag.selfClosing) {
        this.skipRawText(tag);
      }
      return undefined;
    }

    const isRawRoot =
      !parent.raw && startTag.attributes.some((attribute) => attribute.name === 'js-pre');
    const raw = parent.raw || isRawRoot;
    const namespace: ElementNamespace = tag === 'svg' ? 'svg' : parent.namespace;
    if (parent.tag !== null && namespace === 'html' && closesParent(parent.tag, tag)) {
      this.diagnostics.error(
        'sfc.invalid_nesting',
        'HTML ends the parent element at this start tag, so this element cannot be nested in it',
        start,
        tagEnd,
      );
    }
    const override =
      pendingComment === undefined
        ? undefined
        : DISPLAY_OVERRIDE_COMMENT.exec(pendingComment.value)?.[1];
    const inForeignObject =
      parent.inForeignObject || (tag === 'foreignObject' && namespace === 'svg');
    const display = elementDisplay(tag, namespace, inForeignObject, override);
    const attributes = this.classifyAttributes(startTag.attributes, raw, isRawRoot);

    if (isRawRoot && pendingComment?.value.trim() !== 'prettier-ignore') {
      this.reportMissingPrettierIgnore(start);
    }

    let children: readonly TemplateNode[] = [];
    let endTag: { start: number; end: number } | null = null;
    let end = startTagEnd;
    const isVoid = VOID_ELEMENTS.has(tag);
    if (startTag.closed && !startTag.selfClosing && !isVoid) {
      if (LEADING_NEWLINE_ELEMENTS.has(tag)) {
        this.skipLeadingNewline();
      }
      const childContext: ParentContext = {
        tag,
        display,
        namespace: tag === 'foreignObject' && namespace === 'svg' ? 'html' : namespace,
        inForeignObject,
        raw,
        keepWhitespace: parent.keepWhitespace || raw || keepsWhitespace(tag),
        literalBraces: parent.literalBraces || LITERAL_BRACE_ELEMENTS.has(tag),
        component: isComponentTag(tag) || tag === 'component',
        ancestors: [...parent.ancestors, tag],
      };
      // An svg <title> holds elements; HTML's <title> and <textarea> hold text.
      const textOnly = TEXT_ONLY_ELEMENTS.has(tag) && !(tag === 'title' && namespace === 'svg');
      const parsed = textOnly
        ? this.parseTextOnlyChildren(childContext)
        : this.parseChildren(childContext);
      children = parsed.children;
      if (parsed.close.kind === 'own') {
        endTag = { start: parsed.close.start, end: parsed.close.end };
        end = parsed.close.end;
      } else {
        end = this.index;
        this.diagnostics.error(
          'sfc.missing_end_tag',
          'Element has no end tag',
          start,
          startTagEnd,
          {
            fix: { message: 'Add the end tag', edits: [{ start: end, end, text: `</${tag}>` }] },
          },
        );
      }
    }

    const node: ElementNode = Object.freeze({
      kind: 'element',
      tag,
      start,
      end,
      startTagEnd,
      endTag: endTag === null ? null : Object.freeze(endTag),
      selfClosing: startTag.selfClosing,
      attributes,
      children,
      raw,
    });
    if (!raw) {
      this.checkElement(node, parent);
    }
    const hasIf = findDirective(node, 'js-if') !== undefined;
    const hasElseIf = findDirective(node, 'js-else-if') !== undefined;
    const hasElse = findDirective(node, 'js-else') !== undefined;
    return Object.freeze({
      kind: 'element',
      node,
      display,
      preformatted: keepsWhitespace(tag),
      opensChain: hasIf || hasElseIf,
      continuesChain: hasElseIf || hasElse,
    });
  }

  private skipLeadingNewline(): void {
    if (this.source[this.index] === '\n') {
      this.index += 1;
    } else if (this.source.startsWith('\r\n', this.index)) {
      this.index += 2;
    }
  }

  /** Skip the content and end tag of a forbidden raw-text element. */
  private skipRawText(tag: string): void {
    const pattern = new RegExp(`</${tag}[\\s/>]`, 'ig');
    pattern.lastIndex = this.index;
    const match = pattern.exec(this.source);
    if (match === null) {
      this.index = this.source.length;
      return;
    }
    const gt = this.source.indexOf('>', match.index);
    this.index = gt === -1 ? this.source.length : gt + 1;
  }

  /** Children of `<textarea>` and `<title>`: text and interpolations up to the end tag. */
  private parseTextOnlyChildren(context: ParentContext): {
    children: readonly TemplateNode[];
    close: CloseReason;
  } {
    const items: WhitespaceItem[] = [];
    let run: { start: number; end: number; parts: TextPart[] } | undefined;
    const addText = (text: string, literal: boolean, start: number, end: number): void => {
      if (run === undefined) {
        run = { start, end, parts: [] };
      }
      run.end = end;
      run.parts.push({ text, literal });
    };
    const flush = (): void => {
      if (run !== undefined) {
        items.push(Object.freeze({ kind: 'text', ...run, parts: Object.freeze(run.parts) }));
        run = undefined;
      }
    };
    const endPattern = new RegExp(`</${context.tag ?? ''}[\\s/>]`, 'iy');
    let close: CloseReason = { kind: 'eof' };
    while (this.index < this.source.length) {
      const at = this.index;
      endPattern.lastIndex = at;
      if (endPattern.test(this.source)) {
        const gt = this.source.indexOf('>', at);
        const end = gt === -1 ? this.source.length : gt + 1;
        this.index = end;
        close = { kind: 'own', start: at, end };
        break;
      }
      if (this.source[at] === '&') {
        this.readTextReference(addText);
        continue;
      }
      if (!context.raw && this.source.startsWith('{{', at)) {
        const interpolation = this.readInterpolation();
        if (interpolation !== undefined) {
          flush();
          items.push(interpolation);
        } else {
          addText('{{', true, at, at + 2);
        }
        continue;
      }
      addText(this.source[at] ?? '', true, at, at + 1);
      this.index += 1;
    }
    flush();
    return {
      children: condenseChildren(items, {
        display: context.display,
        keepWhitespace: context.keepWhitespace,
      }),
      close,
    };
  }

  // ---------------------------------------------------------------- start tags and attributes

  private readStartTag(elementStart: number): StartTag {
    const { source } = this;
    const attributes: RawAttribute[] = [];
    for (;;) {
      while (this.index < source.length && HTML_WHITESPACE.test(source[this.index] ?? '')) {
        this.index += 1;
      }
      const at = this.index;
      if (at >= source.length || source[at] === '<') {
        this.diagnostics.error(
          'sfc.unclosed_start_tag',
          'Start tag is not closed with >',
          elementStart,
          at,
        );
        return { attributes, selfClosing: false, end: at, closed: false };
      }
      if (source[at] === '>') {
        this.index += 1;
        return { attributes, selfClosing: false, end: this.index, closed: true };
      }
      if (source.startsWith('/>', at)) {
        this.index += 2;
        return { attributes, selfClosing: true, end: this.index, closed: true };
      }
      if (source[at] === '/') {
        this.index += 1;
        continue;
      }
      const attribute = this.readAttribute();
      if (attribute !== undefined) {
        attributes.push(attribute);
      }
    }
  }

  private readAttribute(): RawAttribute | undefined {
    const { source } = this;
    const start = this.index;
    ATTRIBUTE_NAME.lastIndex = start;
    let name = ATTRIBUTE_NAME.exec(source)?.[0] ?? '';
    if (name === '') {
      // A lone `=`: HTML makes it part of a name; here it is an error.
      name = source[start] ?? '';
    }
    const nameEnd = start + name.length;
    this.index = nameEnd;
    const badName = /["'<=]/.test(name);

    let cursor = nameEnd;
    while (cursor < source.length && HTML_WHITESPACE.test(source[cursor] ?? '')) {
      cursor += 1;
    }
    let value: RawValue | null = null;
    if (source[cursor] === '=') {
      cursor += 1;
      while (cursor < source.length && HTML_WHITESPACE.test(source[cursor] ?? '')) {
        cursor += 1;
      }
      value = this.readAttributeValue(cursor);
    }
    const end = this.index;
    if (badName) {
      this.diagnostics.error(
        'sfc.invalid_attribute',
        'Attribute name is not valid',
        start,
        nameEnd,
      );
      return undefined;
    }
    return { name, start, nameEnd, end, value };
  }

  private readAttributeValue(at: number): RawValue | null {
    const { source } = this;
    const quote = source[at];
    if (quote === '"' || quote === "'") {
      const close = source.indexOf(quote, at + 1);
      if (close === -1) {
        this.diagnostics.error(
          'sfc.invalid_attribute',
          'Attribute value has no closing quote',
          at,
          source.length,
        );
        this.index = source.length;
        return null;
      }
      this.index = close + 1;
      return {
        text: source.slice(at + 1, close),
        start: at + 1,
        end: close,
        quoted: true,
        legacyBrace: false,
      };
    }
    if (quote === '{') {
      const close = matchingBrace(source, at);
      if (close !== -1) {
        this.index = close + 1;
        return {
          text: source.slice(at + 1, close),
          start: at + 1,
          end: close,
          quoted: false,
          legacyBrace: true,
        };
      }
    }
    let end = at;
    while (end < source.length && !/[\s>]/.test(source[end] ?? '')) {
      end += 1;
    }
    this.index = end;
    if (end === at) {
      this.diagnostics.error('sfc.invalid_attribute', 'Attribute value is missing', at, at);
      return null;
    }
    const text = source.slice(at, end);
    if (/["'<=`]/.test(text)) {
      this.diagnostics.error(
        'sfc.invalid_attribute',
        'An unquoted attribute value cannot contain quotes, <, = or `',
        at,
        end,
      );
      return null;
    }
    return { text, start: at, end, quoted: false, legacyBrace: false };
  }

  private classifyAttributes(
    raws: readonly RawAttribute[],
    raw: boolean,
    isRawRoot: boolean,
  ): readonly TemplateAttribute[] {
    const out: TemplateAttribute[] = [];
    const seen = new Map<string, RawAttribute>();
    for (const attribute of raws) {
      const classified =
        raw && !(isRawRoot && attribute.name === 'js-pre')
          ? this.staticAttribute(attribute)
          : this.classifyAttribute(attribute);
      if (classified === undefined) {
        continue;
      }
      const key = attributeKey(classified);
      if (key !== undefined) {
        const first = seen.get(key);
        if (first !== undefined) {
          this.diagnostics.error(
            'sfc.duplicate_attribute',
            'Attribute is set twice on one element',
            attribute.start,
            attribute.end,
            {
              related: { message: 'First set here', start: first.start, end: first.end },
              fix: { message: 'Remove the repeated attribute', edits: [this.deletion(attribute)] },
            },
          );
          continue;
        }
        seen.set(key, attribute);
      }
      out.push(classified);
    }
    return Object.freeze(out);
  }

  /** The edit removing an attribute together with the whitespace before it. */
  private deletion(attribute: { readonly start: number; readonly end: number }): SfcEdit {
    let start = attribute.start;
    while (start > 0 && HTML_WHITESPACE.test(this.source[start - 1] ?? '')) {
      start -= 1;
    }
    return { start, end: attribute.end, text: '' };
  }

  private staticAttribute(attribute: RawAttribute): TemplateAttribute {
    const value = attribute.value === null ? null : this.decodeStaticValue(attribute.value);
    return Object.freeze({
      kind: 'static',
      name: attribute.name,
      value,
      start: attribute.start,
      end: attribute.end,
      nameEnd: attribute.nameEnd,
    });
  }

  private decodeStaticValue(value: RawValue): string {
    let out = '';
    let index = value.start;
    while (index < value.end) {
      const char = this.source[index];
      if (char === '\r') {
        out += '\n';
        index += this.source[index + 1] === '\n' ? 2 : 1;
        continue;
      }
      if (char === '&') {
        const reference = readCharacterReference(this.source, index, value.end, true);
        if (reference !== undefined) {
          if (reference.value === undefined) {
            this.reportReference(reference.start, reference.end, reference.problem);
            out += this.source.slice(index, reference.end);
          } else {
            out += reference.value;
          }
          index = reference.end;
          continue;
        }
      }
      out += char;
      index += 1;
    }
    return out;
  }

  /**
   * Decode the character references of a code-valued attribute, as HTML decodes
   * every attribute value (`:x="a &amp;&amp; b"` is `a && b`; Prettier writes
   * `&quot;` when a value holds both quotes). Attribute-mode rules apply, so
   * `a&b` and `'?x=1&copy=2'` stay as written; a malformed reference stays as
   * written too and is left for the TypeScript check to judge.
   */
  private decodeCode(value: RawValue): DecodedCode {
    const raw = value.text;
    if (!raw.includes('&')) {
      return { code: raw, offsetAt: (index) => value.start + index };
    }
    const offsets: number[] = [];
    let code = '';
    let index = value.start;
    while (index < value.end) {
      if (this.source[index] === '&') {
        const reference = readCharacterReference(this.source, index, value.end, true);
        if (reference?.value !== undefined) {
          for (let unit = 0; unit < reference.value.length; unit += 1) {
            offsets.push(index);
          }
          code += reference.value;
          index = reference.end;
          continue;
        }
      }
      offsets.push(index);
      code += this.source[index] ?? '';
      index += 1;
    }
    return {
      code,
      offsetAt: (position) =>
        position >= offsets.length ? value.end : (offsets[position] ?? value.end),
    };
  }

  /** The expression for `decoded.code[from, to)`, trimmed of surrounding whitespace. */
  private expressionOf(decoded: DecodedCode, from: number, to: number): TemplateExpression {
    let start = from;
    let end = to;
    while (start < end && /\s/.test(decoded.code[start] ?? '')) start += 1;
    while (end > start && /\s/.test(decoded.code[end - 1] ?? '')) end -= 1;
    const fileStart = decoded.offsetAt(start);
    const fileEnd = start === end ? fileStart : decoded.offsetAt(end);
    const code = decoded.code.slice(start, end);
    return Object.freeze({
      code,
      start: fileStart,
      end: fileEnd,
      verbatim: this.source.slice(fileStart, fileEnd) === code,
    });
  }

  private reportCodeError(
    decoded: DecodedCode,
    from: number,
    errorIndex: number,
    message: string,
  ): void {
    const offset = decoded.offsetAt(from + errorIndex);
    this.diagnostics.error('sfc.invalid_expression', message, offset, offset + 1);
  }

  /** A bound value as one TypeScript expression, or `undefined` after a diagnostic. */
  private boundExpression(value: RawValue): TemplateExpression | undefined {
    const decoded = this.decodeCode(value);
    if (decoded.code.trim() === '') {
      this.diagnostics.error(
        'sfc.empty_expression',
        'Bound value is empty',
        value.start,
        value.end,
      );
      return undefined;
    }
    const error = checkExpression(decoded.code, 0);
    if (error !== undefined) {
      this.reportCodeError(decoded, 0, error.offset, 'Value is not a valid TypeScript expression');
      return undefined;
    }
    return this.expressionOf(decoded, 0, decoded.code.length);
  }

  private classifyAttribute(attribute: RawAttribute): TemplateAttribute | undefined {
    const { name } = attribute;
    if (attribute.value?.legacyBrace === true) {
      return this.legacyBraceAttribute(attribute);
    }
    if (name.startsWith('v-')) {
      this.reportVueSyntax(attribute);
      return undefined;
    }
    if (name.startsWith(':')) {
      return this.bindAttribute(attribute);
    }
    if (name.startsWith('@')) {
      return this.eventAttribute(attribute);
    }
    if (name.startsWith('#')) {
      return this.slotAttribute(attribute);
    }
    if (name.startsWith('js-')) {
      return this.directiveAttribute(attribute);
    }
    if (attribute.value?.text.includes('{{') === true) {
      this.reportInterpolatedAttribute(attribute);
      return undefined;
    }
    return this.staticAttribute(attribute);
  }

  private legacyBraceAttribute(attribute: RawAttribute): TemplateAttribute | undefined {
    const value = attribute.value as RawValue;
    const quote = !value.text.includes('"') ? '"' : !value.text.includes("'") ? "'" : undefined;
    const bindable = !/^[:@#]|^js-|^v-/.test(attribute.name);
    this.diagnostics.error(
      'sfc.legacy_syntax',
      'Attribute expressions are written :name="expression"',
      attribute.start,
      attribute.end,
      quote === undefined || !bindable
        ? undefined
        : {
            fix: {
              message: 'Use a bound attribute',
              edits: [
                { start: attribute.start, end: attribute.start, text: ':' },
                { start: value.start - 1, end: value.start, text: quote },
                { start: value.end, end: value.end + 1, text: quote },
              ],
            },
          },
    );
    return undefined;
  }

  private reportInterpolatedAttribute(attribute: RawAttribute): void {
    const value = attribute.value as RawValue;
    const whole = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(value.text);
    const inner = whole?.[1];
    const fixable = inner !== undefined && !inner.includes('{{') && !inner.includes('}}');
    this.diagnostics.error(
      'sfc.legacy_syntax',
      'Attributes are not interpolated; bind the value with :name="expression"',
      attribute.start,
      attribute.end,
      fixable
        ? {
            fix: {
              message: 'Use a bound attribute',
              edits: [
                { start: attribute.start, end: attribute.start, text: ':' },
                { start: value.start, end: value.end, text: inner.trim() },
              ],
            },
          }
        : undefined,
    );
  }

  private reportVueSyntax(attribute: RawAttribute): void {
    const { name, start } = attribute;
    const nameEnd = attribute.nameEnd;
    let edits: SfcEdit[] | undefined;
    if (name.startsWith('v-bind:')) {
      edits = [{ start, end: start + 'v-bind'.length, text: '' }];
    } else if (name === 'v-bind') {
      edits = [{ start, end: nameEnd, text: 'js-bind' }];
    } else if (name.startsWith('v-on:')) {
      edits = [{ start, end: start + 'v-on:'.length, text: '@' }];
    } else if (name.startsWith('v-slot:')) {
      edits = [{ start, end: start + 'v-slot:'.length, text: '#' }];
    } else if (name === 'v-slot') {
      edits = [{ start, end: nameEnd, text: '#default' }];
    } else {
      const directive = `js-${name.slice(2).split('.')[0] ?? ''}`;
      if (directiveSpec(directive) !== undefined) {
        edits = [{ start, end: start + 2, text: 'js-' }];
      }
    }
    this.diagnostics.error(
      'sfc.vue_syntax',
      'Vue directives are spelled with js-, :, @ and # in a .jsails template',
      start,
      nameEnd,
      edits === undefined ? undefined : { fix: { message: 'Use the JSails spelling', edits } },
    );
  }

  private bindAttribute(attribute: RawAttribute): TemplateAttribute | undefined {
    const [argument = '', ...modifiers] = attribute.name.slice(1).split('.');
    if (!this.checkArgument(attribute, argument)) {
      return undefined;
    }
    if (modifiers.length > 0) {
      const at = attribute.start + 1 + argument.length;
      this.diagnostics.error(
        'sfc.unknown_modifier',
        'A bound attribute takes no modifiers',
        at,
        attribute.nameEnd,
        {
          fix: {
            message: 'Remove the modifiers',
            edits: [{ start: at, end: attribute.nameEnd, text: '' }],
          },
        },
      );
      return undefined;
    }
    if (attribute.value === null) {
      this.reportMissingValue(attribute, 'A bound attribute needs an expression');
      return undefined;
    }
    const expression = this.boundExpression(attribute.value);
    if (expression === undefined) {
      return undefined;
    }
    return Object.freeze({
      kind: 'bind',
      name: argument,
      expression,
      start: attribute.start,
      end: attribute.end,
      nameEnd: attribute.nameEnd,
    });
  }

  /** The argument of `:x`, `@x` or `#x`: present and not dynamic. */
  private checkArgument(attribute: RawAttribute, argument: string): boolean {
    if (argument.startsWith('[')) {
      this.diagnostics.error(
        'sfc.dynamic_argument',
        'Dynamic attribute names are not supported',
        attribute.start,
        attribute.nameEnd,
      );
      return false;
    }
    if (argument === '') {
      this.diagnostics.error(
        'sfc.invalid_attribute',
        'The attribute needs a name after its prefix',
        attribute.start,
        attribute.nameEnd,
      );
      return false;
    }
    return true;
  }

  private reportMissingValue(attribute: RawAttribute, message: string): void {
    this.diagnostics.error('sfc.missing_value', message, attribute.start, attribute.nameEnd);
  }

  private eventAttribute(attribute: RawAttribute): TemplateAttribute | undefined {
    const [event = '', ...modifiers] = attribute.name.slice(1).split('.');
    if (!this.checkArgument(attribute, event)) {
      return undefined;
    }
    if (!this.checkModifiers(attribute, 1 + event.length, modifiers, EVENT_MODIFIERS)) {
      return undefined;
    }
    let handler: TemplateExpression | null = null;
    let handlerForm: 'expression' | 'statements' | null = null;
    if (attribute.value === null) {
      if (modifiers.length === 0) {
        this.reportMissingValue(attribute, 'An event attribute needs a handler');
        return undefined;
      }
    } else {
      const decoded = this.decodeCode(attribute.value);
      if (decoded.code.trim() === '') {
        this.diagnostics.error(
          'sfc.empty_expression',
          'Event handler is empty',
          attribute.value.start,
          attribute.value.end,
        );
        return undefined;
      }
      const asExpression = checkExpression(decoded.code, 0);
      const asStatements =
        asExpression === undefined ? undefined : checkStatements(decoded.code, 0);
      if (asExpression !== undefined && asStatements !== undefined) {
        this.reportCodeError(
          decoded,
          0,
          asExpression.offset,
          'Event handler is not a valid TypeScript expression or statement list',
        );
        return undefined;
      }
      handler = this.expressionOf(decoded, 0, decoded.code.length);
      handlerForm = asExpression === undefined ? 'expression' : 'statements';
    }
    return Object.freeze({
      kind: 'on',
      event,
      modifiers: Object.freeze(modifiers),
      handler,
      handlerForm,
      start: attribute.start,
      end: attribute.end,
      nameEnd: attribute.nameEnd,
    });
  }

  /** Every modifier must be one `allowed` names; reports the first that is not. */
  private checkModifiers(
    attribute: RawAttribute,
    prefixLength: number,
    modifiers: readonly string[],
    allowed: readonly string[],
  ): boolean {
    let at = attribute.start + prefixLength;
    for (const modifier of modifiers) {
      const start = at + 1;
      const end = start + modifier.length;
      if (!allowed.includes(modifier)) {
        this.diagnostics.error('sfc.unknown_modifier', 'Unknown modifier', start, end, {
          fix: { message: 'Remove the modifier', edits: [{ start: at, end, text: '' }] },
        });
        return false;
      }
      at = end;
    }
    return true;
  }

  private slotAttribute(attribute: RawAttribute): TemplateAttribute | undefined {
    const name = attribute.name.slice(1);
    if (!this.checkArgument(attribute, name)) {
      return undefined;
    }
    let params: TemplateExpression | null = null;
    if (attribute.value !== null) {
      const decoded = this.decodeCode(attribute.value);
      const error = checkParameters(decoded.code, 0);
      if (error !== undefined) {
        this.reportCodeError(decoded, 0, error.offset, 'Slot props are not a valid parameter list');
        return undefined;
      }
      params = this.expressionOf(decoded, 0, decoded.code.length);
    }
    return Object.freeze({
      kind: 'slot',
      name,
      params,
      start: attribute.start,
      end: attribute.end,
      nameEnd: attribute.nameEnd,
    });
  }

  private directiveAttribute(attribute: RawAttribute): TemplateAttribute | undefined {
    const { name, start } = attribute;
    for (const [prefix, replacement] of Object.entries(REMOVED_DIRECTIVE_PREFIXES)) {
      if (name.startsWith(prefix)) {
        this.diagnostics.error(
          'sfc.legacy_syntax',
          'This directive is removed; use the shorthand',
          start,
          attribute.nameEnd,
          {
            fix: {
              message: 'Use the shorthand',
              edits: [{ start, end: start + prefix.length, text: replacement }],
            },
          },
        );
        return undefined;
      }
    }
    const [directive = '', ...modifiers] = name.split('.');
    if (Object.hasOwn(REMOVED_DIRECTIVES, directive)) {
      const replacement = REMOVED_DIRECTIVES[directive] ?? '';
      this.diagnostics.error(
        'sfc.legacy_syntax',
        'This directive is removed',
        start,
        attribute.nameEnd,
        {
          fix:
            replacement === ''
              ? { message: 'Remove the directive', edits: [this.deletion(attribute)] }
              : {
                  message: 'Use the replacement',
                  edits: [{ start, end: start + directive.length, text: replacement }],
                },
        },
      );
      return undefined;
    }
    const spec = directiveSpec(directive);
    if (spec === undefined) {
      this.diagnostics.error(
        'sfc.unknown_directive',
        'Unknown directive',
        start,
        start + directive.length,
      );
      return undefined;
    }
    if (!this.checkModifiers(attribute, directive.length, modifiers, spec.modifiers)) {
      return undefined;
    }
    const value = this.directiveValue(attribute, spec);
    if (value === undefined) {
      return undefined;
    }
    return Object.freeze({
      kind: 'directive',
      name: directive,
      modifiers: Object.freeze(modifiers),
      value,
      start,
      end: attribute.end,
      nameEnd: attribute.nameEnd,
    });
  }

  private directiveValue(attribute: RawAttribute, spec: DirectiveSpec): DirectiveValue | undefined {
    const value = attribute.value;
    if (spec.value === 'none' || (spec.value === 'optional-name' && value === null)) {
      if (value !== null) {
        this.diagnostics.error(
          'sfc.unexpected_value',
          'This directive takes no value',
          attribute.nameEnd,
          attribute.end,
          {
            fix: {
              message: 'Remove the value',
              edits: [{ start: attribute.nameEnd, end: attribute.end, text: '' }],
            },
          },
        );
        return undefined;
      }
      return Object.freeze({ kind: 'none' });
    }
    if (value === null) {
      this.reportMissingValue(attribute, 'This directive needs a value');
      return undefined;
    }
    switch (spec.value) {
      case 'expression': {
        const expression = this.boundExpression(value);
        return expression === undefined
          ? undefined
          : Object.freeze({ kind: 'expression', expression });
      }
      case 'for':
        return this.forValue(value);
      case 'hydrate':
        return this.wordValue(value, HYDRATE_TRIGGERS, 'js-hydrate takes load, idle or visible');
      default:
        return this.nameValue(value);
    }
  }

  private nameValue(value: RawValue): DirectiveValue | undefined {
    const trimmed = value.text.trim();
    const start = value.start + value.text.indexOf(trimmed);
    if (!IDENTIFIER.test(trimmed)) {
      this.diagnostics.error(
        'sfc.invalid_name_value',
        'This directive takes a name, not an expression',
        value.start,
        value.end,
      );
      return undefined;
    }
    return Object.freeze({ kind: 'name', name: trimmed, start, end: start + trimmed.length });
  }

  private wordValue(
    value: RawValue,
    allowed: readonly string[],
    message: string,
  ): DirectiveValue | undefined {
    const trimmed = value.text.trim();
    const start = value.start + value.text.indexOf(trimmed);
    if (!allowed.includes(trimmed)) {
      this.diagnostics.error('sfc.invalid_name_value', message, value.start, value.end);
      return undefined;
    }
    return Object.freeze({ kind: 'hydrate', trigger: trimmed, start, end: start + trimmed.length });
  }

  /** `alias in source` / `alias of source`, the alias optionally parenthesized. */
  private forValue(value: RawValue): DirectiveValue | undefined {
    const decoded = this.decodeCode(value);
    const { code } = decoded;
    const separator = /\s+(in|of)\s+/g;
    for (let match = separator.exec(code); match !== null; match = separator.exec(code)) {
      const aliasEnd = match.index;
      const sourceStart = match.index + match[0].length;
      let aliasFrom = 0;
      let aliasTo = aliasEnd;
      while (aliasFrom < aliasTo && /\s/.test(code[aliasFrom] ?? '')) aliasFrom += 1;
      if (code[aliasFrom] === '(' && code[aliasTo - 1] === ')') {
        aliasFrom += 1;
        aliasTo -= 1;
      }
      const alias = code.slice(aliasFrom, aliasTo);
      const sourceCode = code.slice(sourceStart);
      if (
        checkParameters(alias, 0) === undefined &&
        sourceCode.trim() !== '' &&
        checkExpression(sourceCode, 0) === undefined
      ) {
        return Object.freeze({
          kind: 'for',
          alias: this.expressionOf(decoded, aliasFrom, aliasTo),
          keyword: match[1] === 'of' ? 'of' : 'in',
          source: this.expressionOf(decoded, sourceStart, code.length),
        });
      }
    }
    this.diagnostics.error(
      'sfc.invalid_for',
      'js-for is written "item in items", "(item, index) in items" or "n in 10"',
      value.start,
      value.end,
    );
    return undefined;
  }

  // ---------------------------------------------------------------- structure

  private reportMissingPrettierIgnore(start: number): void {
    const lineStart = this.source.lastIndexOf('\n', start - 1) + 1;
    const indent = this.source.slice(lineStart, start);
    const text = /^[ \t]*$/.test(indent)
      ? `<!-- prettier-ignore -->\n${indent}`
      : '<!-- prettier-ignore -->';
    this.diagnostics.error(
      'sfc.js_pre_needs_prettier_ignore',
      'A js-pre element must be preceded by <!-- prettier-ignore -->, or formatting would change it',
      start,
      start + 1,
      {
        fix: {
          message: 'Insert the prettier-ignore comment',
          edits: [{ start, end: start, text }],
        },
      },
    );
  }

  private checkElement(node: ElementNode, parent: ParentContext): void {
    const directives = node.attributes.filter(
      (attribute): attribute is DirectiveAttribute => attribute.kind === 'directive',
    );
    const has = (name: string): DirectiveAttribute | undefined =>
      directives.find((directive) => directive.name === name);

    const branches = ['js-if', 'js-else-if', 'js-else'].flatMap((name) => has(name) ?? []);
    if (branches.length > 1) {
      const second = branches[1] as DirectiveAttribute;
      this.diagnostics.error(
        'sfc.conflicting_directives',
        'An element takes only one of js-if, js-else-if and js-else',
        second.start,
        second.end,
      );
    }
    const loop = has('js-for');
    const condition = has('js-if');
    if (loop !== undefined && condition !== undefined) {
      this.diagnostics.error(
        'sfc.if_with_for',
        'js-if and js-for cannot share an element; move js-for to a wrapping <template>',
        condition.start,
        condition.end,
        {
          fix: {
            message: 'Move js-for to a wrapping <template>',
            edits: [
              {
                start: node.start,
                end: node.start,
                text: `<template ${this.source.slice(loop.start, loop.end)}>`,
              },
              this.deletion(loop),
              { start: node.end, end: node.end, text: '</template>' },
            ],
          },
        },
      );
    }
    const text = has('js-text');
    const html = has('js-html');
    if (text !== undefined && html !== undefined) {
      this.diagnostics.error(
        'sfc.conflicting_directives',
        'js-text and js-html cannot share an element',
        html.start,
        html.end,
      );
    }
    const content = text ?? html;
    if (content !== undefined && node.endTag !== null && hasContent(node)) {
      this.diagnostics.error(
        'sfc.directive_with_children',
        'An element with js-text or js-html has no children',
        node.startTagEnd,
        node.endTag.start,
        {
          fix: {
            message: 'Remove the children',
            edits: [{ start: node.startTagEnd, end: node.endTag.start, text: '' }],
          },
        },
      );
    }
    if (node.tag === 'template') {
      this.checkTemplateElement(node, parent);
    } else {
      for (const attribute of node.attributes) {
        if (attribute.kind === 'slot') {
          this.reportSlotPosition(attribute);
        }
      }
    }
    if (node.tag === 'component' && findBinding(node, 'is') === undefined) {
      this.diagnostics.error(
        'sfc.component_without_is',
        '<component> needs :is="component"',
        node.start,
        node.startTagEnd,
      );
    }
    if (loop !== undefined && !hasKey(node)) {
      this.diagnostics.warn(
        'sfc.for_without_key',
        'An element repeated by js-for should have a :key',
        loop.start,
        loop.end,
      );
    }
  }

  private checkTemplateElement(node: ElementNode, parent: ParentContext): void {
    const structural = node.attributes.some(
      (attribute) =>
        attribute.kind === 'slot' ||
        (attribute.kind === 'directive' &&
          ['js-if', 'js-else-if', 'js-else', 'js-for'].includes(attribute.name)),
    );
    if (!structural) {
      this.diagnostics.error(
        'sfc.bare_template',
        'A nested <template> needs js-if, js-else-if, js-else, js-for or #slot',
        node.start,
        node.startTagEnd,
      );
    }
    const looped = findDirective(node, 'js-for') !== undefined;
    for (const attribute of node.attributes) {
      const allowed =
        attribute.kind === 'slot' ||
        (attribute.kind === 'directive' &&
          ['js-if', 'js-else-if', 'js-else', 'js-for'].includes(attribute.name)) ||
        (attribute.kind === 'bind' && attribute.name === 'key' && looped);
      if (!allowed) {
        this.diagnostics.error(
          'sfc.template_attribute',
          'A <template> renders no element, so it takes only structural directives',
          attribute.start,
          attribute.end,
          { fix: { message: 'Remove the attribute', edits: [this.deletion(attribute)] } },
        );
      }
      if (attribute.kind === 'slot' && !parent.component) {
        this.reportSlotPosition(attribute);
      }
    }
  }

  private reportSlotPosition(attribute: SlotAttribute): void {
    this.diagnostics.error(
      'sfc.slot_outside_component',
      'A #slot goes on a <template> directly inside a component',
      attribute.start,
      attribute.end,
    );
  }
}

/** Whether an element has content other than whitespace. */
function hasContent(node: ElementNode): boolean {
  return node.children.some((child) => child.kind !== 'text' || child.value.trim() !== '');
}

/** Whether a looped element (or, for a `<template>`, a child element) has a key. */
function hasKey(node: ElementNode): boolean {
  const keyed = (element: ElementNode): boolean =>
    element.attributes.some(
      (attribute) =>
        (attribute.kind === 'bind' || attribute.kind === 'static') && attribute.name === 'key',
    );
  if (keyed(node)) {
    return true;
  }
  return (
    node.tag === 'template' &&
    node.children.some((child) => child.kind === 'element' && keyed(child))
  );
}

/** The duplicate-detection key of an attribute, or `undefined` when it may repeat. */
function attributeKey(attribute: TemplateAttribute): string | undefined {
  switch (attribute.kind) {
    case 'static':
      return attribute.name === 'class' || attribute.name === 'style'
        ? `static:${attribute.name}`
        : `attr:${attribute.name}`;
    case 'bind':
      return attribute.name === 'class' || attribute.name === 'style'
        ? `bind:${attribute.name}`
        : `attr:${attribute.name}`;
    case 'on':
      return `on:${attribute.event}`;
    case 'slot':
      return 'slot';
    case 'directive':
      return `directive:${attribute.name}`;
  }
}

/** The expression for the code between `start` and `end`, trimmed. */
function trimmedExpression(source: string, start: number, end: number): TemplateExpression {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(source[from] ?? '')) from += 1;
  while (to > from && /\s/.test(source[to - 1] ?? '')) to -= 1;
  return Object.freeze({ code: source.slice(from, to), start: from, end: to, verbatim: true });
}

/**
 * The offset of the `}` matching the `{` at `open`, skipping string and
 * template literals, or -1. Used only to find the extent of a removed
 * `name={…}` attribute for its fix.
 */
function matchingBrace(source: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== undefined) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    } else if (char === '>' && depth === 1 && source[index - 1] !== '=') {
      return -1;
    }
  }
  return -1;
}
