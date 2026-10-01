/**
 * A happy-dom window installed as the DOM globals ProseMirror's view and DOM
 * parser read, for the editor tests that need a document. Import it before
 * any module that loads `prosemirror-view`, since that module inspects the
 * environment when it is evaluated; call {@link closeEditorDom} once the
 * file's tests are done so the window's timers do not keep the process alive.
 *
 * Compare DOM nodes with {@link assertNode}, never with `node:assert`
 * directly: a failed `assert.equal` inspects both sides with getters at depth
 * 1000 (custom inspectors are skipped), which walks a happy-dom node's whole
 * window until the process runs out of memory, so a failing test would take
 * the machine down instead of failing.
 */

import assert from 'node:assert/strict';

import { Window } from 'happy-dom';

/** The window behind the installed globals. */
export const editorWindow: Window = new Window({ url: 'https://editor.test/' });

const INSTALLED = [
  'window',
  'document',
  'navigator',
  'Node',
  'Text',
  'Element',
  'HTMLElement',
  'DocumentFragment',
  'DOMParser',
  'MutationObserver',
  'Range',
  'Selection',
  'Event',
  'KeyboardEvent',
  'InputEvent',
  'CompositionEvent',
  'MouseEvent',
  'FocusEvent',
  'ClipboardEvent',
  'DataTransfer',
  'getSelection',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

const previous = new Map<string, PropertyDescriptor | undefined>();

for (const name of INSTALLED) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const value: unknown = name === 'window' ? editorWindow : Reflect.get(editorWindow, name);
  Object.defineProperty(globalThis, name, {
    value:
      typeof value === 'function' && /^[a-z]/.test(name)
        ? (value as (...args: unknown[]) => unknown).bind(editorWindow)
        : value,
    configurable: true,
    writable: true,
  });
}

/** A fresh element attached to the window's document body. */
export function attachedElement(): HTMLElement {
  const element = editorWindow.document.createElement('div');
  editorWindow.document.body.appendChild(element);
  return element as unknown as HTMLElement;
}

/** A node as a failure message names it: `<tag#id.class>`, or the value's type. */
export function describeNode(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return String(value);
  }
  const name: unknown = Reflect.get(value, 'nodeName');
  if (typeof name !== 'string') {
    return `a ${value.constructor.name}`;
  }
  const id: unknown = Reflect.get(value, 'id');
  const className: unknown = Reflect.get(value, 'className');
  const classes =
    typeof className === 'string' && className.trim() !== ''
      ? `.${className.trim().split(/\s+/).join('.')}`
      : '';
  return `<${name.toLowerCase()}${typeof id === 'string' && id !== '' ? `#${id}` : ''}${classes}>`;
}

/** Assert that `actual` is the node `expected` (or both are `null`), naming them on failure. */
export function assertNode(actual: unknown, expected: unknown, message = 'the node'): void {
  if (actual !== expected) {
    assert.fail(`${message}: expected ${describeNode(expected)}, got ${describeNode(actual)}`);
  }
}

/** Restore the globals and close the window. */
export async function closeEditorDom(): Promise<void> {
  for (const [name, descriptor] of previous) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, name);
    } else {
      Object.defineProperty(globalThis, name, descriptor);
    }
  }
  await editorWindow.happyDOM.abort();
  await editorWindow.happyDOM.close();
}
