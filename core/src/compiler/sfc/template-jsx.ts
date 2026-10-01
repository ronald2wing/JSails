/**
 * The lowering of a parsed `<template>` (`template-parse.ts`) to the JSX a
 * function kind returns (sfc-plan §2.4), written as mapped segments.
 *
 * Template expressions are copied Verbatim; every lowered attribute name is
 * an Alias of its source name (TypeScript reports a wrong attribute there);
 * every other generated chunk is an Atom owned by the node that produced it,
 * so a diagnostic in generated code lands on that node (docs/design/sfc.md
 * §3.3). Names stay as written: binding a free name to a prop, a kind name or
 * an import is the scope pass's job (`scope.ts`), which reads the generated
 * text this module writes.
 *
 * Text is final when it arrives (entities decoded, whitespace rule applied),
 * so it is written as JSX string expressions, out of reach of JSX's own
 * whitespace and entity rules. Generated line breaks only ever separate
 * children, where JSX drops them.
 *
 * A live component's render lowers `@click`, `@submit` and `@intersect` and
 * the live directives onto its render tools (`__tools`, sfc-plan §2.4): each
 * becomes a spread of the attribute map the tool returns, with the action or
 * field name an Alias string literal, so a typo is a TypeScript error at the
 * name. A live tag in a page renders the binding its hoisted mount filled
 * (`live-mounts.ts`).
 *
 * An island's tag in a template that renders on the server becomes an
 * `<__Island component={Tag} props={{ … }} />` mount (`jsails/view`), each
 * attribute a property of the props object whose key is an Alias of the
 * attribute's name, so a prop that cannot cross to the browser as JSON is a
 * TypeScript error on that attribute. Inside an island the template runs in
 * the browser too: `@event` sets the Preact handler prop
 * (`island-events.ts`), `js-model` spreads a `bindControl` binding, and an
 * island's tag is a plain component, hydrated by the island around it.
 *
 * What a template cannot express is reported, never emitted as invalid TSX:
 * `@event` where nothing runs in the browser, the live directives elsewhere,
 * `<slot>` in a page, an island tag in a live component, and deferred
 * hydration (`js-hydrate="idle"`), whose runtime has not landed. Raw HTML
 * enters only through `js-html`: a raw-HTML attribute is an error, and a
 * `js-bind` spread drops one at runtime.
 */

import { camelCase, type SfcKind } from '../conventions.js';
import { directiveAllowedIn, directiveSpec } from '../directives.js';
import { parseSync, Visitor } from 'rolldown/utils';
import type { SfcDiagnostics } from './diagnostics.js';
import { componentEventProp, domEventProp, handlerShape } from './island-events.js';
import type { SegmentWriter } from './segment-writer.js';
import { SpanFeature } from './segments.js';
import { dynamicScopeMarker, scopeMarker } from './style.js';
import {
  findDirective,
  isComponentTag,
  type BindAttribute,
  type DirectiveAttribute,
  type ElementNode,
  type EventAttribute,
  type SlotAttribute,
  type StaticAttribute,
  type TemplateAttribute,
  type TemplateExpression,
  type TemplateNode,
} from './template-ast.js';

/** A `jsails/view` or JSX-runtime binding generated code uses. */
export type ViewHelper =
  | 'normalizeClass'
  | 'normalizeStyle'
  | 'renderList'
  | 'bindAttributes'
  | 'bindControl'
  | 'Island'
  | 'Fragment'
  | 'JSX';

/** A `<slot>` the template renders, for the props type of a view without `defineSlots`. */
export interface SlotUse {
  /** The prop the slot reads: `children` for the default slot. */
  readonly prop: string;
  /** Whether the slot passes props (a scoped slot, a function prop). */
  readonly scoped: boolean;
}

/** What lowering a template produced besides its segments. */
export interface TemplateLowering {
  readonly helpers: ReadonlySet<ViewHelper>;
  readonly slots: readonly SlotUse[];
  /**
   * How many `.once` handlers the template has: handler `n` reads the
   * module-scope `WeakSet` {@link onceSite}`(n)`, which the kind lowering
   * declares.
   */
  readonly onceSites: number;
}

/** The module-scope set of elements a `.once` handler already ran for. */
export function onceSite(index: number): string {
  return `__once${index}`;
}

/** What an island's tag becomes, by the kind of the template it is in. */
export interface IslandRules {
  /** The tags (imported names) that resolve to an island. */
  readonly tags: ReadonlySet<string>;
  /**
   * `mount`: an `<Island>` mount, in a template that renders on the server
   * only; `component`: a plain component, inside an island; `refuse`: an
   * error, in a live component.
   */
  readonly mode: 'mount' | 'component' | 'refuse';
}

/** The props object generated code reads slots from (the function's first parameter). */
export const PROPS_PARAMETER = '__props';

/** The render tools a live component's `render` takes (its second parameter). */
export const TOOLS_PARAMETER = '__tools';

/** What a template may contain, by the kind and function it renders in. */
export interface TemplateRules {
  readonly kind: SfcKind;
  /** Whether `<slot>` is available (the function receives children). */
  readonly slots: boolean;
  /** Each mounted live tag's binding (`live-mounts.ts`); empty when none. */
  readonly mounts: ReadonlyMap<ElementNode, string>;
  /**
   * In a live component's render: lower `@` handlers and the live directives
   * onto its tools. `propUses` holds the source offsets of state-field uses
   * (the scope pass's), so `js-show="done"` on a bare field also carries the
   * client marker; it is empty on the lowering that feeds the scope pass.
   * `null` everywhere else, a live component's static form included.
   */
  readonly live: { readonly propUses: ReadonlySet<number> } | null;
  /**
   * The island tags and what they become; `null` on the lowering that feeds
   * the scope pass, which finds them, and where every island check waits.
   */
  readonly islands: IslandRules | null;
  /**
   * The component's scope id (`style.ts`), which every outermost element of
   * the template and of the content it passes to a component carries as
   * `data-s`; an outermost `<component :is>` carries it when it renders a
   * tag, not a component.
   */
  readonly scopeId: string;
}

/** The events a live template handles, and the render tool each lowers onto. */
const LIVE_EVENTS: Readonly<Record<string, 'call' | 'submit' | 'intersect'>> = Object.freeze({
  click: 'call',
  submit: 'submit',
  intersect: 'intersect',
});

/** The event modifiers a live trigger honours, and the protocol marker each writes. */
const LIVE_MODIFIERS: Readonly<Record<string, string | null>> = Object.freeze({
  prevent: null,
  once: 'data-jsails-once',
  capture: 'data-jsails-capture',
});

/** The controls `js-model` binds. */
const MODEL_TAGS: ReadonlySet<string> = new Set(['input', 'select', 'textarea']);

/**
 * An island's `js-model`: the control it drives, a radio button's own value,
 * and the control's own `@input` and `@change`, which the binding runs after
 * its own handler rather than being replaced by it or replacing it.
 */
interface IslandModel {
  readonly control: 'text' | 'number' | 'checkbox' | 'radio' | 'select';
  readonly value: StaticAttribute | BindAttribute | undefined;
  readonly handlers: readonly EventAttribute[];
}

/** The handler props a `bindControl` binding may set, which the control's own events join. */
const MODEL_EVENT_PROPS: ReadonlySet<string> = new Set(['onInput', 'onChange']);

/** The `bindControl` control of each `<input type>` an island binds; others are text. */
const MODEL_INPUT_TYPES: Readonly<Record<string, IslandModel['control'] | null>> = Object.freeze({
  checkbox: 'checkbox',
  radio: 'radio',
  number: 'number',
  range: 'number',
  file: null,
  button: null,
  submit: null,
  reset: null,
  image: null,
});

/** The `js-model` modifiers each island control takes. */
const MODEL_MODIFIERS: Readonly<Record<IslandModel['control'], readonly string[]>> = Object.freeze({
  text: ['lazy', 'trim', 'number'],
  number: ['lazy'],
  select: ['number'],
  checkbox: [],
  radio: [],
});

