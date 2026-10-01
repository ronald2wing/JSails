/**
 * The `js-*` directive table of `.jsails` templates: for each directive, the
 * value it takes, the modifiers it accepts and, for the directives a live
 * component lowers onto its render tools, the tool's name. The template
 * parser validates attributes against it; the removed spellings map to their
 * replacements so the parser can offer a fix.
 *
 * Values that name a state key, action or ref are `name`s (`js-model="title"`);
 * every other value is a TypeScript expression, so a literal string is
 * written `js-confirm="'Delete?'"`.
 */

/** The kind of value a directive takes. */
export type DirectiveValueKind =
  /** A TypeScript expression. */
  | 'expression'
  /** An identifier naming a state key, action or ref. */
  | 'name'
  /** An identifier, or no value at all. */
  | 'optional-name'
  /** No value. */
  | 'none'
  /** `alias in source` or `alias of source`. */
  | 'for'
  /** One of the hydration triggers. */
  | 'hydrate';

/** One directive's syntax. */
export interface DirectiveSpec {
  readonly value: DirectiveValueKind;
  readonly modifiers: readonly string[];
  /** The live render tool the directive lowers onto, when it is one. */
  readonly liveTool?: string;
}

/** Every `js-*` directive the grammar has. */
export const DIRECTIVES: Readonly<Record<string, DirectiveSpec>> = Object.freeze({
  'js-if': { value: 'expression', modifiers: [] },
  'js-else-if': { value: 'expression', modifiers: [] },
  'js-else': { value: 'none', modifiers: [] },
  'js-for': { value: 'for', modifiers: [] },
  'js-show': { value: 'expression', modifiers: [] },
  'js-text': { value: 'expression', modifiers: [] },
  'js-html': { value: 'expression', modifiers: [] },
  'js-pre': { value: 'none', modifiers: [] },
  'js-bind': { value: 'expression', modifiers: [] },
  'js-model': { value: 'name', modifiers: ['lazy', 'trim', 'number'], liveTool: 'bind' },
  'js-confirm': { value: 'expression', modifiers: [], liveTool: 'confirm' },
  'js-loading': { value: 'optional-name', modifiers: [], liveTool: 'loadingTarget' },
  'js-poll': { value: 'expression', modifiers: [], liveTool: 'poll' },
  'js-sort': { value: 'name', modifiers: [], liveTool: 'sort' },
  'js-ref': { value: 'name', modifiers: [], liveTool: 'ref' },
  'js-ignore': { value: 'none', modifiers: [], liveTool: 'ignore' },
  'js-hydrate': { value: 'hydrate', modifiers: [] },
});

/** The values `js-hydrate` accepts. */
export const HYDRATE_TRIGGERS: readonly string[] = Object.freeze(['load', 'idle', 'visible']);

/** The modifiers an `@event` attribute accepts. */
export const EVENT_MODIFIERS: readonly string[] = Object.freeze([
  'prevent',
  'stop',
  'self',
  'once',
  'capture',
  'passive',
]);

/**
 * Removed directive spellings and the attribute name that replaces each; an
 * empty replacement means the directive is dropped with no replacement.
 */
export const REMOVED_DIRECTIVES: Readonly<Record<string, string>> = Object.freeze({
  'js-submit': '@submit',
  'js-call': '@click',
  'js-intersect': '@intersect',
  'js-visible': 'js-show',
  'js-content': 'js-text',
  'js-once': '',
  'js-is': ':is',
});

/** Removed directive prefixes (`js-bind:x`, `js-on:x`) and their shorthand. */
export const REMOVED_DIRECTIVE_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  'js-bind:': ':',
  'js-on:': '@',
});

/** The directive spec for `name`, ignoring inherited object keys. */
export function directiveSpec(name: string): DirectiveSpec | undefined {
  return Object.hasOwn(DIRECTIVES, name) ? DIRECTIVES[name] : undefined;
}
