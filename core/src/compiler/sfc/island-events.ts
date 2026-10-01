/**
 * `@event` in an island template (sfc-plan §2.4): which Preact prop an event
 * name sets, and what shape its handler has.
 *
 * On an HTML element the event is a DOM event, set through the typed Preact
 * handler prop (`@keydown` → `onKeyDown`, `.capture` → `onKeyDownCapture`),
 * so `$event` is typed by Preact; the table below is Preact's own list of DOM
 * handler props, and an event outside it is reported rather than written as
 * an untyped prop. On a component the event is a component event, the prop
 * `on` + its camel-cased name (`@update-value` → `onUpdateValue`), which is
 * what `defineEmits` declares.
 *
 * A handler follows Vue's rules: a name (`go`) or a function expression is
 * the handler itself; a member path (`form.reset`, `items['add']`) is called
 * through its object on the event, so a method keeps its `this` whether or
 * not the event has modifiers (Preact calls a handler prop as a plain
 * function); any other expression is run with `$event` in scope, and so are
 * statements.
 */

import { parseSync } from 'rolldown/utils';

import { collectFreeReferences } from '../scope-walker.js';

/**
 * The DOM events Preact types a handler prop for, each as the prop name
 * without `on`. Every one has a `…Capture` variant except
 * {@link NO_CAPTURE}.
 */
const DOM_EVENTS: readonly string[] = Object.freeze([
  'Abort',
  'AnimationEnd',
  'AnimationIteration',
  'AnimationStart',
  'AuxClick',
  'BeforeInput',
  'BeforeToggle',
  'Blur',
  'Cancel',
  'CanPlay',
  'CanPlayThrough',
  'Change',
  'Click',
  'Close',
  'Command',
  'CompositionEnd',
  'CompositionStart',
  'CompositionUpdate',
  'ContextMenu',
  'Copy',
  'Cut',
  'DblClick',
  'Drag',
  'DragEnd',
  'DragEnter',
  'DragExit',
  'DragLeave',
  'DragOver',
  'DragStart',
  'Drop',
  'DurationChange',
  'Emptied',
  'Encrypted',
  'Ended',
  'EnterPictureInPicture',
  'Error',
  'Focus',
  'FocusIn',
  'FocusOut',
  'FormData',
  'GotPointerCapture',
  'Input',
  'Invalid',
  'KeyDown',
  'KeyPress',
  'KeyUp',
  'LeavePictureInPicture',
  'Load',
  'LoadedData',
  'LoadedMetadata',
  'LoadStart',
  'LostPointerCapture',
  'MouseDown',
  'MouseEnter',
  'MouseLeave',
  'MouseMove',
  'MouseOut',
  'MouseOver',
  'MouseUp',
  'Paste',
  'Pause',
  'Play',
  'Playing',
  'PointerCancel',
  'PointerDown',
  'PointerEnter',
  'PointerLeave',
  'PointerMove',
  'PointerOut',
  'PointerOver',
  'PointerUp',
  'Progress',
  'RateChange',
  'Reset',
  'Resize',
  'Scroll',
  'ScrollEnd',
  'ScrollSnapChange',
  'ScrollSnapChanging',
  'Search',
  'Seeked',
  'Seeking',
  'Select',
  'Stalled',
  'Submit',
  'Suspend',
  'TimeUpdate',
  'Toggle',
  'TouchCancel',
  'TouchEnd',
  'TouchMove',
  'TouchStart',
  'TransitionCancel',
  'TransitionEnd',
  'TransitionRun',
  'TransitionStart',
  'VolumeChange',
  'Waiting',
  'Wheel',
]);

/** The DOM events whose Preact handler prop has no `…Capture` variant. */
const NO_CAPTURE: ReadonlySet<string> = new Set([
  'BeforeToggle',
  'Cancel',
  'Close',
  'Command',
  'Toggle',
]);

/** Each DOM event type (lower case, as written in HTML) to its prop name without `on`. */
const BY_TYPE: ReadonlyMap<string, string> = new Map(
  DOM_EVENTS.map((name) => [name.toLowerCase(), name]),
);

/** Every DOM handler prop the compiler writes, for the test against Preact's types. */
export const DOM_EVENT_PROPS: readonly string[] = Object.freeze(
  DOM_EVENTS.flatMap((name) =>
    NO_CAPTURE.has(name) ? [`on${name}`] : [`on${name}`, `on${name}Capture`],
  ),
);

/**
 * The Preact prop of the DOM event `event` (`keydown` → `onKeyDown`), its
 * capture variant with `capture`; `undefined` for an event Preact has no
 * typed prop for, or no capture variant of.
 */
export function domEventProp(event: string, capture: boolean): string | undefined {
  const name = BY_TYPE.get(event.toLowerCase());
  if (name === undefined || (capture && NO_CAPTURE.has(name))) return undefined;
  return `on${name}${capture ? 'Capture' : ''}`;
}

/**
 * The prop of the component event `event`: `on`, then the event with each
 * `-x` folded to `X` and its first letter upper-cased (`change` →
 * `onChange`, `update-value` → `onUpdateValue`), as `defineEmits` names it.
 */
export function componentEventProp(event: string): string {
  const camel = event.replace(/-([a-z0-9])/gi, (_match, letter: string) => letter.toUpperCase());
  return `on${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

/** What an event handler's code is. */
export interface HandlerShape {
  /**
   * `reference`: a name or a function expression, which is the handler
   * itself; `method`: a member path, called through its object on the
   * event; `inline`: another expression, run on the event; `statements`:
   * statements, run on the event.
   */
  readonly form: 'reference' | 'method' | 'inline' | 'statements';
  /** Whether the code reads `$event` (a free `$event`, not a property or a parameter of its own). */
  readonly usesEvent: boolean;
}

const REFERENCE_TYPES: ReadonlySet<string> = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
]);

/**
 * The shape of a handler, given its code and whether the parser read it as
 * an expression or as statements.
 */
export function handlerShape(code: string, form: 'expression' | 'statements'): HandlerShape {
  const source = form === 'expression' ? `(${code}\n);` : code;
  const parsed = parseSync('handler.ts', source, { lang: 'ts', sourceType: 'module' });
  const usesEvent = collectFreeReferences(parsed.program).some(
    (reference) => reference.name === '$event',
  );
  if (form === 'statements') return { form: 'statements', usesEvent };
  const statement = parsed.program.body[0];
  let node = statement?.type === 'ExpressionStatement' ? statement.expression : undefined;
  while (node?.type === 'ParenthesizedExpression') node = node.expression;
  if (node === undefined) return { form: 'inline', usesEvent };
  if (REFERENCE_TYPES.has(node.type)) return { form: 'reference', usesEvent };
  if (usesEvent) return { form: 'inline', usesEvent };
  if (node.type === 'Identifier') return { form: 'reference', usesEvent };
  return { form: isMemberPath(node) ? 'method' : 'inline', usesEvent };
}

/** Whether an expression is a member path off a name (`a.b`, `a['b']`, `a.b[c]`). */
function isMemberPath(node: { readonly type: string }): boolean {
  let current = node as {
    readonly type: string;
    readonly object?: unknown;
    readonly optional?: boolean;
  };
  if (current.type !== 'MemberExpression') return false;
  while (current.type === 'MemberExpression') {
    if (current.optional === true) return false;
    current = current.object as typeof current;
  }
  return current.type === 'Identifier';
}