/**
 * What a handler reference called on `$event` is checked against and cast
 * to: a function of the event, as its prop would take it.
 */
const EVENT_HANDLER = '(event: typeof $event) => unknown';

const JSX_ATTRIBUTE_NAME = /^[A-Za-z_$][\w$]*(?:-[\w$]+)*(?::[A-Za-z_$][\w$-]*)?$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const RAW_TAG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/**
 * The attribute names that insert raw HTML. `js-html` is the one trusted-HTML
 * door, so the template never writes them as attributes, and `js-bind`
 * spreads drop them (`bindAttributes`).
 */
const RAW_HTML_ATTRIBUTES: ReadonlySet<string> = new Set(['dangerouslySetInnerHTML', 'innerHTML']);
/** The directives a function kind consumes while lowering an element's structure. */
const STRUCTURAL = new Set(['js-if', 'js-else-if', 'js-else', 'js-for', 'js-pre']);

/**
 * Write the JSX for a template block's root children: a fragment, or `null`
 * when the template is empty.
 */
export function lowerTemplateRoot(
  children: readonly TemplateNode[],
  owner: { readonly start: number; readonly end: number },
  context: { writer: SegmentWriter; rules: TemplateRules; diagnostics: SfcDiagnostics },
): TemplateLowering {
  const lowerer = new TemplateLowerer(context.writer, context.rules, context.diagnostics);
  const { writer } = context;
  if (children.length === 0) {
    writer.atom('  return null;\n', owner.start, owner.end);
  } else {
    writer.atom('  return (\n    <>', owner.start, owner.end);
    lowerer.children(children, 3);
    writer.atom('\n    </>\n  );\n', owner.start, owner.end);
  }
  return Object.freeze({
    helpers: lowerer.helpers,
    slots: Object.freeze(lowerer.slots),
    onceSites: lowerer.onceSites,
  });
}

interface Range {
  readonly start: number;
  readonly end: number;
}

/** The attributes an element's `class` is made of. */
interface ClassParts {
  readonly static: StaticAttribute | undefined;
  readonly bound: BindAttribute | undefined;
}

/** The attributes an element's `style` is made of; `js-show` comes last and wins. */
interface StyleParts {
  readonly static: StaticAttribute | undefined;
  readonly bound: BindAttribute | undefined;
  readonly show: DirectiveAttribute | undefined;
}

class TemplateLowerer {
  readonly helpers = new Set<ViewHelper>();
  readonly slots: SlotUse[] = [];
  onceSites = 0;
  private dynamicCount = 0;
  /**
   * Whether the node being written renders inside an element of this
   * template; an element that does not is outermost and carries the scope
   * marker. Content passed to a component starts outside again: it renders
   * in that component's elements, and stays this template's.
   */
  private insideElement = false;

  constructor(
    private readonly writer: SegmentWriter,
    private readonly rules: TemplateRules,
    private readonly diagnostics: SfcDiagnostics,
  ) {}

  private startTag(node: ElementNode): Range {
    return { start: node.start, end: node.startTagEnd };
  }

  private atom(text: string, owner: Range): void {
    this.writer.atom(text, owner.start, owner.end);
  }

  /** Write `content` with {@link insideElement} set to `inside`, then restore it. */
  private within(inside: boolean, content: () => void): void {
    const outer = this.insideElement;
    this.insideElement = inside;
    content();
    this.insideElement = outer;
  }

  /** The scope marker, when the element being written is outermost. */
  private marker(owner: Range): void {
    if (!this.insideElement) this.atom(scopeMarker(this.rules.scopeId), owner);
  }

  private newline(depth: number, owner: Range): void {
    this.atom(`\n${'  '.repeat(depth)}`, owner);
  }

  /** A template expression: Verbatim, or an Atom when entities were decoded. */
  private expression(expression: TemplateExpression): void {
    if (expression.verbatim) {
      this.writer.verbatim(expression.start, expression.end);
    } else {
      this.writer.atom(expression.code, expression.start, expression.end);
    }
    this.checkAwait(expression);
  }

  /** `await` belongs in `<script setup>`: a template renders in one pass. */
  private checkAwait(expression: TemplateExpression): void {
    if (!/\bawait\b/.test(expression.code)) return;
    const prefix = '(async () => (\n';
    const parsed = parseSync('expression.ts', `${prefix}${expression.code}\n));`, {
      lang: 'ts',
      sourceType: 'module',
    });
    let depth = 0;
    let found = false;
    const enter = (): void => {
      depth += 1;
    };
    const exit = (): void => {
      depth -= 1;
    };
    new Visitor({
      ArrowFunctionExpression: enter,
      'ArrowFunctionExpression:exit': exit,
      FunctionExpression: enter,
      'FunctionExpression:exit': exit,
      FunctionDeclaration: enter,
      'FunctionDeclaration:exit': exit,
      AwaitExpression() {
        if (depth === 1) found = true;
      },
    }).visit(parsed.program);
    if (found) {
      this.diagnostics.error(
        'sfc.await_in_template',
        'A template renders in one pass; await the value in <script setup>',
        expression.start,
        expression.end,
      );
    }
  }

  // ---------------------------------------------------------------- children

  /** Write a list of children, each on its own line, js-if chains folded. */
  children(nodes: readonly TemplateNode[], depth: number): void {
    let index = 0;
    while (index < nodes.length) {
      const node = nodes[index] as TemplateNode;
      if (node.kind === 'element' && !node.raw && findDirective(node, 'js-if') !== undefined) {
        this.newline(depth, this.startTag(node));
        index = this.chain(nodes, index, depth);
        continue;
      }
      this.newline(depth, node);
      this.child(node, depth);
      index += 1;
    }
  }

  private child(node: TemplateNode, depth: number): void {
    if (node.kind === 'text') {
      this.atom(`{${JSON.stringify(node.value)}}`, node);
      return;
    }
    if (node.kind === 'interpolation') {
      this.atom('{', node);
      this.expression(node.expression);
      this.atom('}', node);
      return;
    }
    if (this.isJsxForm(node)) {
      this.nodeExpression(node, depth);
      return;
    }
    this.atom('{', this.startTag(node));
    this.nodeExpression(node, depth);
    this.atom('}', this.startTag(node));
  }

  /** Whether an element lowers to a JSX element (so it needs no braces as a child). */
  private isJsxForm(node: ElementNode): boolean {
    if (node.raw) return true;
    if (this.rules.mounts.has(node)) return false;
    if (findDirective(node, 'js-for') !== undefined) return false;
    return node.tag !== 'slot' && node.tag !== 'component';
  }

  /**
   * A `js-if` / `js-else-if` / `js-else` chain starting at `nodes[start]`, as
   * one conditional expression with a `null` fallback. Returns the index past
   * the chain. Whitespace between branches is already gone (`whitespace.ts`).
   */
  private chain(nodes: readonly TemplateNode[], start: number, depth: number): number {
    const first = nodes[start] as ElementNode;
    const owner = this.startTag(first);
    this.atom('{', owner);
    let index = start;
    let closed = false;
    while (index < nodes.length) {
      const node = nodes[index];
      if (node?.kind !== 'element' || node.raw) break;
      const branch =
        index === start
          ? findDirective(node, 'js-if')
          : (findDirective(node, 'js-else-if') ?? findDirective(node, 'js-else'));
      if (branch === undefined) break;
      const branchOwner = this.startTag(node);
      if (index > start) this.newline(depth + 1, branchOwner);
      if (branch.value.kind === 'expression') {
        this.atom('(', branchOwner);
        this.expression(branch.value.expression);
        this.atom(') ? (', branchOwner);
        this.nodeExpression(node, depth + 1);
        this.atom(') :', branchOwner);
        index += 1;
        continue;
      }
      this.atom('(', branchOwner);
      this.nodeExpression(node, depth + 1);
      this.atom(')', branchOwner);
      closed = true;
      index += 1;
      break;
    }
    if (!closed) this.atom(' null', owner);
    this.atom('}', owner);
    return index;
  }

