/**
 * The keep-wrapper morph in a DOM: a parent with 500 stateful children runs
 * an action on the real runtime, and its reply, which holds every child by
 * reference, is morphed into a happy-dom document by Turbo's own morph with
 * the runtime's `turbo:before-morph-element` rule (`keepsNestedWrapper`).
 * Every child keeps its DOM node, its typed value, and its validation errors,
 * and no keep marker reaches the document; without the rule the same reply
 * would wipe the children, which is what the control case shows.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Window } from 'happy-dom';
import { z } from 'zod';

import { keepsNestedWrapper } from '../../src/client/bindings/index.js';
import type { RequestContext } from '../../src/contracts/http.js';
import { createServiceRegistry } from '../../src/extensions/services.js';
import { defineAction, defineServerComponent } from '../../src/server-components/component.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';
import { defineNestedComponent, renderNested } from '../../src/server-components/nested.js';
import {
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  NESTED_KEEP_ATTRIBUTE,
} from '../../src/server-components/protocol.js';
import { componentRegistryFromMap } from '../../src/server-components/registry.js';
import {
  createServerComponentsRuntime,
  type ServerComponentsRuntime,
} from '../../src/server-components/runtime/index.js';
import { HmacComponentSigner } from '../../src/server-components/snapshot.js';
import { callUpdate, updateBody } from '../server-components/lane-calls.js';

const KEY = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost';
const CHILDREN = 500;
const KEYS = Array.from({ length: CHILDREN }, (_, index) => `item-${index}`);

/** The part of Turbo's module this test drives. */
interface TurboMorph {
  morphElements(current: Element, next: Element): void;
}

/** Window members Node already defines that the document's own must replace. */
const REPLACED = new Set([
  'window',
  'self',
  'document',
  'navigator',
  'location',
  'history',
  'Event',
  'CustomEvent',
  'EventTarget',
]);

/**
 * Install a happy-dom window as the globals Turbo reads at import, and return
 * the function that restores the previous globals.
 */
function installWindow(window: Window): () => void {
  const names = new Set<string>();
  for (
    let target: object | null = window;
    target !== null && target !== Object.prototype;
    target = Object.getPrototypeOf(target) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(target)) names.add(name);
  }
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of names) {
    const existing = Object.getOwnPropertyDescriptor(globalThis, name);
    if (name in globalThis && !REPLACED.has(name)) continue;
    if (existing !== undefined && existing.configurable !== true) continue;
    let value: unknown;
    try {
      value = Reflect.get(window, name);
    } catch {
      // A getter that throws outside a page (an unsupported API) stays unset.
      continue;
    }
    if (typeof value === 'function' && /^[a-z]/u.test(name)) {
      value = (value as (...args: unknown[]) => unknown).bind(window);
    }
    previous.set(name, existing);
    Object.defineProperty(globalThis, name, {
      value: name === 'window' || name === 'self' ? window : value,
      configurable: true,
      writable: true,
    });
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
    }
  };
}

const card = defineServerComponent<{ note: string }>({
  name: 'card',
  stateSchema: z.object({ note: z.string() }).strict(),
  writableKeys: ['note'],
  initialState: () => ({ note: '' }),
  authorize: () => true,
  render: (state, { bind }) => <input {...bind('note')} value={state.note} />,
});

const list = defineServerComponent<{ title: string }>({
  name: 'list',
  stateSchema: z.object({ title: z.string() }).strict(),
  initialState: () => ({ title: 'list' }),
  authorize: () => true,
  actions: {
    rename: defineAction({
      run(state) {
        state.title = 'renamed';
      },
    }),
  },
  async render(state, { context }) {
    const children = await Promise.all(
      KEYS.map((key) =>
        renderNested(defineNestedComponent({ name: 'li', component: 'card', key }), context),
      ),
    );
    return (
      <div>
        <h2>{state.title}</h2>
        <ul>{children}</ul>
      </div>
    );
  },
});

