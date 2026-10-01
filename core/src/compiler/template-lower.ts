/**
 * Transitional lowering of a parsed `.jsails` template (`sfc/template-parse.ts`)
 * into the JSX of a live component's `render(state, tools)`, used by the
 * transitional emitter (`sfc-emit.ts`) until the kind lowerings replace both.
 *
 * It lowers what has one meaning in every kind: text, interpolation, plain
 * and bound attributes, `js-if` chains, `js-for` over arrays, nested
 * `<template>` fragments, `js-show`, `js-text`, `js-html`, `js-bind`, raw
 * `js-pre` subtrees, and the live render-tool directives and `@` actions.
 * Constructs whose lowering needs the kind lowerings or the `jsails/view`
 * helpers (slots, `<component :is>`, merged `class`/`style`, `js-model`
 * modifiers, `js-hydrate`) are reported as `sfc.not_lowered`, never emitted
 * as invalid TSX.
 *
 * The output keeps the template's line structure: a node or attribute starts
 * on the generated line that matches its source line, and text is emitted as
 * a string expression, so the line-granular source map stays exact and JSX's
 * own whitespace rules never touch the already-condensed text.
 */

import type { SfcDiagnostics } from './sfc/diagnostics.js';
import {
  findDirective,
  type DirectiveAttribute,
  type ElementNode,
  type TemplateAttribute,
  type TemplateNode,
} from './sfc/template-ast.js';
import { directiveSpec } from './directives.js';
import { lineStartOffsets } from './source-lines.js';

/** Inputs of {@link lowerTemplate}. */
export interface LowerContext {
  /** The whole file the template's offsets point into. */
  readonly source: string;
  readonly diagnostics: SfcDiagnostics;
}

/**
 * Lower template children to the JSX that goes inside a fragment. `from` is the
 * offset the generated text starts at: the first line of the output is the
 * source line of `from`.
 */
export function lowerTemplate(
  children: readonly TemplateNode[],
  from: number,
  context: LowerContext,
): string {
  const lowerer = new TemplateLowerer(context, from);
  lowerer.children(children);
  return lowerer.text();
}

const JSX_ATTRIBUTE_NAME = /^[A-Za-z_$][\w$]*(?:-[\w$]+)*(?::[A-Za-z_$][\w$-]*)?$/;
const IDENTIFIER_CALL = /^([A-Za-z_$][\w$]*)\s*(?:\(([\s\S]*)\))?$/;
const STRUCTURAL = new Set(['js-if', 'js-else-if', 'js-else', 'js-for', 'js-pre', 'js-text']);

/** The live render tool an `@event` lowers onto. */
const LIVE_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  submit: 'submit',
  click: 'call',
  change: 'call',
  intersect: 'intersect',
});

class TemplateLowerer {
  private readonly parts: string[] = [];
  private readonly lineStarts: readonly number[];
  private line: number;

  constructor(
    private readonly context: LowerContext,
    from: number,
  ) {
    this.lineStarts = lineStartOffsets(context.source);
    this.line = this.lineOf(from);
  }

  text(): string {
    return this.parts.join('');
  }

  private lineOf(offset: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low;
  }

  /** Emit line breaks until the output reaches the source line of `offset`. */
  private padTo(offset: number): void {
    const target = this.lineOf(offset);
    while (this.line < target) {
      this.parts.push('\n');
      this.line += 1;
    }
  }

  /** Emit code copied from the source, counting the line breaks it holds. */
  private emitCode(code: string): void {
    this.parts.push(code);
    for (const char of code) {
      if (char === '\n') {
        this.line += 1;
      }
    }
  }

  private emit(text: string): void {
    this.parts.push(text);
  }

  private notLowered(start: number, end: number, message: string): void {
    this.context.diagnostics.error('sfc.not_lowered', message, start, end);
  }

  children(nodes: readonly TemplateNode[]): void {
    let index = 0;
    while (index < nodes.length) {
      const node = nodes[index] as TemplateNode;
      if (node.kind === 'element' && !node.raw && findDirective(node, 'js-if') !== undefined) {
        index = this.chain(nodes, index);
        continue;
      }
      this.node(node);
      index += 1;
    }
  }