  /** An element as one expression: its `js-for` loop, or the element itself. */
  private nodeExpression(node: ElementNode, depth: number): void {
    const loop = node.raw ? undefined : findDirective(node, 'js-for');
    if (loop?.value.kind === 'for') {
      const owner = this.startTag(node);
      this.helpers.add('renderList');
      this.atom('__renderList((', owner);
      this.expression(loop.value.source);
      this.atom('), (', owner);
      this.expression(loop.value.alias);
      this.atom(') => (', owner);
      this.body(node, depth + 1);
      this.atom('))', owner);
      return;
    }
    this.body(node, depth);
  }

  /** An element without its loop. */
  private body(node: ElementNode, depth: number): void {
    const mounted = this.rules.mounts.get(node);
    if (mounted !== undefined) {
      this.atom(mounted, this.startTag(node));
    } else if (node.raw) {
      this.rawElement(node, depth);
    } else if (node.tag === 'slot') {
      this.slot(node, depth);
    } else if (node.tag === 'component') {
      this.dynamicComponent(node, depth);
    } else if (node.tag === 'template') {
      this.fragment(node, depth);
    } else if (this.islandTag(node) !== undefined) {
      this.island(node, this.islandTag(node) as 'mount' | 'refuse');
    } else {
      this.element(node, node.tag, depth);
    }
  }

  // ---------------------------------------------------------------- islands

  /** What an island's tag lowers to here, unless it is a plain component. */
  private islandTag(node: ElementNode): 'mount' | 'refuse' | undefined {
    const islands = this.rules.islands;
    if (islands === null || islands.mode === 'component' || !islands.tags.has(node.tag)) {
      return undefined;
    }
    return islands.mode;
  }

  /**
   * An island's tag where the template renders on the server: an `<Island>`
   * mount whose props object holds the tag's attributes (static, bound and
   * `js-bind` spread), keyed by `:key`; or, in a live component, an error.
   */
  private island(node: ElementNode, mode: 'mount' | 'refuse'): void {
    const owner = this.startTag(node);
    if (mode === 'refuse') {
      this.diagnostics.error(
        'sfc.island_position',
        'A live component renders on the server on every update; mount the island from a page, a layout or a view',
        node.start,
        node.startTagEnd,
      );
      return;
    }
    const props: (() => void)[] = [];
    let key: BindAttribute | undefined;
    for (const attribute of node.attributes) {
      if (
        (attribute.kind === 'static' || attribute.kind === 'bind') &&
        RAW_HTML_ATTRIBUTES.has(attribute.name)
      ) {
        this.diagnostics.error(
          'sfc.raw_html_attribute',
          'Raw HTML is inserted with js-html, the one trusted-HTML door',
          attribute.start,
          attribute.nameEnd,
        );
        continue;
      }
      switch (attribute.kind) {
        case 'static':
          props.push(() => {
            this.propKey(attribute, attribute.start);
            this.atom(
              `: ${attribute.value === null ? 'true' : JSON.stringify(attribute.value)}`,
              attribute,
            );
          });
          break;
        case 'bind':
          if (attribute.name === 'key') {
            key = attribute;
            break;
          }
          props.push(() => {
            this.propKey(attribute, attribute.start + 1);
            this.atom(': ', attribute);
            // Written bare, so TypeScript reports a value that does not fit
            // (a function) at the author's expression; it is one property
            // because a JSX attribute's value cannot be a comma expression
            // either, which the first lowering already reports.
            this.expression(attribute.expression);
          });
          break;
        case 'on':
          this.diagnostics.error(
            'sfc.event_without_client',
            "An island's tag takes props; handle the event inside the island",
            attribute.start,
            attribute.nameEnd,
          );
          break;
        case 'slot':
          break;
        case 'directive':
          this.islandDirective(attribute, props);
      }
    }
    const first = node.children[0];
    const last = node.children[node.children.length - 1];
    if (first !== undefined && last !== undefined) {
      this.diagnostics.error(
        'sfc.island_children',
        'An island renders its own content from its props; it takes no children or slots',
        first.start,
        last.end,
      );
      return;
    }
    this.helpers.add('Island');
    this.atom('<__Island ', owner);
    if (key !== undefined) {
      this.writer.alias('key', key.start + 1, key.nameEnd);
      this.atom('={', key);
      this.expression(key.expression);
      this.atom('} ', key);
    }
    const tag = { start: node.start + 1, end: node.start + 1 + node.tag.length };
    this.atom('component={', owner);
    this.writer.verbatim(tag.start, tag.end);
    this.atom('} ', owner);
    // A prop the island requires and the tag leaves out is reported at the
    // `props` attribute: it stands for the tag's name, with no service
    // feature of its own (the name's Verbatim use has them).
    this.writer.alias('props', tag.start, tag.end, SpanFeature.None);
    this.atom('={{', owner);
    props.forEach((write, index) => {
      this.atom(index === 0 ? ' ' : ', ', owner);
      write();
    });
    this.atom(props.length === 0 ? '}} />' : ' }} />', owner);
  }

  /** A directive on an island's tag: a `js-bind` spread, `js-hydrate`, or a structural one. */
  private islandDirective(attribute: DirectiveAttribute, props: (() => void)[]): void {
    if (STRUCTURAL.has(attribute.name)) return;
    if (attribute.name === 'js-bind' && attribute.value.kind === 'expression') {
      const value = attribute.value.expression;
      props.push(() => {
        this.atom('...(', attribute);
        this.expression(value);
        this.atom(')', attribute);
      });
      return;
    }
    if (attribute.name === 'js-hydrate') {
      if (attribute.value.kind === 'hydrate' && attribute.value.trigger !== 'load') {
        this.diagnostics.error(
          'sfc.not_lowered',
          'Deferred hydration has no client runtime yet; an island hydrates on load',
          attribute.value.start,
          attribute.value.end,
        );
      }
      return;
    }
    this.reportDirectivePlacement(
      attribute,
      "An island's tag takes props, js-bind, :key, js-hydrate and the structural directives",
    );
  }

  /** An island prop's key: the attribute's prop name, an Alias of the source name. */
  private propKey(attribute: StaticAttribute | BindAttribute, nameStart: number): void {
    const name = componentPropName(attribute.name);
    this.writer.alias(
      IDENTIFIER.test(name) ? name : JSON.stringify(name),
      nameStart,
      attribute.nameEnd,
    );
  }

  // ---------------------------------------------------------------- elements

  /** `<tag …>children</tag>`, with `tag` as written (or the dynamic binding). */
  private element(node: ElementNode, tag: string, depth: number): void {
    const owner = this.startTag(node);
    const component = node.tag === 'component' || isComponentTag(node.tag);
    this.atom('<', owner);
    this.tagName(node, tag);
    this.attributes(node, component);
    if (!component) {
      this.marker(owner);
    } else if (node.tag === 'component' && !this.insideElement) {
      this.atom(dynamicScopeMarker(tag, this.rules.scopeId), owner);
    }
    const text = findDirective(node, 'js-text');
    if (text?.value.kind === 'expression') {
      this.atom('>{', owner);
      this.expression(text.value.expression);
      this.atom('}</', owner);
      this.closingName(node, tag);
      this.atom('>', owner);
      return;
    }
    if (findDirective(node, 'js-html') !== undefined) {
      this.atom(' />', owner);
      return;
    }
    if (component) {
      this.within(false, () => this.componentContent(node, tag, depth));
      return;
    }
    if (node.children.length === 0) {
      this.atom(' />', owner);
      return;
    }
    this.atom('>', owner);
    this.within(true, () => this.children(node.children, depth + 1));
    this.newline(depth, node.endTag ?? owner);
    this.atom('</', node.endTag ?? owner);
    this.closingName(node, tag);
    this.atom('>', node.endTag ?? owner);
  }

  /** The start tag's name: Verbatim when written as is, so navigation reaches it. */
  private tagName(node: ElementNode, tag: string): void {
    const start = node.start + 1;
    if (tag === node.tag) {
      this.writer.verbatim(start, start + tag.length);
    } else {
      this.atom(tag, this.startTag(node));
    }
  }