function requestContext(runtime: ServerComponentsRuntime, post = false): RequestContext {
  const url = new URL('/', ORIGIN);
  const registry = createServiceRegistry();
  registry.registrar.provide(serverComponentsToken, runtime);
  registry.seal();
  return {
    request: !post
      ? new Request(url)
      : new Request(url, {
          method: 'POST',
          headers: { origin: ORIGIN },
        }),
    url,
    params: {},
    session: null,
    services: registry.services,
  };
}

let window: Window;
let restore: () => void;
let turbo: TurboMorph;

before(async () => {
  window = new Window({ url: `${ORIGIN}/` });
  restore = installWindow(window);
  turbo = await import('@hotwired/turbo');
});

after(async () => {
  restore();
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

/** Mount the list into the document and type into, and fail, every child. */
async function mountList(runtime: ServerComponentsRuntime): Promise<Element> {
  const { document } = window;
  document.body.innerHTML = await runtime.render('list', requestContext(runtime));
  const root = document.body.firstElementChild as unknown as Element;
  for (const [index, child] of Array.from(root.querySelectorAll('li > div')).entries()) {
    (child.querySelector('input') as unknown as { value: string }).value = `typed ${index}`;
    child.insertAdjacentHTML('beforeend', `<p role="alert">invalid ${index}</p>`);
  }
  return root;
}

/** Run `rename` holding every child, and parse the reply's root. */
async function renameHoldingAll(runtime: ServerComponentsRuntime, root: Element): Promise<Element> {
  const answer = await callUpdate(
    runtime,
    updateBody({
      snapshot: root.getAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE)!,
      action: { name: 'rename' },
      slots: KEYS.map((key) => ({ slot: `k:${key}`, component: 'card' })),
    }),
    requestContext(runtime, true),
  );
  assert.equal(answer.status, 200);
  assert.equal(answer.body.kind, 'render');
  const template = window.document.createElement('template');
  template.innerHTML = answer.body.html!;
  return template.content.firstElementChild as unknown as Element;
}

/** The runtime's `turbo:before-morph-element` rule, as `navigation.ts` installs it. */
function keepRule(event: { preventDefault(): void }): void {
  const detail = Reflect.get(event, 'detail') as
    { currentElement?: unknown; newElement?: unknown } | undefined;
  if (keepsNestedWrapper(detail?.currentElement, detail?.newElement)) event.preventDefault();
}

function makeRuntime(): ServerComponentsRuntime {
  return createServerComponentsRuntime({
    components: componentRegistryFromMap({ card, list }),
    signer: new HmacComponentSigner({ key: KEY }),
  });
}

describe('keep-wrapper morph', () => {
  it('keeps 500 children through a parent action: node, typed value, and errors', async () => {
    const runtime = makeRuntime();
    const root = await mountList(runtime);
    const before = Array.from(root.querySelectorAll('li > div'));
    assert.equal(before.length, CHILDREN);
    const next = await renameHoldingAll(runtime, root);

    window.document.addEventListener('turbo:before-morph-element', keepRule);
    try {
      turbo.morphElements(root, next);
    } finally {
      window.document.removeEventListener('turbo:before-morph-element', keepRule);
    }

    assert.equal(root.querySelector('h2')?.textContent, 'renamed');
    assert.equal(
      root.getAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE),
      next.getAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE),
    );
    assert.equal(root.querySelector(`[${NESTED_KEEP_ATTRIBUTE}]`), null);
    const kept = Array.from(root.querySelectorAll('li > div'));
    assert.equal(kept.length, CHILDREN);
    for (const [index, child] of kept.entries()) {
      assert.equal(child, before[index], `child ${index} is the same node`);
      assert.equal(
        (child.querySelector('input') as unknown as { value: string }).value,
        `typed ${index}`,
      );
      assert.equal(child.querySelector('[role="alert"]')?.textContent, `invalid ${index}`);
    }
  });

  it('would replace every child with its keep marker without the rule', async () => {
    const runtime = makeRuntime();
    const root = await mountList(runtime);
    const next = await renameHoldingAll(runtime, root);

    turbo.morphElements(root, next);

    assert.equal(root.querySelectorAll('li > div').length, 0);
    assert.equal(root.querySelectorAll(`[${NESTED_KEEP_ATTRIBUTE}]`).length, CHILDREN);
  });
});
