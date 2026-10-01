/**
 * The `js-*` directive table of `.jsails` templates: for each directive, the
 * value it takes, the modifiers it accepts, the kinds of file whose templates
 * may use it and, for the directives a live component lowers onto its render
 * tools, the tool's name. The template parser validates syntax against it and
 * the kind lowerings validate placement; the removed spellings map to their
 * replacements so the parser can offer a fix.
 *
 * Values that name a state key, action or ref are `name`s (`js-model="title"`);
 * every other value is a TypeScript expression, so a literal string is
 * written `js-confirm="'Delete?'"`.
 */

import { SFC_KINDS, type SfcKind } from './conventions.js';

/** The kind of value a directive takes. */
export type DirectiveValueKind =
  /** A TypeScript expression. */
  | 'expression'
  /** An identifier naming a state key, action or ref. */
  | 'name'
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
  /** The kinds of `.jsails` file whose templates may use the directive. */
  readonly kinds: readonly SfcKind[];
  /** The live render tool the directive lowers onto, when it is one. */
  readonly liveTool?: string;
}

/** Every kind: the structural directives mean the same in each. */
const EVERY_KIND: readonly SfcKind[] = SFC_KINDS;

/** The kinds that render on the server only and may mount islands. */
const ISLAND_HOSTS: readonly SfcKind[] = Object.freeze([
  'page',
  'layout',
  'error',
  'not-found',
  'view',
]);

const LIVE: readonly SfcKind[] = Object.freeze(['live']);

/** Every `js-*` directive the grammar has. */
export const DIRECTIVES: Readonly<Record<string, DirectiveSpec>> = Object.freeze({
  'js-if': { value: 'expression', modifiers: [], kinds: EVERY_KIND },
  'js-else-if': { value: 'expression', modifiers: [], kinds: EVERY_KIND },
  'js-else': { value: 'none', modifiers: [], kinds: EVERY_KIND },
  'js-for': { value: 'for', modifiers: [], kinds: EVERY_KIND },
  'js-show': { value: 'expression', modifiers: [], kinds: EVERY_KIND },
  'js-text': { value: 'expression', modifiers: [], kinds: EVERY_KIND },
  'js-html': { value: 'expression', modifiers: [], kinds: EVERY_KIND },
  'js-pre': { value: 'none', modifiers: [], kinds: EVERY_KIND },
  'js-bind': { value: 'expression', modifiers: [], kinds: EVERY_KIND },
  'js-model': {
    value: 'name',
    modifiers: ['lazy', 'trim', 'number'],
    kinds: ['live', 'island'],
    liveTool: 'bind',
  },
  'js-confirm': { value: 'expression', modifiers: [], kinds: LIVE, liveTool: 'confirm' },
  'js-loading': { value: 'none', modifiers: [], kinds: LIVE, liveTool: 'loadingTarget' },
  'js-poll': { value: 'expression', modifiers: [], kinds: LIVE, liveTool: 'poll' },
  'js-sort': { value: 'name', modifiers: [], kinds: LIVE, liveTool: 'sort' },
  'js-ref': { value: 'name', modifiers: [], kinds: LIVE, liveTool: 'ref' },
  'js-ignore': { value: 'none', modifiers: [], kinds: LIVE, liveTool: 'ignore' },
  // Only on an island's tag, in a template that may mount one.
  'js-hydrate': { value: 'hydrate', modifiers: [], kinds: ISLAND_HOSTS },
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

/** Whether a template of `kind` may use the directive `name`. */
export function directiveAllowedIn(name: string, kind: SfcKind): boolean {
  return directiveSpec(name)?.kinds.includes(kind) === true;
}