  private closingName(node: ElementNode, tag: string): void {
    const end = node.endTag;
    const start = end === null ? -1 : end.start + 2;
    if (end !== null && tag === node.tag && this.sourceAt(start, tag.length) === tag) {
      this.writer.verbatim(start, start + tag.length);
    } else {
      this.atom(tag, end ?? this.startTag(node));
    }
  }

  private sourceAt(start: number, length: number): string {
    return this.writer.text(start, start + length);
  }

  /** `<template js-if|js-for>`: a fragment, keyed when the loop gives a `:key`. */
  private fragment(node: ElementNode, depth: number): void {
    const owner = this.startTag(node);
    const key = node.attributes.find(
      (attribute): attribute is BindAttribute =>
        attribute.kind === 'bind' && attribute.name === 'key',
    );
    if (key === undefined) {
      this.atom('<>', owner);
      this.children(node.children, depth + 1);
      this.newline(depth, node.endTag ?? owner);
      this.atom('</>', node.endTag ?? owner);
      return;
    }
    this.helpers.add('Fragment');
    this.atom('<__Fragment ', owner);
    this.writer.alias('key', key.start + 1, key.nameEnd);
    this.atom('={', key);
    this.expression(key.expression);
    this.atom('}>', key);
    this.children(node.children, depth + 1);
    this.newline(depth, node.endTag ?? owner);
    this.atom('</__Fragment>', node.endTag ?? owner);
  }

  /**
   * `<component :is="expr" …>`: the element type bound to a `const` where the
   * element renders, so a literal union (`'strong' | 'em'`) keeps its literal
   * types and the expression keeps the narrowing of its position.
   */
  private dynamicComponent(node: ElementNode, depth: number): void {
    const is = node.attributes.find(
      (attribute): attribute is BindAttribute =>
        attribute.kind === 'bind' && attribute.name === 'is',
    );
    if (is === undefined) return; // `sfc.component_without_is`, reported by the parser.
    const owner = this.startTag(node);
    const binding = `__Dyn${this.dynamicCount}`;
    this.dynamicCount += 1;
    this.atom(`(() => { const ${binding} = (`, owner);
    this.expression(is.expression);
    this.atom('); return (', owner);
    this.element(node, binding, depth);
    this.atom('); })()', owner);
  }

  /**
   * A component's content: named slots as props, the default slot (or the
   * plain children) as children.
   */
  private componentContent(node: ElementNode, tag: string, depth: number): void {
    const owner = this.startTag(node);
    const slotTemplates: { node: ElementNode; slot: SlotAttribute }[] = [];
    const rest: TemplateNode[] = [];
    for (const child of node.children) {
      const slot =
        child.kind === 'element' && child.tag === 'template'
          ? child.attributes.find(
              (attribute): attribute is SlotAttribute => attribute.kind === 'slot',
            )
          : undefined;
      if (child.kind === 'element' && slot !== undefined) {
        slotTemplates.push({ node: child, slot });
      } else {
        rest.push(child);
      }
    }
    const content =
      slotTemplates.length === 0
        ? rest
        : rest.filter((child) => child.kind !== 'text' || child.value.trim() !== '');
    let defaultSlot: { node: ElementNode; slot: SlotAttribute } | undefined;
    const seen = new Set<string>();
    for (const entry of slotTemplates) {
      const name = entry.slot.name;
      if (name !== 'default' && !IDENTIFIER.test(name)) {
        this.diagnostics.error(
          'sfc.invalid_slot_name',
          'A slot name is an identifier, the prop it fills',
          entry.slot.start,
          entry.slot.nameEnd,
        );
        continue;
      }
      if (seen.has(name)) {
        this.diagnostics.error(
          'sfc.invalid_slot_name',
          'This slot is filled twice',
          entry.slot.start,
          entry.slot.end,
        );
        continue;
      }
      seen.add(name);
      if (name === 'default') {
        defaultSlot = entry;
        continue;
      }
      if (!this.supportedSlotTemplate(entry.node)) continue;
      this.atom(' ', entry.slot);
      this.writer.alias(name, entry.slot.start + 1, entry.slot.nameEnd);
      this.atom('={', entry.slot);
      this.slotContent(entry.node, entry.slot, depth + 1);
      this.atom('}', entry.slot);
    }
    if (defaultSlot !== undefined && content.length > 0) {
      const first = content[0] as TemplateNode;
      this.diagnostics.error(
        'sfc.mixed_default_slot',
        'Content outside the slot templates goes in <template #default>',
        first.start,
        first.end,
      );
    }
    if (defaultSlot === undefined && content.length === 0) {
      this.atom(' />', owner);
      return;
    }
    this.atom('>', owner);
    if (defaultSlot !== undefined && this.supportedSlotTemplate(defaultSlot.node)) {
      if (defaultSlot.slot.params === null) {
        this.children(defaultSlot.node.children, depth + 1);
      } else {
        this.newline(depth + 1, defaultSlot.slot);
        this.atom('{', defaultSlot.slot);
        this.slotContent(defaultSlot.node, defaultSlot.slot, depth + 1);
        this.atom('}', defaultSlot.slot);
      }
    } else {
      this.children(content, depth + 1);
    }
    this.newline(depth, node.endTag ?? owner);
    this.atom('</', node.endTag ?? owner);
    this.closingName(node, tag);
    this.atom('>', node.endTag ?? owner);
  }

  /** A slot template may be conditional (`js-if`), not a chain branch or a loop. */
  private supportedSlotTemplate(node: ElementNode): boolean {
    const unsupported =
      findDirective(node, 'js-else-if') ??
      findDirective(node, 'js-else') ??
      findDirective(node, 'js-for');
    if (unsupported !== undefined) {
      this.diagnostics.error(
        'sfc.not_lowered',
        'A slot template takes js-if only; choose between alternatives inside the slot',
        unsupported.start,
        unsupported.end,
      );
      return false;
    }
    return true;
  }

  /** A slot template's content: a fragment, or a function of the slot props. */
  private slotContent(node: ElementNode, slot: SlotAttribute, depth: number): void {
    const condition = findDirective(node, 'js-if');
    if (condition?.value.kind === 'expression') {
      this.atom('(', condition);
      this.expression(condition.value.expression);
      this.atom(') ? ', condition);
    }
    if (slot.params !== null) {
      this.atom('(', slot);
      this.expression(slot.params);
      this.atom(') => ', slot);
    }
    this.atom('(<>', slot);
    this.children(node.children, depth + 1);
    this.newline(depth, node.endTag ?? slot);
    this.atom('</>)', node.endTag ?? slot);
    if (condition !== undefined) this.atom(' : undefined', condition);
  }