  private node(node: TemplateNode): void {
    this.padTo(node.start);
    if (node.kind === 'text') {
      this.emit(`{${JSON.stringify(node.value)}}`);
      return;
    }
    if (node.kind === 'interpolation') {
      this.emit('{');
      this.padTo(node.expression.start);
      this.emitCode(node.expression.code);
      this.emit('}');
      return;
    }
    if (node.raw) {
      this.rawElement(node);
      return;
    }
    const loop = findDirective(node, 'js-for');
    if (loop?.value.kind === 'for') {
      const { alias, source } = loop.value;
      this.emit('{(');
      this.emitCode(source.code);
      this.emit(').map((');
      this.emitCode(alias.code);
      this.emit(') => (');
      this.element(node);
      this.emit('))}');
      return;
    }
    // Only the reported constructs lower to `null`, which must be an expression child.
    const wrap = node.tag === 'slot' || node.tag === 'component';
    this.emit(wrap ? '{' : '');
    this.element(node);
    this.emit(wrap ? '}' : '');
  }

  /** A `js-if` / `js-else-if` / `js-else` chain as one conditional expression. */
  private chain(nodes: readonly TemplateNode[], start: number): number {
    let index = start;
    this.padTo((nodes[start] as ElementNode).start);
    this.emit('{');
    let closed = false;
    while (index < nodes.length) {
      const node = nodes[index];
      if (node?.kind !== 'element' || node.raw) {
        break;
      }
      const branch =
        index === start
          ? findDirective(node, 'js-if')
          : (findDirective(node, 'js-else-if') ?? findDirective(node, 'js-else'));
      if (branch === undefined) {
        break;
      }
      this.padTo(node.start);
      if (branch.value.kind === 'expression') {
        this.emit('(');
        this.emitCode(branch.value.expression.code);
        this.emit(') ? (');
        this.element(node);
        this.emit(') : ');
      } else {
        this.emit('(');
        this.element(node);
        this.emit(')');
        closed = true;
        index += 1;
        break;
      }
      index += 1;
    }
    if (!closed) {
      this.emit('null');
    }
    this.emit('}');
    return index;
  }

  private element(node: ElementNode): void {
    if (node.tag === 'slot') {
      this.notLowered(node.start, node.startTagEnd, '<slot> lowers with the view kinds');
      this.emit('null');
      return;
    }
    if (node.tag === 'component') {
      this.notLowered(node.start, node.startTagEnd, '<component :is> lowers with the view kinds');
      this.emit('null');
      return;
    }
    if (node.tag === 'template') {
      this.fragment(node);
      return;
    }
    const text = findDirective(node, 'js-text');
    this.emit(`<${node.tag}`);
    this.attributes(node);
    if (text?.value.kind === 'expression') {
      this.emit('>{');
      this.emitCode(text.value.expression.code);
      this.emit(`}</${node.tag}>`);
      return;
    }
    if (node.children.length === 0) {
      this.emit(' />');
      return;
    }
    this.emit('>');
    this.children(node.children);
    if (node.endTag !== null) {
      this.padTo(node.endTag.start);
    }
    this.emit(`</${node.tag}>`);
  }

  private fragment(node: ElementNode): void {
    for (const attribute of node.attributes) {
      if (attribute.kind === 'slot') {
        this.notLowered(attribute.start, attribute.end, 'Slots lower with the view kinds');
      } else if (attribute.kind === 'bind' && attribute.name === 'key') {
        this.notLowered(
          attribute.start,
          attribute.end,
          'A keyed <template> lowers with the view kinds',
        );
      }
    }
    this.emit('<>');
    this.children(node.children);
    if (node.endTag !== null) {
      this.padTo(node.endTag.start);
    }
    this.emit('</>');
  }

  private attributes(node: ElementNode): void {
    const has = (kind: 'static' | 'bind', name: string): boolean =>
      node.attributes.some((attribute) => attribute.kind === kind && attribute.name === name);
    const styled = has('static', 'style') || has('bind', 'style');
    for (const attribute of node.attributes) {
      this.padTo(attribute.start);
      if (
        attribute.kind === 'bind' &&
        (attribute.name === 'class' || attribute.name === 'style') &&
        has('static', attribute.name)
      ) {
        this.notLowered(
          attribute.start,
          attribute.end,
          'Merging a static and a bound class or style lowers with the view kinds',
        );
        continue;
      }
      if (attribute.kind === 'directive' && attribute.name === 'js-show' && styled) {
        this.notLowered(
          attribute.start,
          attribute.end,
          'Merging js-show with a style attribute lowers with the view kinds',
        );
        continue;
      }
      this.attribute(attribute);
    }
  }

