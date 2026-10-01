/**
 * The node tree a `.jsails` `<template>` parses into.
 *
 * Every offset is a UTF-16 offset into the file that holds the template, so a
 * template read from its own file (the multi-file layout) points into that
 * file. Comments are not nodes: the parser drops them. Text values are final:
 * entities decoded and the whitespace rule applied (docs/design/sfc.md §5.2).
 */

/** TypeScript code embedded in the template, with where it came from. */
export interface TemplateExpression {
  /**
   * The code: inside an attribute value with its character references decoded,
   * as HTML decodes every attribute; inside `{{ }}` exactly as written.
   */
  readonly code: string;
  /** Offset of the code's first character in the file. */
  readonly start: number;
  /** Offset just past the code's last character. */
  readonly end: number;
  /**
   * Whether `code` equals the file text between `start` and `end`, so it can
   * be mapped character for character. False when an entity was decoded.
   */
  readonly verbatim: boolean;
}

/** Literal text: entities decoded, whitespace already condensed. */
export interface TextNode {
  readonly kind: 'text';
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** A `{{ expression }}`; `start`/`end` include the braces. */
export interface InterpolationNode {
  readonly kind: 'interpolation';
  readonly expression: TemplateExpression;
  readonly start: number;
  readonly end: number;
}

/** An element or component. */
export interface ElementNode {
  readonly kind: 'element';
  readonly tag: string;
  /** Offset of the `<` of the start tag. */
  readonly start: number;
  /** Offset just past the end tag, the `/>`, or the start tag of a void element. */
  readonly end: number;
  /** Offset just past the start tag's `>`. */
  readonly startTagEnd: number;
  /** The end tag's range, or `null` for a self-closing or void element. */
  readonly endTag: { readonly start: number; readonly end: number } | null;
  readonly selfClosing: boolean;
  readonly attributes: readonly TemplateAttribute[];
  readonly children: readonly TemplateNode[];
  /**
   * True for a `js-pre` element and everything inside it: attributes are all
   * static, `{{` is text and whitespace is kept exactly.
   */
  readonly raw: boolean;
}

/** A template child. */
export type TemplateNode = ElementNode | TextNode | InterpolationNode;

/** The parts every attribute shares. */
interface AttributeRange {
  /** Offset of the attribute name's first character. */
  readonly start: number;
  /** Offset just past the value's closing quote, or past the name when bare. */
  readonly end: number;
  /** Offset just past the attribute name. */
  readonly nameEnd: number;
}

/** `name`, `name="text"`: a plain attribute (entities decoded in the value). */
export interface StaticAttribute extends AttributeRange {
  readonly kind: 'static';
  readonly name: string;
  readonly value: string | null;
}

/** `:name="expression"`. */
export interface BindAttribute extends AttributeRange {
  readonly kind: 'bind';
  readonly name: string;
  readonly expression: TemplateExpression;
}

/** `@event.modifier="handler"`; the handler is an expression or statements. */
export interface EventAttribute extends AttributeRange {
  readonly kind: 'on';
  readonly event: string;
  readonly modifiers: readonly string[];
  readonly handler: TemplateExpression | null;
  readonly handlerForm: 'expression' | 'statements' | null;
}

/** `#name` or `#name="{ props }"` on a `<template>` inside a component. */
export interface SlotAttribute extends AttributeRange {
  readonly kind: 'slot';
  readonly name: string;
  /** The slot props as an arrow parameter list, without parentheses. */
  readonly params: TemplateExpression | null;
}

/** A `js-*` directive. */
export interface DirectiveAttribute extends AttributeRange {
  readonly kind: 'directive';
  readonly name: string;
  readonly modifiers: readonly string[];
  readonly value: DirectiveValue;
}

/** The parsed value of a directive, by the kind its table entry declares. */
export type DirectiveValue =
  | { readonly kind: 'none' }
  | { readonly kind: 'expression'; readonly expression: TemplateExpression }
  | {
      readonly kind: 'name';
      readonly name: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: 'for';
      /** The alias as an arrow parameter list, without parentheses. */
      readonly alias: TemplateExpression;
      readonly keyword: 'in' | 'of';
      readonly source: TemplateExpression;
    }
  | {
      readonly kind: 'hydrate';
      readonly trigger: string;
      readonly start: number;
      readonly end: number;
    };

/** Any template attribute. */
export type TemplateAttribute =
  StaticAttribute | BindAttribute | EventAttribute | SlotAttribute | DirectiveAttribute;

/** The content of one `<template>` block. */
export interface TemplateRoot {
  readonly children: readonly TemplateNode[];
  /** Offset of the content's first character (just past `<template …>`). */
  readonly start: number;
  /** Offset just past the content (the `<` of `</template>`, or end of file). */
  readonly end: number;
}

/** The directive attribute named `name` on an element, if any. */
export function findDirective(element: ElementNode, name: string): DirectiveAttribute | undefined {
  return element.attributes.find(
    (attribute): attribute is DirectiveAttribute =>
      attribute.kind === 'directive' && attribute.name === name,
  );
}

/** The bound attribute named `name` on an element, if any. */
export function findBinding(element: ElementNode, name: string): BindAttribute | undefined {
  return element.attributes.find(
    (attribute): attribute is BindAttribute => attribute.kind === 'bind' && attribute.name === name,
  );
}

/** Whether a tag names a component rather than an HTML element. */
export function isComponentTag(tag: string): boolean {
  return /^[A-Z]/.test(tag) || tag.includes('.');
}