  /** `<slot>`: the slot prop, called with its props when it passes any. */
  private slot(node: ElementNode, depth: number): void {
    const owner = this.startTag(node);
    if (!this.rules.slots) {
      this.diagnostics.error(
        'sfc.slot_kind',
        'A page has no children; <slot> belongs to a view or a layout',
        node.start,
        node.startTagEnd,
      );
      return;
    }
    let prop = 'children';
    let nameRange: Range = { start: node.start + 1, end: node.start + 1 + 'slot'.length };
    const props: (StaticAttribute | BindAttribute)[] = [];
    // A loop's `:key` keys what the slot renders; it is not a slot prop.
    let key: BindAttribute | undefined;
    for (const attribute of node.attributes) {
      if (attribute.kind === 'static' && attribute.name === 'name') {
        const value = attribute.value ?? '';
        if (!IDENTIFIER.test(value)) {
          this.diagnostics.error(
            'sfc.invalid_slot_name',
            'A slot name is an identifier, the prop it reads',
            attribute.start,
            attribute.end,
          );
          return;
        }
        prop = value === 'default' ? 'children' : value;
        nameRange = attribute;
      } else if (attribute.kind === 'bind' && attribute.name === 'name') {
        this.diagnostics.error(
          'sfc.invalid_slot_name',
          'A slot name is static',
          attribute.start,
          attribute.end,
        );
        return;
      } else if (attribute.kind === 'bind' && attribute.name === 'key') {
        key = attribute;
      } else if (attribute.kind === 'static' || attribute.kind === 'bind') {
        props.push(attribute);
      } else if (attribute.kind === 'directive' && !STRUCTURAL.has(attribute.name)) {
        this.reportDirectivePlacement(
          attribute,
          '<slot> takes slot props and structural directives only',
        );
      } else if (attribute.kind === 'on') {
        this.reportEvent(attribute);
      }
    }
    this.slots.push(Object.freeze({ prop, scoped: props.length > 0 }));
    if (key !== undefined) {
      this.helpers.add('Fragment');
      this.atom('<__Fragment ', owner);
      this.writer.alias('key', key.start + 1, key.nameEnd);
      this.atom('={', key);
      this.expression(key.expression);
      this.atom('}>{', key);
    }
    const fallback = node.children.length > 0;
    if (fallback) this.atom('(', owner);
    this.atom(`${PROPS_PARAMETER}.`, owner);
    this.writer.alias(prop, nameRange.start, nameRange.end);
    if (props.length > 0) {
      this.atom('?.({ ', owner);
      props.forEach((attribute, index) => {
        if (index > 0) this.atom(', ', attribute);
        this.objectKey(attribute.name, attribute);
        this.atom(': ', attribute);
        if (attribute.kind === 'bind') {
          this.atom('(', attribute);
          this.expression(attribute.expression);
          this.atom(')', attribute);
        } else {
          this.atom(attribute.value === null ? 'true' : JSON.stringify(attribute.value), attribute);
        }
      });
      this.atom(' })', owner);
    }
    if (fallback) {
      this.atom(' ?? <>', owner);
      this.children(node.children, depth + 1);
      this.newline(depth, node.endTag ?? owner);
      this.atom('</>)', node.endTag ?? owner);
    }
    if (key !== undefined) this.atom('}</__Fragment>', owner);
  }

  /** An object-literal key for an attribute name, an Alias of the source name. */
  private objectKey(name: string, attribute: Range & { readonly nameEnd: number }): void {
    const nameStart = attribute.nameEnd - name.length;
    const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
    this.writer.alias(key, nameStart, attribute.nameEnd);
  }

  /** A `js-pre` element or one inside it: literal tags, static attributes and text. */
  private rawElement(node: ElementNode, depth: number): void {
    const owner = this.startTag(node);
    if (!RAW_TAG.test(node.tag)) {
      this.diagnostics.error(
        'sfc.raw_component_tag',
        'A js-pre subtree renders HTML elements; write &lt; to show a tag as text',
        node.start,
        node.startTagEnd,
      );
      return;
    }
    this.atom('<', owner);
    this.writer.verbatim(node.start + 1, node.start + 1 + node.tag.length);
    for (const attribute of node.attributes) {
      if (attribute.kind === 'static') this.attribute(attribute, node, false);
    }
    this.marker(owner);
    if (node.children.length === 0) {
      this.atom(' />', owner);
      return;
    }
    this.atom('>', owner);
    this.within(true, () => {
      for (const child of node.children) {
        if (child.kind === 'element') {
          this.rawElement(child, depth + 1);
        } else if (child.kind === 'text') {
          this.atom(`{${JSON.stringify(child.value)}}`, child);
        }
      }
    });
    this.atom('</', node.endTag ?? owner);
    this.closingName(node, node.tag);
    this.atom('>', node.endTag ?? owner);
  }

  // ---------------------------------------------------------------- attributes

  private attributes(node: ElementNode, component: boolean): void {
    const named = (kind: 'static' | 'bind', name: string): TemplateAttribute | undefined =>
      node.attributes.find(
        (attribute) =>
          (attribute.kind === 'static' || attribute.kind === 'bind') &&
          attribute.kind === kind &&
          attribute.name === name,
      );
    const staticClass = named('static', 'class') as StaticAttribute | undefined;
    const boundClass = named('bind', 'class') as BindAttribute | undefined;
    const staticStyle = named('static', 'style') as StaticAttribute | undefined;
    const boundStyle = named('bind', 'style') as BindAttribute | undefined;
    const directiveShow = findDirective(node, 'js-show');
    // On a bare state field, a live render's `js-show` toggles `hidden`, which
    // the client toggles too (`show` marker); a `display: none` style it could
    // never undo.
    const liveShow = this.liveField(directiveShow);
    const show = liveShow === undefined ? directiveShow : undefined;
    const spread = findDirective(node, 'js-bind');
    const model = this.rules.kind === 'island' ? findDirective(node, 'js-model') : undefined;
    const islandModel =
      model === undefined ? undefined : this.islandModel(model, node, component, named);
    const classParts: ClassParts = { static: staticClass, bound: boundClass };
    const styleParts: StyleParts = { static: staticStyle, bound: boundStyle, show };
    const hasClass = staticClass !== undefined || boundClass !== undefined;
    const hasStyle = staticStyle !== undefined || boundStyle !== undefined || show !== undefined;
    const mergedClass = spread === undefined && boundClass !== undefined;
    const mergedStyle = spread === undefined && (boundStyle !== undefined || show !== undefined);
    let classWritten = false;
    let styleWritten = false;

    for (const attribute of node.attributes) {
      if (attribute.kind === 'directive' && attribute.name === 'js-bind') {
        this.spread(attribute, hasClass ? classParts : null, hasStyle ? styleParts : null);
        continue;
      }
      if (model !== undefined && attribute === model) {
        if (islandModel !== undefined) this.writeModel(model, islandModel, node.tag);
        continue;
      }
      if (islandModel !== undefined && attribute === islandModel.value) continue;
      if (attribute.kind === 'on' && islandModel?.handlers.includes(attribute) === true) continue;
      const isClass = attribute === staticClass || attribute === boundClass;
      const isStyle = attribute === staticStyle || attribute === boundStyle || attribute === show;
      if ((isClass || isStyle) && spread !== undefined) continue;
      if (isClass && mergedClass) {
        if (!classWritten)
          this.mergedAttribute('class', attribute, () => this.classValue(classParts));
        classWritten = true;
        continue;
      }
      if (isStyle && mergedStyle) {
        if (!styleWritten)
          this.mergedAttribute('style', attribute, () => this.styleValue(styleParts));
        styleWritten = true;
        continue;
      }
      if (attribute === directiveShow && liveShow !== undefined) {
        this.liveShow(attribute, liveShow);
        continue;
      }
      this.attribute(attribute, node, component);
    }
  }

  private attribute(attribute: TemplateAttribute, node: ElementNode, component: boolean): void {
    if (
      (attribute.kind === 'static' || attribute.kind === 'bind') &&
      RAW_HTML_ATTRIBUTES.has(attribute.name)
    ) {
      this.diagnostics.error(
        'sfc.raw_html_attribute',
        'Raw HTML is inserted with js-html, the one trusted-HTML door',
        attribute.start,
        attribute.nameEnd,
      );
      return;
    }
    switch (attribute.kind) {
      case 'static':
        this.staticAttribute(attribute, component);
        return;
      case 'bind':
        if (attribute.name === 'is') return; // `<component :is>` binds it as the element type.
        this.atom(' ', attribute);
        this.attributeName(attribute.name, attribute.start + 1, attribute.nameEnd, component);
        this.atom('={', attribute);
        this.expression(attribute.expression);
        this.atom('}', attribute);
        return;
      case 'on':
        if (this.rules.live !== null) {
          this.liveEvent(attribute, node, component);
        } else if (this.rules.kind === 'island') {
          this.islandEvent(attribute, component);
        } else {
          this.reportEvent(attribute);
        }
        return;
      case 'slot':
        return; // On a `<template>`, consumed by its component; misplaced ones are parse errors.
      case 'directive':
        this.directive(attribute, node, component);
    }
  }

  /** A lowered attribute name: Alias of the source name, camelized on a component. */
  private attributeName(name: string, start: number, end: number, component: boolean): void {
    this.writer.alias(component ? componentPropName(name) : name, start, end);
  }