  private attribute(attribute: TemplateAttribute): void {
    switch (attribute.kind) {
      case 'static':
        this.staticAttribute(attribute.name, attribute.value);
        return;
      case 'bind':
        this.emit(` ${attribute.name}={`);
        this.emitCode(attribute.expression.code);
        this.emit('}');
        return;
      case 'on':
        this.liveEvent(attribute);
        return;
      case 'slot':
        this.notLowered(attribute.start, attribute.end, 'Slots lower with the view kinds');
        return;
      case 'directive':
        this.directive(attribute);
    }
  }

  private staticAttribute(name: string, value: string | null): void {
    if (!JSX_ATTRIBUTE_NAME.test(name)) {
      this.emit(
        ` {...{${JSON.stringify(name)}: ${value === null ? "''" : JSON.stringify(value)}}}`,
      );
      return;
    }
    this.emit(value === null ? ` ${name}` : ` ${name}={${JSON.stringify(value)}}`);
  }

  private liveEvent(attribute: Extract<TemplateAttribute, { kind: 'on' }>): void {
    const tool = Object.hasOwn(LIVE_EVENTS, attribute.event)
      ? LIVE_EVENTS[attribute.event]
      : undefined;
    const handler = attribute.handler;
    const call = handler === null ? null : IDENTIFIER_CALL.exec(handler.code);
    if (tool === undefined || call === null || attribute.handlerForm !== 'expression') {
      this.context.diagnostics.error(
        'sfc.live_handler_not_action',
        'A live component handles submit, click, change and intersect with one of its actions',
        attribute.start,
        attribute.end,
      );
      return;
    }
    if (attribute.modifiers.length > 0) {
      this.notLowered(
        attribute.start,
        attribute.nameEnd,
        'Event modifiers lower with the island kind',
      );
      return;
    }
    const args = call[2]?.trim() ?? '';
    this.emit(` {...tools.${tool}(${JSON.stringify(call[1])}`);
    if (args !== '') {
      this.emit(', ');
      this.emitCode(args);
    }
    this.emit(')}');
  }

  private directive(attribute: DirectiveAttribute): void {
    if (STRUCTURAL.has(attribute.name)) {
      return;
    }
    const { value } = attribute;
    switch (attribute.name) {
      case 'js-show':
        if (value.kind === 'expression') {
          this.emit(' style={{ display: (');
          this.emitCode(value.expression.code);
          this.emit(") ? undefined : 'none' }}");
        }
        return;
      case 'js-html':
        if (value.kind === 'expression') {
          this.emit(' dangerouslySetInnerHTML={{ __html: ');
          this.emitCode(value.expression.code);
          this.emit(' }}');
        }
        return;
      case 'js-bind':
        if (value.kind === 'expression') {
          this.emit(' {...(');
          this.emitCode(value.expression.code);
          this.emit(')}');
        }
        return;
      case 'js-hydrate':
        this.notLowered(attribute.start, attribute.end, 'js-hydrate lowers with the island kind');
        return;
    }
    const tool = directiveSpec(attribute.name)?.liveTool;
    if (tool === undefined) {
      return;
    }
    if (attribute.modifiers.length > 0) {
      this.notLowered(
        attribute.start,
        attribute.nameEnd,
        'Directive modifiers lower with the live kind',
      );
      return;
    }
    switch (value.kind) {
      case 'none':
        if (attribute.name === 'js-loading') {
          this.notLowered(
            attribute.start,
            attribute.end,
            'js-loading without a name lowers with the live kind',
          );
          return;
        }
        this.emit(` {...tools.${tool}()}`);
        return;
      case 'name':
        this.emit(` {...tools.${tool}(${JSON.stringify(value.name)})}`);
        return;
      case 'expression':
        this.emit(` {...tools.${tool}(`);
        this.emitCode(value.expression.code);
        this.emit(')}');
        return;
      default:
        return;
    }
  }

  /** A `js-pre` element or one inside it: literal tags, attributes and text. */
  private rawElement(node: ElementNode): void {
    this.emit(`<${node.tag}`);
    for (const attribute of node.attributes) {
      if (attribute.kind === 'static') {
        this.staticAttribute(attribute.name, attribute.value);
      }
    }
    if (node.children.length === 0) {
      this.emit(' />');
      return;
    }
    this.emit('>');
    for (const child of node.children) {
      if (child.kind === 'element') {
        this.padTo(child.start);
        this.rawElement(child);
      } else if (child.kind === 'text') {
        this.padTo(child.start);
        this.emit(`{${JSON.stringify(child.value)}}`);
      }
    }
    if (node.endTag !== null) {
      this.padTo(node.endTag.start);
    }
    this.emit(`</${node.tag}>`);
  }
}