  private staticAttribute(attribute: StaticAttribute, component: boolean): void {
    const name = component ? componentPropName(attribute.name) : attribute.name;
    const value = attribute.value === null ? null : JSON.stringify(attribute.value);
    if (!JSX_ATTRIBUTE_NAME.test(name)) {
      this.atom(` {...{${JSON.stringify(name)}: ${value ?? 'true'}}}`, attribute);
      return;
    }
    this.atom(' ', attribute);
    this.writer.alias(name, attribute.start, attribute.nameEnd);
    if (value !== null) this.atom(`={${value}}`, attribute);
  }

  private directive(attribute: DirectiveAttribute, node: ElementNode, component: boolean): void {
    if (STRUCTURAL.has(attribute.name)) return;
    if (attribute.name === 'js-text') {
      const field = this.liveField(attribute);
      if (field !== undefined) this.toolSpread('text', attribute, () => this.fieldName(field));
      return;
    }
    if (attribute.name === 'js-hydrate') {
      // An island mount consumes its own; whether a component is an island
      // is known once the scope pass has run.
      if (this.rules.islands !== null || !component) {
        this.reportDirectivePlacement(
          attribute,
          'js-hydrate goes on an island tag, in a template that renders on the server',
        );
      }
      return;
    }
    if (!directiveAllowedIn(attribute.name, this.rules.kind)) {
      this.reportDirectivePlacement(
        attribute,
        attribute.name === 'js-model'
          ? 'js-model binds state in a live component or a signal in an island'
          : 'This directive drives a live component; use it in a .jsails file under components/',
      );
      return;
    }
    const tool = directiveSpec(attribute.name)?.liveTool;
    if (tool !== undefined) {
      if (this.rules.live === null) {
        this.reportDirectivePlacement(
          attribute,
          'The static form renders without the runtime; live directives go in <template>',
        );
        return;
      }
      this.liveDirective(attribute, tool, node, component);
      return;
    }
    if (attribute.name === 'js-html' && attribute.value.kind === 'expression') {
      this.atom(' ', attribute);
      this.writer.alias('dangerouslySetInnerHTML', attribute.start, attribute.nameEnd);
      this.atom('={{ __html: ', attribute);
      this.expression(attribute.value.expression);
      this.atom(' }}', attribute);
    }
  }

  // ---------------------------------------------------------------- live

  /**
   * The state field a live render's `js-show`/`js-text` names, when its value
   * is exactly one bare state-field use (the scope pass's `propUses`).
   */
  private liveField(
    attribute: DirectiveAttribute | undefined,
  ): { readonly name: string; readonly start: number } | undefined {
    if (this.rules.live === null || attribute?.value.kind !== 'expression') return undefined;
    const expression = attribute.value.expression;
    const name = expression.code.trim();
    if (!expression.verbatim || !IDENTIFIER.test(name)) return undefined;
    const start = expression.start + expression.code.indexOf(name);
    return this.rules.live.propUses.has(start) ? { name, start } : undefined;
  }

  /** A field or action name as the tool's string argument, an Alias of the source name. */
  private fieldName(field: { readonly name: string; readonly start: number }): void {
    this.writer.alias(JSON.stringify(field.name), field.start, field.start + field.name.length);
  }

  /** ` {...__tools.<tool>(<args>)}`, owned by `owner`. */
  private toolSpread(tool: string, owner: Range, args: () => void): void {
    this.atom(` {...${TOOLS_PARAMETER}.${tool}(`, owner);
    args();
    this.atom(')}', owner);
  }

  /** `js-show="field"` in a live render: `hidden` while falsy, plus the client marker. */
  private liveShow(
    attribute: DirectiveAttribute,
    field: { readonly name: string; readonly start: number },
  ): void {
    if (attribute.value.kind !== 'expression') return;
    this.atom(' ', attribute);
    this.writer.alias('hidden', attribute.start, attribute.nameEnd);
    this.atom('={!(', attribute);
    this.expression(attribute.value.expression);
    this.atom(')}', attribute);
    this.toolSpread('show', attribute, () => this.fieldName(field));
  }

  /** A live directive, as a spread of its render tool's attributes. */
  private liveDirective(
    attribute: DirectiveAttribute,
    tool: string,
    node: ElementNode,
    component: boolean,
  ): void {
    if (component) {
      this.reportDirectivePlacement(attribute, 'A live directive goes on an HTML element');
      return;
    }
    if (attribute.name === 'js-model' && !MODEL_TAGS.has(node.tag)) {
      this.diagnostics.error(
        'sfc.model_target',
        'js-model binds an <input>, a <select> or a <textarea>',
        attribute.start,
        attribute.nameEnd,
      );
      return;
    }
    const value = attribute.value;
    this.toolSpread(tool, attribute, () => {
      if (value.kind === 'name') {
        this.fieldName({ name: value.name, start: value.start });
      } else if (value.kind === 'expression') {
        this.expression(value.expression);
      }
      if (attribute.name === 'js-model' && attribute.modifiers.length > 0) {
        const options = [...attribute.modifiers].sort().map((modifier) => `${modifier}: true`);
        this.atom(`, { ${options.join(', ')} }`, attribute);
      }
    });
  }

  /**
   * `@click`, `@submit` or `@intersect` in a live render: a spread of the
   * `call`, `submit` or `intersect` tool. The handler names an action, alone
   * (`add`) or with one argument (`remove(task.id)`); the name becomes the
   * tool's first argument, an Alias string literal.
   */
  private liveEvent(attribute: EventAttribute, node: ElementNode, component: boolean): void {
    const tool = LIVE_EVENTS[attribute.event];
    if (tool === undefined || component) {
      this.diagnostics.error(
        'sfc.live_event',
        component
          ? 'A live action is triggered from an HTML element'
          : 'A live component handles @click, @submit and @intersect; other events belong to an island',
        attribute.start,
        attribute.nameEnd,
      );
      return;
    }
    if (tool === 'submit' && node.tag !== 'form') {
      this.diagnostics.error(
        'sfc.live_event',
        '@submit goes on a <form>',
        attribute.start,
        attribute.nameEnd,
      );
      return;
    }
    const markers: string[] = [];
    for (const modifier of attribute.modifiers) {
      const marker = LIVE_MODIFIERS[modifier];
      if (marker === undefined || (tool === 'intersect' && marker !== null)) {
        this.diagnostics.error(
          'sfc.live_event_modifier',
          tool === 'intersect'
            ? '@intersect takes no modifier but .prevent'
            : 'A live trigger takes .prevent, .once and .capture',
          attribute.start,
          attribute.nameEnd,
        );
        return;
      }
      if (marker !== null) markers.push(marker);
    }
    const handler = this.actionHandler(attribute, tool !== 'intersect');
    if (handler === undefined) return;
    this.toolSpread(tool, attribute, () => {
      const { expression, name, argument } = handler;
      if (expression.verbatim) {
        this.writer.alias(JSON.stringify(name.text), name.start, name.end);
      } else {
        this.atom(JSON.stringify(name.text), expression);
      }
      if (argument !== null) {
        this.atom(', ', attribute);
        if (expression.verbatim) {
          this.writer.verbatim(argument.start, argument.end);
        } else {
          this.atom(argument.text, expression);
        }
      }
    });
    for (const marker of markers) this.atom(` ${marker}=""`, attribute);
  }

  /**
   * The action a live handler names, and its argument: the handler is an
   * identifier or a call of one with at most one plain argument. Offsets are
   * file offsets when the handler is Verbatim.
   */
  private actionHandler(
    attribute: EventAttribute,
    takesArgument: boolean,
  ):
    | {
        readonly expression: TemplateExpression;
        readonly name: { readonly text: string; readonly start: number; readonly end: number };
        readonly argument: {
          readonly text: string;
          readonly start: number;
          readonly end: number;
        } | null;
      }
    | undefined {
    const report = (): undefined => {
      this.diagnostics.error(
        'sfc.live_handler_not_action',
        takesArgument
          ? 'A live handler names an action: add, or add(argument)'
          : '@intersect names an action, without an argument',
        attribute.start,
        attribute.end,
      );
      return undefined;
    };
    const expression = attribute.handler;
    if (expression === null || attribute.handlerForm !== 'expression') return report();
    const prefix = '(';
    const parsed = parseSync('handler.ts', `${prefix}${expression.code})`, {
      lang: 'ts',
      sourceType: 'module',
    });
    const statement = parsed.program.body[0];
    if (parsed.errors.length > 0 || statement?.type !== 'ExpressionStatement') return report();
    let node = statement.expression;
    while (node.type === 'ParenthesizedExpression') node = node.expression;
    const offset = (position: number): number => expression.start + position - prefix.length;
    const span = (from: { start: number; end: number }) => ({
      text: expression.code.slice(from.start - prefix.length, from.end - prefix.length),
      start: offset(from.start),
      end: offset(from.end),
    });
    if (node.type === 'Identifier') return { expression, name: span(node), argument: null };
    if (
      node.type !== 'CallExpression' ||
      node.optional ||
      node.callee.type !== 'Identifier' ||
      node.typeArguments !== null ||
      node.arguments.length > 1 ||
      (node.arguments.length === 1 && !takesArgument)
    ) {
      return report();
    }
    const argument = node.arguments[0];
    if (argument?.type === 'SpreadElement') return report();
    return {
      expression,
      name: span(node.callee),
      argument: argument === undefined ? null : span(argument),
    };
  }

  // ---------------------------------------------------------------- island events

  /**
   * `@event` in an island: the typed Preact handler prop of a DOM event on an
   * HTML element (`onKeyDown`, `onClickCapture`), or the `on…` prop of a
   * component event on a component.
   */
  private islandEvent(attribute: EventAttribute, component: boolean): void {
    const prop = this.islandEventProp(attribute, component);
    if (prop === undefined) return;
    this.atom(' ', attribute);
    this.writer.alias(prop, attribute.start, attribute.nameEnd);
    this.atom('={', attribute);
    this.islandHandler(attribute);
    this.atom('}', attribute);
  }

  /** The prop an island event sets, or `undefined` after reporting why it cannot be set. */
  private islandEventProp(attribute: EventAttribute, component: boolean): string | undefined {
    const report = (
      code: 'sfc.event_modifier' | 'sfc.unknown_event',
      message: string,
    ): undefined => {
      this.diagnostics.error(code, message, attribute.start, attribute.nameEnd);
      return undefined;
    };
    if (component) {
      if (attribute.modifiers.length > 0) {
        return report(
          'sfc.event_modifier',
          'A component event takes no modifier; the component decides how it fires',
        );
      }
      return componentEventProp(attribute.event);
    }
    if (attribute.modifiers.includes('passive')) {
      return report(
        'sfc.event_modifier',
        'Preact registers its own listeners, so an island event cannot be passive',
      );
    }
    const capture = attribute.modifiers.includes('capture');
    return (
      domEventProp(attribute.event, capture) ??
      report(
        'sfc.unknown_event',
        capture && domEventProp(attribute.event, false) !== undefined
          ? 'This event has no capture phase handler'
          : 'This is not a DOM event an element handles; an island handles the events Preact types',
      )
    );
  }

  /**
   * An island event's handler: a name or a function expression as is, a
   * member path as an arrow calling it through its object, other code as an
   * arrow function with `$event` in scope, and the modifiers (but `.capture`,
   * which chose the prop) as its first statements: `.once` first, then
   * `.self`, `.prevent` and `.stop` in the order written.
   */
  private islandHandler(attribute: EventAttribute): void {
    const steps = attribute.modifiers.filter((modifier) => modifier !== 'capture');
    const expression = attribute.handler;
    const shape =
      expression === null
        ? null
        : handlerShape(expression.code, attribute.handlerForm ?? 'expression');
    if (expression !== null && shape !== null && steps.length === 0) {
      if (shape.form === 'reference') {
        this.expression(expression);
        return;
      }
      if (shape.form === 'inline' || shape.form === 'method') {
        this.atom(
          `${shape.form === 'method' || shape.usesEvent ? '($event)' : '()'} => `,
          attribute,
        );
        this.handlerCall(attribute, expression, shape.form);
        return;
      }
    }
    const usesEvent = steps.length > 0 || shape?.usesEvent === true;
    this.atom(`${usesEvent ? '($event)' : '()'} => {`, attribute);
    if (steps.includes('once')) {
      const site = onceSite(this.onceSites);
      this.onceSites += 1;
      this.atom(
        ` if (${site}.has($event.currentTarget)) return; ${site}.add($event.currentTarget);`,
        attribute,
      );
    }
    for (const step of steps) {
      if (step === 'self') {
        this.atom(' if ($event.target !== $event.currentTarget) return;', attribute);
      } else if (step === 'prevent') {
        this.atom(' $event.preventDefault();', attribute);
      } else if (step === 'stop') {
        this.atom(' $event.stopPropagation();', attribute);
      }
    }
    if (expression !== null && shape !== null) {
      if (shape.form === 'statements') {
        this.atom('\n', attribute);
        this.expression(expression);
        this.atom('\n', attribute);
      } else {
        this.atom(' ', attribute);
        this.handlerCall(attribute, expression, shape.form);
        this.atom(';', attribute);
      }
    }
    this.atom(' }', attribute);
  }

  /**
   * A handler expression run on `$event`: inline code as it is, and a
   * reference called with the event. The call goes through the expression
   * itself, so a member path keeps its object as `this`. The reference
   * `satisfies` a handler of the event, as it would as the prop's value,
   * and that check is an Alias of the expression with no language-service
   * features, so a handler of the wrong type is reported at it; the cast
   * that follows, through `unknown` so it cannot fail a second time, lets a
   * handler that takes no parameter be called with the event.
   */
  private handlerCall(
    attribute: EventAttribute,
    expression: TemplateExpression,
    form: 'reference' | 'method' | 'inline',
  ): void {
    this.atom('(', attribute);
    this.expression(expression);
    if (form === 'inline') {
      this.atom(')', attribute);
      return;
    }
    this.writer.alias(
      ` satisfies ${EVENT_HANDLER}`,
      expression.start,
      expression.end,
      SpanFeature.None,
    );
    this.atom(` as unknown as ${EVENT_HANDLER})($event)`, attribute);
  }

  // ---------------------------------------------------------------- island models

  /**
   * The control an island's `js-model` drives, or `undefined` after
   * reporting why it cannot bind: a component, an element that is not a
   * form control, a type decided at runtime, a type with no value to bind,
   * an attribute the binding would overwrite, or a modifier the control
   * does not take.
   */
  private islandModel(
    attribute: DirectiveAttribute,
    node: ElementNode,
    component: boolean,
    named: (kind: 'static' | 'bind', name: string) => TemplateAttribute | undefined,
  ): IslandModel | undefined {
    const fail = (message: string, at: TemplateAttribute = attribute): undefined => {
      this.diagnostics.error('sfc.model_target', message, at.start, at.nameEnd);
      return undefined;
    };
    if (component || !MODEL_TAGS.has(node.tag)) {
      return fail('js-model binds an <input>, a <select> or a <textarea>');
    }
    const either = (name: string): StaticAttribute | BindAttribute | undefined =>
      (named('static', name) ?? named('bind', name)) as StaticAttribute | BindAttribute | undefined;
    const checked = either('checked');
    if (checked !== undefined) return fail('js-model sets checked; remove the attribute', checked);
    let control: IslandModel['control'] = 'text';
    if (node.tag === 'select') {
      const multiple = either('multiple');
      if (multiple !== undefined) {
        return fail('js-model binds a single select; a multiple select is not supported', multiple);
      }
      control = 'select';
    } else if (node.tag === 'input') {
      const type = either('type');
      if (type?.kind === 'bind') {
        return fail(
          'js-model reads the input type to choose its binding, so the type is static',
          type,
        );
      }
      const name = (type?.value ?? 'text').toLowerCase();
      const mapped = Object.hasOwn(MODEL_INPUT_TYPES, name) ? MODEL_INPUT_TYPES[name] : 'text';
      if (mapped === null || mapped === undefined) {
        return fail('This input type holds no value js-model can bind', type);
      }
      control = mapped;
    }
    const value = either('value');
    if (control === 'radio' && value === undefined) {
      return fail('A radio button bound with js-model needs the value it stands for');
    }
    if (control !== 'radio' && value !== undefined) {
      return fail('js-model sets the value; remove the attribute', value);
    }
    const allowed = MODEL_MODIFIERS[control];
    const refused = attribute.modifiers.find((modifier) => !allowed.includes(modifier));
    if (refused !== undefined) {
      return fail(
        allowed.length === 0
          ? `js-model on a ${control} takes no modifier`
          : `js-model on this control takes ${allowed.map((modifier) => `.${modifier}`).join(', ')}`,
      );
    }
    const handlers = node.attributes.filter(
      (candidate): candidate is EventAttribute =>
        candidate.kind === 'on' &&
        !candidate.modifiers.includes('capture') &&
        MODEL_EVENT_PROPS.has(domEventProp(candidate.event, false) ?? ''),
    );
    return { control, value, handlers };
  }

  /**
   * ` {...__bindControl(target, "control", { modifiers, value, handlers })}`,
   * the handlers typed as the element's own props would be.
   */
  private writeModel(attribute: DirectiveAttribute, model: IslandModel, tag: string): void {
    if (attribute.value.kind !== 'name') return;
    const target = attribute.value;
    this.helpers.add('bindControl');
    this.atom(' {...__bindControl(', attribute);
    this.writer.verbatim(target.start, target.end);
    this.atom(`, ${JSON.stringify(model.control)}`, attribute);
    const options = [...attribute.modifiers].sort().map((modifier) => () => {
      this.atom(`${modifier}: true`, attribute);
    });
    const value = model.value;
    if (value !== undefined) {
      options.push(() => {
        this.atom('value: ', value);
        if (value.kind === 'bind') {
          this.parenthesized(value);
        } else {
          this.atom(JSON.stringify(value.value ?? ''), value);
        }
      });
    }
    const handlers = model.handlers.flatMap((handler) => {
      const prop = this.islandEventProp(handler, false);
      return prop === undefined ? [] : [{ handler, prop }];
    });
    if (handlers.length > 0) {
      this.helpers.add('JSX');
      options.push(() => {
        this.atom('handlers: {', attribute);
        handlers.forEach(({ handler, prop }, index) => {
          this.atom(index > 0 ? ', ' : ' ', handler);
          this.writer.alias(prop, handler.start, handler.nameEnd);
          this.atom(': ', handler);
          this.islandHandler(handler);
        });
        const props = [...new Set(handlers.map(({ prop }) => JSON.stringify(prop)))];
        this.atom(
          ` } satisfies Pick<__JSX.IntrinsicElements[${JSON.stringify(tag)}], ${props.join(' | ')}>`,
          attribute,
        );
      });
    }
    if (options.length > 0) {
      this.atom(', { ', attribute);
      options.forEach((write, index) => {
        if (index > 0) this.atom(', ', attribute);
        write();
      });
      this.atom(' }', attribute);
    }
    this.atom(')}', attribute);
  }

  private reportDirectivePlacement(attribute: DirectiveAttribute, message: string): void {
    this.diagnostics.error('sfc.directive_kind', message, attribute.start, attribute.nameEnd);
  }

  private reportEvent(attribute: EventAttribute): void {
    this.diagnostics.error(
      'sfc.event_without_client',
      'This template renders on the server only; handle the event in an island or a live action',
      attribute.start,
      attribute.nameEnd,
    );
  }

  /** `class={…}` or `style={…}` merged from several attributes, at the first one. */
  private mergedAttribute(name: 'class' | 'style', at: TemplateAttribute, value: () => void): void {
    this.atom(' ', at);
    this.writer.alias(name, at.start + (at.kind === 'bind' ? 1 : 0), at.nameEnd);
    this.atom('={', at);
    value();
    this.atom('}', at);
  }

  private classValue(parts: ClassParts): void {
    const owner = (parts.bound ?? parts.static) as TemplateAttribute;
    this.helpers.add('normalizeClass');
    this.atom('__normalizeClass(', owner);
    this.classList(parts, owner);
    this.atom(')', owner);
  }

  private styleValue(parts: StyleParts): void {
    const owner = (parts.bound ?? parts.static ?? parts.show) as TemplateAttribute;
    this.helpers.add('normalizeStyle');
    this.atom('__normalizeStyle(', owner);
    this.styleList(parts, owner);
    this.atom(')', owner);
  }

  /** One part as is, several as an array literal (later parts win). */
  private list(parts: readonly ((() => void) | undefined)[], owner: Range): void {
    const present = parts.filter((part): part is () => void => part !== undefined);
    if (present.length === 1) {
      (present[0] as () => void)();
      return;
    }
    this.atom('[', owner);
    present.forEach((part, index) => {
      if (index > 0) this.atom(', ', owner);
      part();
    });
    this.atom(']', owner);
  }

  private staticValue(attribute: StaticAttribute): void {
    this.atom(JSON.stringify(attribute.value ?? ''), attribute);
  }

  private parenthesized(attribute: BindAttribute): void {
    this.atom('(', attribute);
    this.expression(attribute.expression);
    this.atom(')', attribute);
  }

  /**
   * `js-show="cond"`: `display: none` when the condition is falsy, and nothing
   * when it holds, so a shown element keeps the `display` its own style sets.
   */
  private showValue(attribute: DirectiveAttribute): void {
    if (attribute.value.kind !== 'expression') return;
    this.atom('(', attribute);
    this.expression(attribute.value.expression);
    this.atom(") ? undefined : { display: 'none' }", attribute);
  }

  /**
   * `js-bind="obj"`: spread through `bindAttributes`, which drops the raw-HTML
   * attributes an object from data could carry and merges the element's own
   * class and style when it has them.
   */
  private spread(
    attribute: DirectiveAttribute,
    classParts: ClassParts | null,
    styleParts: StyleParts | null,
  ): void {
    if (attribute.value.kind !== 'expression') return;
    this.helpers.add('bindAttributes');
    this.atom(' {...__bindAttributes((', attribute);
    this.expression(attribute.value.expression);
    if (classParts === null && styleParts === null) {
      this.atom('))}', attribute);
      return;
    }
    this.atom('), { ', attribute);
    if (classParts !== null) {
      this.atom('class: ', attribute);
      this.classList(classParts, attribute);
    }
    if (styleParts !== null) {
      if (classParts !== null) this.atom(', ', attribute);
      this.atom('style: ', attribute);
      this.styleList(styleParts, attribute);
    }
    this.atom(' })}', attribute);
  }

  private classList(parts: ClassParts, owner: Range): void {
    this.list(
      [
        parts.static === undefined
          ? undefined
          : () => this.staticValue(parts.static as StaticAttribute),
        parts.bound === undefined
          ? undefined
          : () => this.parenthesized(parts.bound as BindAttribute),
      ],
      owner,
    );
  }

  private styleList(parts: StyleParts, owner: Range): void {
    this.list(
      [
        parts.static === undefined
          ? undefined
          : () => this.staticValue(parts.static as StaticAttribute),
        parts.bound === undefined
          ? undefined
          : () => this.parenthesized(parts.bound as BindAttribute),
        parts.show === undefined
          ? undefined
          : () => this.showValue(parts.show as DirectiveAttribute),
      ],
      owner,
    );
  }
}

/**
 * The prop a component attribute sets: kebab-case names are camelized as in
 * Vue (`post-count` → `postCount`), except `data-*` and `aria-*`, which stay
 * attributes.
 */
function componentPropName(name: string): string {
  if (!name.includes('-') || name.startsWith('data-') || name.startsWith('aria-')) return name;
  return camelCase(name);
}
