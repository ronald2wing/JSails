/**
 * Component DOM binding-layer tests (Node-import safe).
 *
 * These exercise the DOM half of the component story against a small structural
 * `document`/element double: bootstrap from the server markers, delegated
 * input/change capture, click/submit action dispatch with explicit args, scope
 * and island exclusion, morph retargeting with caret preservation, the 422 vs
 * fatal split, and dispose/rebind. They deliberately do NOT simulate a real
 * browser or Preact hydration — that is owned by the integration fixture.
 *
 * The double is a focused contract stand-in, not a blanket DOM mock: it models
 * only the members `components.ts` touches, so the binding layer's own decisions
 * (which events it handles, what it sends, how it morphs) are asserted without
 * claiming any visual proof.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  COMPONENT_BLOCKED_MESSAGE,
  COMPONENT_UPLOAD_FAILED_MESSAGE,
  ComponentBindingError,
  createComponentBindings,
  evaluateFieldRules,
  keepsNestedWrapper,
  parseActionArgs,
  parseFieldRules,
  readControlValue,
  type ComponentBindings,
  type ComponentDocument,
  type ComponentElement,
} from '../../src/client/bindings/index.js';
import type { PollSignals } from '../../src/client/polling.js';
import { createTriggerQueue, type TriggerQueue } from '../../src/client/trigger-queue.js';
import {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  CAPTURE_ATTRIBUTE,
  COMPONENT_ATTRIBUTE,
  COMPONENT_RENDER_ATTRIBUTE,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  COMPONENT_UPLOAD_ENDPOINT,
  COMPONENT_UPLOAD_FILE_FIELD,
  COMPONENT_UPLOAD_MAX_BYTES_ATTRIBUTE,
  COMPONENT_UPLOAD_SNAPSHOT_FIELD,
  COMPONENT_UPLOADING_ATTRIBUTE,
  CONFIRM_ATTRIBUTE,
  DEBOUNCE_ATTRIBUTE,
  DIRTY_ATTRIBUTE,
  ERROR_FOR_ATTRIBUTE,
  IGNORE_ATTRIBUTE,
  INTERSECT_ATTRIBUTE,
  LAZY_ATTRIBUTE,
  LOADING_ATTRIBUTE,
  LOADING_TARGET_ATTRIBUTE,
  MODEL_ATTRIBUTE,
  NESTED_COMPONENT_ATTRIBUTE,
  NESTED_KEEP_ATTRIBUTE,
  NESTED_SLOT_ATTRIBUTE,
  NUMBER_ATTRIBUTE,
  ONCE_ATTRIBUTE,
  PASSIVE_ATTRIBUTE,
  POLL_ATTRIBUTE,
  REF_ATTRIBUTE,
  REFRESH_ACTION,
  RULES_ATTRIBUTE,
  SHOW_ATTRIBUTE,
  SORT_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
  TEXT_ATTRIBUTE,
  TRIM_ATTRIBUTE,
  UPLOAD_REFERENCE_KEY,
} from '../../src/server-components/protocol.js';
import {
  ISLAND_ATTRIBUTE,
  ISLAND_HYDRATED_ATTRIBUTE,
  type IslandManager,
  type JsailsEvent,
} from '../../src/client/islands.js';
import type {
  ComponentUploadFile,
  ComponentUploadXhr,
  ComponentUploadXhrFactory,
} from '../../src/client/component-upload.js';
import { ComponentControllerError } from '../../src/client/component-controller.js';

// ---------------------------------------------------------------------------
// Structural doubles
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost';

interface FakeElement extends ComponentElement {
  readonly attributes: Map<string, string>;
  readonly children: FakeElement[];
  parentElement: FakeElement | null;
  isConnected: boolean;
  textContent: string | null;
  innerHTML: string;
  value?: string;
  checked?: boolean;
  type?: string;
  multiple?: boolean;
  selectedOptions?: ArrayLike<{ readonly value: string }>;
  files?: ArrayLike<ComponentUploadFile>;
  focused: boolean;
  readonly listeners: Map<string, Array<(event: JsailsEvent) => void>>;
}

function fakeElement(
  tagName: string,
  attrs: Record<string, string> = {},
  options: { id?: string } = {},
): FakeElement {
  const attributes = new Map<string, string>(Object.entries(attrs));
  const element: FakeElement = {
    tagName,
    id: options.id ?? attributes.get('id') ?? '',
    attributes,
    children: [],
    parentElement: null,
    isConnected: true,
    textContent: null,
    innerHTML: '',
    // A real DOM reflects these content attributes onto IDL properties; the
    // binding layer reads the properties, so the double must too.
    type: attributes.get('type'),
    multiple: attributes.has('multiple') ? true : undefined,
    focused: false,
    listeners: new Map(),
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => {
      attributes.set(name, value);
      if (name === 'type') {
        element.type = value;
      } else if (name === 'multiple') {
        element.multiple = true;
      }
    },
    removeAttribute: (name) => {
      attributes.delete(name);
      if (name === 'type') {
        element.type = undefined;
      } else if (name === 'multiple') {
        element.multiple = false;
      }
    },
    hasAttribute: (name) => attributes.has(name),
    querySelector: (selector) => querySelector(element, selector),
    querySelectorAll: (selector) => querySelectorAll(element, selector),
    closest: (selector) => closest(element, selector),
    addEventListener: (type, listener) => {
      const list = element.listeners.get(type) ?? [];
      list.push(listener);
      element.listeners.set(type, list);
    },
    removeEventListener: (type, listener) => {
      const list = (element.listeners.get(type) ?? []).filter((l) => l !== listener);
      element.listeners.set(type, list);
    },
    insertAdjacentElement: (position, newElement) => {
      const parent = element.parentElement;
      if (parent === null) {
        return;
      }
      const fake = newElement as FakeElement;
      fake.parentElement = parent;
      const index = parent.children.indexOf(element);
      parent.children.splice(position === 'beforebegin' ? index : index + 1, 0, fake);
    },
    remove: () => {
      const parent = element.parentElement;
      if (parent !== null) {
        const index = parent.children.indexOf(element);
        if (index !== -1) {
          parent.children.splice(index, 1);
        }
      }
      element.parentElement = null;
    },
    focus: () => {
      element.focused = true;
    },
  };
  return element;
}

function append(parent: FakeElement, child: FakeElement): FakeElement {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function descendants(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of root.children) {
    out.push(child, ...descendants(child));
  }
  return out;
}

/** Minimal selector support: `[attr]`, `tag`, `#id`, and `tag[attr]`. */
function matches(element: FakeElement, selector: string): boolean {
  const attrMatch = /^\[([^\]]+)\]$/.exec(selector);
  if (attrMatch !== null) {
    return element.hasAttribute(attrMatch[1]!);
  }
  const idMatch = /^#(.+)$/.exec(selector);
  if (idMatch !== null) {
    return element.id === idMatch[1];
  }
  const tagAttr = /^([a-z]+)\[([^\]]+)\]$/.exec(selector);
  if (tagAttr !== null) {
    return element.tagName.toLowerCase() === tagAttr[1] && element.hasAttribute(tagAttr[2]!);
  }
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

function querySelectorAll(root: FakeElement, selector: string): FakeElement[] {
  return descendants(root).filter((element) => matches(element, selector));
}

function querySelector(root: FakeElement, selector: string): FakeElement | null {
  return querySelectorAll(root, selector)[0] ?? null;
}

function closest(element: FakeElement, selector: string): FakeElement | null {
  let current: FakeElement | null = element;
  while (current !== null) {
    if (matches(current, selector)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

interface FakeDocument extends ComponentDocument {
  readonly roots: FakeElement[];
  readonly listeners: Map<string, Array<(event: JsailsEvent) => void>>;
  /** The options argument each document listener was registered with. */
  readonly listenerOptions: Map<string, unknown[]>;
}

function fakeDocument(roots: FakeElement[] = []): FakeDocument {
  const listeners = new Map<string, Array<(event: JsailsEvent) => void>>();
  const listenerOptions = new Map<string, unknown[]>();
  const all = (): FakeElement[] => roots.flatMap((root) => [root, ...descendants(root)]);
  return {
    roots,
    listeners,
    listenerOptions,
    querySelectorAll: (selector) => all().filter((element) => matches(element, selector)),
    querySelector: (selector) => all().find((element) => matches(element, selector)) ?? null,
    getElementById: (id) => all().find((element) => element.id === id) ?? null,
    createElement: (tagName) => fakeElement(tagName),
    addEventListener: (type, listener, options) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
      const optionList = listenerOptions.get(type) ?? [];
      optionList.push(options);
      listenerOptions.set(type, optionList);
    },
    removeEventListener: (type, listener) => {
      const list = (listeners.get(type) ?? []).filter((l) => l !== listener);
      listeners.set(type, list);
    },
    dispatchEvent: () => false,
  };
}

function fakeEvent(
  type: string,
  target: FakeElement | null,
  detail?: unknown,
): JsailsEvent & { prevented: boolean } {
  const event = {
    type,
    target,
    detail,
    prevented: false,
    preventDefault: () => {
      event.prevented = true;
    },
  };
  return event;
}

function dispatch(doc: FakeDocument, event: JsailsEvent): void {
  for (const listener of doc.listeners.get(event.type) ?? []) {
    listener(event);
  }
}

/** Whether a recorded listener option object requests capture phase. */
function isCaptureOption(options: unknown): boolean {
  return (
    typeof options === 'object' &&
    options !== null &&
    (options as { capture?: unknown }).capture === true
  );
}

/** Whether a recorded listener option object requests passive mode. */
function isPassiveOption(options: unknown): boolean {
  return (
    typeof options === 'object' &&
    options !== null &&
    (options as { passive?: unknown }).passive === true
  );
}

// ---------------------------------------------------------------------------
// Fake observer (for intersect directive tests)
// ---------------------------------------------------------------------------

interface FakeIntersectionObserverEntry {
  readonly target: FakeElement;
  readonly isIntersecting: boolean;
}

interface FakeIntersectionObserver {
  callback: (entries: readonly FakeIntersectionObserverEntry[]) => void;
  observed: FakeElement[];
  disconnected: boolean;
  observe(element: FakeElement): void;
  unobserve(element: FakeElement): void;
  disconnect(): void;
}

function fakeIntersectionObserverFactory(): {
  factory: (
    callback: (entries: readonly FakeIntersectionObserverEntry[]) => void,
  ) => FakeIntersectionObserver;
  created: FakeIntersectionObserver[];
} {
  const created: FakeIntersectionObserver[] = [];
  const factory = (callback: (entries: readonly FakeIntersectionObserverEntry[]) => void) => {
    const observer: FakeIntersectionObserver = {
      callback,
      observed: [],
      disconnected: false,
      observe(element) {
        observer.observed.push(element);
      },
      unobserve(element) {
        observer.observed = observer.observed.filter((e) => e !== element);
      },
      disconnect() {
        observer.disconnected = true;
        observer.observed = [];
      },
    };
    created.push(observer);
    return observer;
  };
  return { factory, created };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeToken(state: Record<string, unknown>): string {
  const payload = {
    v: 1,
    component: 'Counter',
    id: 'counter-1',
    state,
    page: { path: '/', params: {} },
    origin: ORIGIN,
    subject: null,
    expiresAt: Date.now() + 3_600_000,
  };
  return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${'A'.repeat(43)}`;
}

function componentRoot(
  id: string,
  state: Record<string, unknown> = { title: 'hello', count: 0 },
): FakeElement {
  return fakeElement('div', {
    id,
    [COMPONENT_ATTRIBUTE]: 'Counter',
    [COMPONENT_SNAPSHOT_ATTRIBUTE]: makeToken(state),
  });
}

function modelInput(name: string, value: string, type = 'text'): FakeElement {
  const input = fakeElement('input', { [MODEL_ATTRIBUTE]: name, type });
  input.value = value;
  return input;
}

interface Harness {
  readonly doc: FakeDocument;
  readonly bindings: ComponentBindings;
  readonly morphs: Array<{ target: string; html: string }>;
  readonly errors: unknown[];
  readonly fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;
  resolveNext(response: Response): void;
}

/**
 * Bindings each test opened. A test may end with a request still pending on
 * the default fetch double; the controller's request timeout (30 s) would
 * then keep the process alive long after the last test, so every binding is
 * disposed after its test, which aborts that request and clears the timer.
 */
const openBindings = new Set<ComponentBindings>();

afterEach(() => {
  for (const bindings of openBindings) bindings.disposeAll();
  openBindings.clear();
});

function harness(
  roots: FakeElement[],
  options: {
    islands?: IslandManager;
    morph?: (target: string, html: string) => Promise<void>;
    fetch?: (url: string, init: { body: string }) => Promise<Response>;
    uploadRequest?: ComponentUploadXhrFactory;
    pollSignals?: PollSignals;
    confirm?: (message: string) => boolean;
    navigate?: (url: string) => void;
    /** Build the injected trigger queue over the harness document. */
    triggers?: (doc: FakeDocument) => TriggerQueue;
    createIntersectionObserver?: (
      callback: (entries: readonly FakeIntersectionObserverEntry[]) => void,
    ) => FakeIntersectionObserver;
  } = {},
): Harness {
  const doc = fakeDocument(roots);
  const morphs: Array<{ target: string; html: string }> = [];
  const errors: unknown[] = [];
  const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let pending: ((response: Response) => void) | null = null;

  const bindings = createComponentBindings({
    document: doc,
    origin: ORIGIN,
    morph:
      options.morph ??
      (async (target, html) => {
        morphs.push({ target, html });
      }),
    ...(options.islands === undefined ? {} : { islands: options.islands }),
    ...(options.uploadRequest === undefined ? {} : { uploadRequest: options.uploadRequest }),
    ...(options.pollSignals === undefined ? {} : { pollSignals: options.pollSignals }),
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.navigate === undefined ? {} : { navigate: options.navigate }),
    ...(options.triggers === undefined ? {} : { triggers: options.triggers(doc) }),
    ...(options.createIntersectionObserver === undefined
      ? {}
      : { createIntersectionObserver: options.createIntersectionObserver }),
    onError: (error) => {
      errors.push(error);
    },
    fetch: async (url, init) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      if (options.fetch !== undefined) {
        return options.fetch(url, init);
      }
      return new Promise<Response>((resolve, reject) => {
        pending = resolve;
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });
  openBindings.add(bindings);

  return {
    doc,
    bindings,
    morphs,
    errors,
    fetchCalls,
    resolveNext(response) {
      assert.ok(pending, 'no pending fetch to resolve');
      const resolve = pending;
      pending = null;
      resolve(response);
    },
  };
}

function successResponse(
  sequence: number,
  state: Record<string, unknown>,
  html = '<div>ok</div>',
  redirect?: string,
): Response {
  const body: Record<string, unknown> = {
    kind: 'render',
    sequence,
    snapshot: makeToken(state),
    html,
    render: `render-${sequence}`,
  };
  if (redirect !== undefined) {
    body.effects = { redirect };
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function invalidResponse(
  sequence: number,
  errors: Record<string, string>,
  html = '<div>err</div>',
): Response {
  return new Response(
    JSON.stringify({ kind: 'invalid', sequence, errors, html, render: `invalid-${sequence}` }),
    {
      status: 422,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Drain pending microtasks while fake timers are active (`setImmediate` stays real). */
function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function testFile(name = 'avatar.png', content = 'image-bytes'): File {
  return new File([new Uint8Array(Buffer.from(content, 'utf8'))], name, { type: 'image/png' });
}

interface FakeUploadXhr extends ComponentUploadXhr {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: FormData | null;
  status: number;
  responseText: string;
  abort(): void;
}

function fakeUploadXhrFactory(): { factory: ComponentUploadXhrFactory; created: FakeUploadXhr[] } {
  const created: FakeUploadXhr[] = [];
  const factory: ComponentUploadXhrFactory = () => {
    const xhr: FakeUploadXhr = {
      method: '',
      url: '',
      headers: {},
      body: null,
      upload: { onprogress: null },
      status: 0,
      responseText: '',
      onload: null,
      onerror: null,
      onabort: null,
      open(method, url) {
        xhr.method = method;
        xhr.url = url;
      },
      setRequestHeader(name, value) {
        xhr.headers[name] = value;
      },
      send(body) {
        xhr.body = body;
      },
      abort() {
        xhr.onabort?.();
      },
    };
    created.push(xhr);
    return xhr;
  };
  return { factory, created };
}

function makePollSignals(initial: { hidden?: boolean; online?: boolean } = {}): {
  signals: PollSignals;
  set(patch: { hidden?: boolean; online?: boolean }): void;
} {
  const state = { hidden: initial.hidden ?? false, online: initial.online ?? true };
  const listeners = new Set<() => void>();
  const signals: PollSignals = {
    get hidden() {
      return state.hidden;
    },
    get online() {
      return state.online;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    signals,
    set(patch) {
      Object.assign(state, patch);
      for (const listener of Array.from(listeners)) {
        listener();
      }
    },
  };
}

/** A fetch double that echoes the request sequence and returns a fresh success envelope. */
const echoFetch = async (_url: string, init: { body: string }): Promise<Response> => {
  const body = JSON.parse(init.body) as Record<string, unknown>;
  return successResponse(body.sequence as number, { title: 'hello', count: 0 });
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('readControlValue', () => {
  it('reads text, checkbox, number, and multi-select values', () => {
    const text = modelInput('title', 'hi');
    assert.equal(readControlValue(text), 'hi');

    const checkbox = fakeElement('input', { type: 'checkbox' });
    checkbox.checked = true;
    assert.equal(readControlValue(checkbox), true);

    const number = modelInput('count', '42', 'number');
    assert.equal(readControlValue(number), 42);

    const emptyNumber = modelInput('count', '', 'number');
    assert.equal(readControlValue(emptyNumber), '');

    const select = fakeElement('select', { multiple: 'true' });
    select.multiple = true;
    select.selectedOptions = [{ value: 'a' }, { value: 'b' }];
    assert.deepEqual(readControlValue(select), ['a', 'b']);
  });
});

describe('parseActionArgs', () => {
  it('accepts absent/empty as an empty object and rejects malformed JSON', () => {
    assert.deepEqual(parseActionArgs(null), {});
    assert.deepEqual(parseActionArgs(''), {});
    assert.deepEqual(parseActionArgs('{"id":1}'), { id: 1 });
    assert.equal(parseActionArgs('{bad'), null);
    assert.equal(parseActionArgs('[1,2]'), null);
    assert.equal(parseActionArgs('"str"'), null);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

describe('createComponentBindings bootstrap', () => {
  it('binds every component root and marks it hydrated', () => {
    const root = componentRoot('counter-1');
    const h = harness([root]);

    h.bindings.mountAll();

    assert.equal(h.bindings.size, 1);
    assert.equal(root.getAttribute(ISLAND_HYDRATED_ATTRIBUTE), 'true');
  });

  it('reports a root missing its snapshot marker without binding', () => {
    const root = fakeElement('div', { id: 'counter-1', [COMPONENT_ATTRIBUTE]: 'Counter' });
    const h = harness([root]);

    h.bindings.mountAll();

    assert.equal(h.bindings.size, 0);
    assert.equal(h.errors.length, 1);
    assert.ok(h.errors[0] instanceof ComponentBindingError);
  });

  it('rejects invalid construction options', () => {
    const doc = fakeDocument();
    assert.throws(
      () => createComponentBindings({ document: doc, origin: ORIGIN, morph: undefined as never }),
      ComponentBindingError,
    );
    assert.throws(
      () => createComponentBindings({ document: doc, origin: '', morph: async () => {} }),
      ComponentBindingError,
    );
  });
});

// ---------------------------------------------------------------------------
// Delegated input/change
// ---------------------------------------------------------------------------

describe('delegated input capture', () => {
  it('writes a model control value into the controller on input', () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    const h = harness([root]);
    h.bindings.mountAll();

    input.value = 'changed';
    dispatch(h.doc, fakeEvent('input', input));

    // The next action carries the captured value.
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    dispatch(h.doc, fakeEvent('click', trigger));
    assert.deepEqual(h.fetchCalls[0]!.body.updates, { title: 'changed' });
  });

  it('ignores a control outside any component root', () => {
    const root = componentRoot('counter-1');
    const outside = modelInput('title', 'x');
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('input', outside));
    // No binding exists for the outside control; nothing is dispatched.
    assert.equal(h.fetchCalls.length, 0);
  });

  it('excludes controls owned by a client island', () => {
    const root = componentRoot('counter-1');
    const island = append(root, fakeElement('div', { [ISLAND_ATTRIBUTE]: 'counter' }));
    const islandInput = append(island, modelInput('title', 'island-owned'));
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('input', islandInput));

    // The island control is out of scope: a subsequent action sends no update.
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    dispatch(h.doc, fakeEvent('click', trigger));
    assert.deepEqual(h.fetchCalls[0]!.body.updates, {});
  });
});

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

describe('action dispatch', () => {
  it('dispatches a click action with explicit args and captured values', () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    const trigger = append(
      root,
      fakeElement('button', { [CALL_ATTRIBUTE]: 'increment', [ARGS_ATTRIBUTE]: '{"by":2}' }),
    );
    const h = harness([root]);
    h.bindings.mountAll();

    input.value = 'typed';
    const event = fakeEvent('click', trigger);
    dispatch(h.doc, event);

    assert.equal(event.prevented, true);
    assert.equal(h.fetchCalls.length, 1);
    assert.deepEqual(h.fetchCalls[0]!.body.action, { name: 'increment', args: { by: 2 } });
    assert.deepEqual(h.fetchCalls[0]!.body.updates, { title: 'typed' });
  });

  it('dispatches a submit action and prevents the native default', () => {
    const root = componentRoot('counter-1');
    const form = append(root, fakeElement('form', { [SUBMIT_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('submit', form);
    dispatch(h.doc, event);

    assert.equal(event.prevented, true);
    assert.deepEqual(h.fetchCalls[0]!.body.action, { name: 'save', args: {} });
  });

  it('reports malformed args and does not dispatch, but still prevents the default', () => {
    const root = componentRoot('counter-1');
    const trigger = append(
      root,
      fakeElement('button', { [CALL_ATTRIBUTE]: 'save', [ARGS_ATTRIBUTE]: '{bad' }),
    );
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('click', trigger);
    dispatch(h.doc, event);

    // A JSails trigger never falls through to the browser default.
    assert.equal(event.prevented, true);
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.errors.length, 1);
  });

  it('ignores a click with no call marker', () => {
    const root = componentRoot('counter-1');
    const plain = append(root, fakeElement('button'));
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('click', plain);
    dispatch(h.doc, event);

    assert.equal(event.prevented, false);
    assert.equal(h.fetchCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Eager trigger queue and widget hosts
// ---------------------------------------------------------------------------

describe('eager trigger queue', () => {
  it('replays a trigger held before mount, in order, once the bindings open the queue', () => {
    const root = componentRoot('counter-1');
    const form = append(root, fakeElement('form', { [SUBMIT_ATTRIBUTE]: 'save' }));
    const button = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'increment' }));
    let queue!: TriggerQueue;
    const h = harness([root], {
      triggers: (doc) => (queue = createTriggerQueue(doc)),
    });

    const submit = fakeEvent('submit', form);
    const click = fakeEvent('click', button);
    dispatch(h.doc, submit);
    dispatch(h.doc, click);
    assert.equal(submit.prevented, true, 'held, not left to the browser');
    assert.equal(click.prevented, true);
    assert.equal(h.fetchCalls.length, 0, 'nothing runs before the bindings mount');
    assert.equal(queue.size, 2);

    h.bindings.mountAll();
    // The controller serializes: the submit is in flight, the click queued behind it.
    assert.equal(h.fetchCalls.length, 1);
    assert.deepEqual(h.fetchCalls[0]!.body.action, { name: 'save', args: {} });
    assert.equal(queue.size, 0);
  });

  it('holds an injected queue while disposed and replays on the remounted root', () => {
    const root = componentRoot('counter-1');
    const button = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'increment' }));
    let queue!: TriggerQueue;
    const h = harness([root], { triggers: (doc) => (queue = createTriggerQueue(doc)) });
    h.bindings.mountAll();
    h.bindings.disposeAll();

    dispatch(h.doc, fakeEvent('click', button));
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(queue.size, 1, 'the runtime-owned queue is held, not disposed');

    h.bindings.mountAll();
    assert.equal(h.fetchCalls.length, 1);
    queue.dispose();
  });

  it('installs and disposes its own queue when none is injected', () => {
    const root = componentRoot('counter-1');
    const h = harness([root]);
    h.bindings.mountAll();
    // One capturing and one bubbling listener.
    assert.equal(h.doc.listeners.get('submit')?.length, 2);
    h.bindings.disposeAll();
    assert.equal(h.doc.listeners.get('submit')?.length, 0);
    assert.equal(h.doc.listeners.get('click')?.length, 0);
  });
});

describe('widget hosts', () => {
  /** Install a browser-like FormData over fake forms for one test. */
  function installFormData(
    t: { after(fn: () => void): void },
    entries: Record<string, readonly unknown[]>,
  ): { built: number } {
    const g = globalThis as Record<string, unknown>;
    const saved = { FormData: g.FormData, HTMLFormElement: g.HTMLFormElement };
    t.after(() => {
      g.FormData = saved.FormData;
      if (saved.HTMLFormElement === undefined) delete g.HTMLFormElement;
      else g.HTMLFormElement = saved.HTMLFormElement;
    });
    const counter = { built: 0 };
    class FakeForm {}
    g.HTMLFormElement = FakeForm;
    g.FormData = class {
      constructor() {
        counter.built += 1;
      }
      getAll(name: string): readonly unknown[] {
        return entries[name] ?? [];
      }
    };
    return Object.assign(counter, { FakeForm });
  }

  it('sends the value a widget wrote into the submission, beside the native fields', (t) => {
    const formData = installFormData(t, { body: ['{"type":"doc"}'], title: ['from-formdata'] });
    const root = componentRoot('counter-1', { title: 'hello', count: 0, body: '' });
    const form = append(root, fakeElement('form', { [SUBMIT_ATTRIBUTE]: 'save' }));
    Object.setPrototypeOf(
      form,
      (formData as unknown as { FakeForm: { prototype: object } }).FakeForm.prototype,
    );
    const input = append(form, modelInput('title', 'typed'));
    input.setAttribute('name', 'title');
    append(form, fakeElement('div', { [MODEL_ATTRIBUTE]: 'body' }));
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('submit', form));

    assert.equal(formData.built, 1, 'the submission is built once, firing formdata');
    // The native control keeps its typed read; the widget host its entry.
    assert.deepEqual(h.fetchCalls[0]!.body.updates, { title: 'typed', body: '{"type":"doc"}' });
  });

  it('counts a widget host that is itself an island, but none inside another island or an ignored subtree', (t) => {
    const formData = installFormData(t, {
      body: ['{"type":"doc"}'],
      nested: ['inner'],
      skipped: ['ignored'],
    });
    const root = componentRoot('counter-1', { title: 'hello', count: 0, body: '' });
    const form = append(root, fakeElement('form', { [SUBMIT_ATTRIBUTE]: 'save' }));
    Object.setPrototypeOf(
      form,
      (formData as unknown as { FakeForm: { prototype: object } }).FakeForm.prototype,
    );
    // The editor case: the island element carries the component's model name.
    const editor = append(
      form,
      fakeElement('div', { [MODEL_ATTRIBUTE]: 'body', [ISLAND_ATTRIBUTE]: 'rich-text' }),
    );
    append(editor, fakeElement('div', { [MODEL_ATTRIBUTE]: 'nested' }));
    const ignored = append(form, fakeElement('div', { [IGNORE_ATTRIBUTE]: '' }));
    append(ignored, fakeElement('div', { [MODEL_ATTRIBUTE]: 'skipped' }));
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('submit', form));

    assert.deepEqual(h.fetchCalls[0]!.body.updates, { body: '{"type":"doc"}' });
  });

  it('never reads a widget host as a native control', () => {
    const root = componentRoot('counter-1', { title: 'hello', count: 0, body: 'kept' });
    const form = append(root, fakeElement('form', { [SUBMIT_ATTRIBUTE]: 'save' }));
    const widget = append(form, fakeElement('div', { [MODEL_ATTRIBUTE]: 'body' }));
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('input', widget));
    dispatch(h.doc, fakeEvent('submit', form));

    // Outside a browser form there is no submission, so nothing is sent for it.
    assert.deepEqual(h.fetchCalls[0]!.body.updates, {});
  });
});

// ---------------------------------------------------------------------------
// Event modifiers (.once / .capture / .passive)
// ---------------------------------------------------------------------------

describe('event modifiers', () => {
  it('registers the trigger listeners in both phases and the passive listeners', () => {
    const root = componentRoot('counter-1');
    const h = harness([root]);
    h.bindings.mountAll();

    // Click and submit triggers are resolved in the capture phase and
    // dispatched in the bubble phase.
    for (const type of ['click', 'submit']) {
      const options = h.doc.listenerOptions.get(type) ?? [];
      assert.deepEqual(options.map(isCaptureOption), [true, false]);
    }
    // The passive input/change listeners are registered with `{ passive: true }`.
    for (const type of ['input', 'change']) {
      const options = h.doc.listenerOptions.get(type) ?? [];
      assert.ok(options.some((option) => isPassiveOption(option)));
    }
  });

  it('dispatches a .once trigger exactly once', () => {
    const root = componentRoot('counter-1');
    const trigger = append(
      root,
      fakeElement('button', { [CALL_ATTRIBUTE]: 'increment', [ONCE_ATTRIBUTE]: '' }),
    );
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('click', trigger));
    dispatch(h.doc, fakeEvent('click', trigger));

    assert.equal(h.fetchCalls.length, 1);
  });

  it('dispatches a .once form exactly once', () => {
    const root = componentRoot('counter-1');
    const form = append(
      root,
      fakeElement('form', { [SUBMIT_ATTRIBUTE]: 'save', [ONCE_ATTRIBUTE]: '' }),
    );
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('submit', form));
    dispatch(h.doc, fakeEvent('submit', form));

    assert.equal(h.fetchCalls.length, 1);
  });

  it('dispatches a .capture trigger exactly once', () => {
    const root = componentRoot('counter-1');
    const trigger = append(
      root,
      fakeElement('button', { [CALL_ATTRIBUTE]: 'increment', [CAPTURE_ATTRIBUTE]: '' }),
    );
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('click', trigger));

    assert.equal(h.fetchCalls.length, 1);
  });

  it('captures a .passive control edit exactly once', () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    input.setAttribute(PASSIVE_ATTRIBUTE, '');
    const h = harness([root]);
    h.bindings.mountAll();

    input.value = 'changed';
    dispatch(h.doc, fakeEvent('input', input));

    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    dispatch(h.doc, fakeEvent('click', trigger));
    assert.deepEqual(h.fetchCalls[0]!.body.updates, { title: 'changed' });
  });
});

// ---------------------------------------------------------------------------
// Morph, retarget, caret, 422, fatal
// ---------------------------------------------------------------------------

describe('render handling', () => {
  it('morphs the root, retargets the controller, and reapplies working values', async () => {
    // Case 1: the value that was submitted is normalized on the server, so the
    // server render wins over the already-sent local edit.
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    input.value = 'typed';
    dispatch(h.doc, fakeEvent('click', trigger));

    // The morph replaces the root element with a fresh one carrying new markup.
    const replacement = componentRoot('counter-1', { title: 'server', count: 5 });
    const replacementInput = append(replacement, modelInput('title', 'server'));
    h.doc.roots[0] = replacement;
    h.resolveNext(successResponse(1, { title: 'server', count: 5 }));
    await flush();

    assert.deepEqual(h.morphs, [{ target: 'counter-1', html: '<div>ok</div>' }]);
    // The submitted edit was incorporated (and normalized) by the server.
    assert.equal(replacementInput.value, 'server');
    assert.equal(replacement.getAttribute(ISLAND_HYDRATED_ATTRIBUTE), 'true');

    // Case 2: a newer local edit made while the response is in flight is not
    // part of the server render and must survive it.
    const laterRoot = componentRoot('counter-1');
    const laterInput = append(laterRoot, modelInput('title', 'hello'));
    const laterTrigger = append(laterRoot, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const later = harness([laterRoot]);
    later.bindings.mountAll();

    laterInput.value = 'typed';
    dispatch(later.doc, fakeEvent('click', laterTrigger));
    // The response is still delayed; the user edits again before it arrives.
    laterInput.value = 'newer';
    dispatch(later.doc, fakeEvent('input', laterInput));

    const laterReplacement = componentRoot('counter-1', { title: 'server', count: 5 });
    const laterReplacementInput = append(laterReplacement, modelInput('title', 'server'));
    later.doc.roots[0] = laterReplacement;
    later.resolveNext(successResponse(1, { title: 'server', count: 5 }));
    await flush();

    // Server state is canonical, but the newer unsent edit survives on top.
    assert.equal(laterReplacementInput.value, 'newer');
  });

  it('re-keys a fully replaced root so the next input/click reuse the same binding', async () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    // A render fully replaces the root element with a fresh one.
    dispatch(h.doc, fakeEvent('click', trigger));
    const replacement = componentRoot('counter-1', { title: 'server', count: 1 });
    const replacementInput = append(replacement, modelInput('title', 'server'));
    const replacementTrigger = append(
      replacement,
      fakeElement('button', { [CALL_ATTRIBUTE]: 'increment' }),
    );
    h.doc.roots[0] = replacement;
    h.resolveNext(successResponse(1, { title: 'server', count: 1 }));
    await flush();

    // Re-keyed, not duplicated: the stale key was removed and the new one added.
    assert.equal(h.bindings.size, 1);

    // The detached old element no longer routes events to the controller.
    input.value = 'stale';
    dispatch(h.doc, fakeEvent('input', input));

    // A new input on the replacement and its click reuse the same controller.
    replacementInput.value = 'fresh';
    dispatch(h.doc, fakeEvent('input', replacementInput));
    dispatch(h.doc, fakeEvent('click', replacementTrigger));

    assert.equal(h.fetchCalls.length, 2);
    assert.deepEqual(h.fetchCalls[1]!.body.action, { name: 'increment', args: {} });
    assert.deepEqual(h.fetchCalls[1]!.body.updates, { title: 'fresh' });
  });

  it('leaves an unchanged control untouched so its caret is preserved', async () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    // No local edit: the control already matches the server value.
    dispatch(h.doc, fakeEvent('click', trigger));
    h.resolveNext(successResponse(1, { title: 'hello', count: 0 }));
    await flush();

    assert.equal(input.value, 'hello');
  });

  it('morphs the server HTML on a 422 and keeps local edits', async () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    input.value = 'too-long';
    dispatch(h.doc, fakeEvent('click', trigger));
    h.resolveNext(invalidResponse(1, { title: 'Too long' }, '<div>invalid</div>'));
    await flush();

    assert.deepEqual(h.morphs, [{ target: 'counter-1', html: '<div>invalid</div>' }]);
    assert.equal(input.value, 'too-long');
  });

  it('shows the fixed plaintext message on a fatal error, never raw HTML', async () => {
    const root = componentRoot('counter-1');
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('click', trigger));
    h.resolveNext(new Response('boom', { status: 500 }));
    await flush();

    assert.equal(root.textContent, COMPONENT_BLOCKED_MESSAGE);
    assert.equal(h.morphs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('disposeAll removes listeners, clears bindings, and drops the marker', () => {
    const root = componentRoot('counter-1');
    const h = harness([root]);
    h.bindings.mountAll();
    assert.equal(root.getAttribute(ISLAND_HYDRATED_ATTRIBUTE), 'true');

    h.bindings.disposeAll();

    assert.equal(h.bindings.size, 0);
    assert.equal(root.getAttribute(ISLAND_HYDRATED_ATTRIBUTE), null);
    assert.equal(h.doc.listeners.get('click')?.length ?? 0, 0);
  });

  it('collectRemoved disposes a binding whose root is disconnected', () => {
    const root = componentRoot('counter-1');
    const h = harness([root]);
    h.bindings.mountAll();

    root.isConnected = false;
    h.bindings.collectRemoved();

    assert.equal(h.bindings.size, 0);
  });

  it('rebinds a fresh root after disposeAll', () => {
    const root = componentRoot('counter-1');
    const h = harness([root]);
    h.bindings.mountAll();
    h.bindings.disposeAll();

    h.bindings.mountAll();
    assert.equal(h.bindings.size, 1);
    assert.equal(root.getAttribute(ISLAND_HYDRATED_ATTRIBUTE), 'true');
  });
});

// ---------------------------------------------------------------------------
// Nested island hooks
// ---------------------------------------------------------------------------

describe('nested island hooks', () => {
  it('tears down nested islands before the morph and remounts after', async () => {
    const root = componentRoot('counter-1');
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const calls: string[] = [];
    const islands: IslandManager = {
      registry: new Map(),
      mountAll: () => {},
      mountWithin: () => {
        calls.push('mountWithin');
      },
      unmountNonPermanent: () => {},
      collectRemoved: () => {},
      beforeMorph: () => {
        calls.push('beforeMorph');
        return () => {
          calls.push('restore');
        };
      },
      afterMorph: () => {},
    };
    const h = harness([root], { islands });
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('click', trigger));
    h.resolveNext(successResponse(1, { title: 'hello', count: 0 }));
    await flush();

    assert.deepEqual(calls, ['beforeMorph', 'restore', 'mountWithin']);
  });
});

// ---------------------------------------------------------------------------
// Field validation rules (pure parsing/evaluation)
// ---------------------------------------------------------------------------

describe('parseFieldRules', () => {
  it('returns null for absent, malformed, or non-object markers', () => {
    assert.equal(parseFieldRules(null), null);
    assert.equal(parseFieldRules(''), null);
    assert.equal(parseFieldRules('{bad'), null);
    assert.equal(parseFieldRules('[1,2]'), null);
    assert.equal(parseFieldRules('"str"'), null);
    assert.equal(parseFieldRules('{"type":"email"}'), null); // missing required
    assert.equal(parseFieldRules('{"required":"yes"}'), null); // required not boolean
  });

  it('returns null for an oversized marker before parsing it', () => {
    assert.equal(parseFieldRules(`{"required":true,"pattern":"${'a'.repeat(5000)}"}`), null);
  });

  it('parses required/type/bounds and drops unsafe entries', () => {
    assert.deepEqual(parseFieldRules('{"required":true,"type":"email"}'), {
      required: true,
      type: 'email',
    });
    assert.deepEqual(parseFieldRules('{"required":false}'), { required: false });
    // A negative bound is not a safe integer and is dropped.
    assert.deepEqual(parseFieldRules('{"required":true,"minLength":-1}'), { required: true });
    // An unknown type hint is ignored.
    assert.deepEqual(parseFieldRules('{"required":true,"type":"uuid"}'), { required: true });
  });

  it('keeps only a fully valid option list', () => {
    assert.deepEqual(parseFieldRules('{"required":true,"options":["a","b"]}'), {
      required: true,
      options: ['a', 'b'],
    });
    // A non-string entry invalidates the whole list (never partially trusted).
    assert.deepEqual(parseFieldRules('{"required":true,"options":["a",1]}'), {
      required: true,
    });
  });
});

describe('evaluateFieldRules', () => {
  it('flags an empty required value', () => {
    assert.equal(evaluateFieldRules('', { required: true }), 'This field is required');
    assert.equal(evaluateFieldRules(null, { required: true }), 'This field is required');
    assert.equal(evaluateFieldRules([], { required: true }), 'This field is required');
  });

  it('lets an empty optional value pass every remaining check', () => {
    assert.equal(evaluateFieldRules('', { required: false }), undefined);
    assert.equal(evaluateFieldRules('', { required: false, type: 'email' }), undefined);
  });

  it('validates email, number, and date shapes', () => {
    assert.equal(
      evaluateFieldRules('nope', { required: true, type: 'email' }),
      'Enter a valid email address',
    );
    assert.equal(evaluateFieldRules('a@b.co', { required: true, type: 'email' }), undefined);
    assert.equal(evaluateFieldRules('abc', { required: true, type: 'number' }), 'Enter a number');
    assert.equal(
      evaluateFieldRules('not-a-date', { required: true, type: 'date' }),
      'Enter a valid date',
    );
    assert.equal(evaluateFieldRules('2024-01-01', { required: true, type: 'date' }), undefined);
  });

  it('applies string min/max/pattern bounds', () => {
    assert.equal(
      evaluateFieldRules('ab', { required: true, type: 'string', minLength: 3 }),
      'Must be at least 3 characters',
    );
    assert.equal(
      evaluateFieldRules('abcd', { required: true, type: 'string', maxLength: 3 }),
      'Must be at most 3 characters',
    );
    assert.equal(
      evaluateFieldRules('ABC', { required: true, type: 'string', pattern: '^[a-z]+$' }),
      'Invalid format',
    );
    assert.equal(
      evaluateFieldRules('abc', { required: true, type: 'string', pattern: '^[a-z]+$' }),
      undefined,
    );
  });

  it('applies number min/max/step bounds', () => {
    assert.equal(
      evaluateFieldRules(3, { required: true, type: 'number', min: 5 }),
      'Must be at least 5',
    );
    assert.equal(
      evaluateFieldRules(11, { required: true, type: 'number', max: 10 }),
      'Must be at most 10',
    );
    assert.equal(
      evaluateFieldRules(5, { required: true, type: 'number', step: 2 }),
      'Must be a multiple of 2',
    );
    assert.equal(evaluateFieldRules(6, { required: true, type: 'number', step: 2 }), undefined);
  });

  it('validates enum options', () => {
    assert.equal(
      evaluateFieldRules('z', { required: true, options: ['a', 'b'] }),
      'Invalid selection',
    );
    assert.equal(evaluateFieldRules('a', { required: true, options: ['a', 'b'] }), undefined);
  });
});

// ---------------------------------------------------------------------------
// Client-side field validation (binding layer)
// ---------------------------------------------------------------------------

describe('client field validation', () => {
  it('sets aria-invalid and the error element on input, clearing both when valid', () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    input.setAttribute(
      RULES_ATTRIBUTE,
      JSON.stringify({ required: true, type: 'string', minLength: 3 }),
    );
    const error = append(root, fakeElement('span', { [ERROR_FOR_ATTRIBUTE]: 'title' }));
    const h = harness([root]);
    h.bindings.mountAll();

    input.value = '';
    dispatch(h.doc, fakeEvent('input', input));
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(error.textContent, 'This field is required');

    input.value = 'valid';
    dispatch(h.doc, fakeEvent('input', input));
    assert.equal(input.getAttribute('aria-invalid'), null);
    assert.equal(error.textContent, '');
  });

  it('blocks a submit with an invalid field, focuses the first, and dispatches nothing', () => {
    const root = componentRoot('counter-1');
    const form = append(root, fakeElement('form', { [SUBMIT_ATTRIBUTE]: 'save' }));
    const first = append(form, modelInput('a', ''));
    const second = append(form, modelInput('b', 'x'));
    first.setAttribute(RULES_ATTRIBUTE, JSON.stringify({ required: true }));
    second.setAttribute(RULES_ATTRIBUTE, JSON.stringify({ required: true }));
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('submit', form);
    dispatch(h.doc, event);

    assert.equal(event.prevented, true);
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(first.focused, true);
    assert.equal(second.focused, false);
  });

  it('does not block a submit when every bound field validates', () => {
    const root = componentRoot('counter-1');
    const form = append(root, fakeElement('form', { [SUBMIT_ATTRIBUTE]: 'save' }));
    const input = append(form, modelInput('title', 'valid'));
    input.setAttribute(
      RULES_ATTRIBUTE,
      JSON.stringify({ required: true, type: 'string', minLength: 3 }),
    );
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('submit', form));

    assert.equal(h.fetchCalls.length, 1);
    assert.deepEqual(h.fetchCalls[0]!.body.action, { name: 'save', args: {} });
  });
});

// ---------------------------------------------------------------------------
// File upload binding
// ---------------------------------------------------------------------------

describe('file upload binding', () => {
  it('uploads a selected file, sets markers, and serializes the reference', async () => {
    const root = componentRoot('counter-1');
    const input = append(root, fakeElement('input', { [MODEL_ATTRIBUTE]: 'avatar', type: 'file' }));
    const { factory, created } = fakeUploadXhrFactory();
    const h = harness([root], { uploadRequest: factory });
    h.bindings.mountAll();

    input.files = [testFile('avatar.png')];
    dispatch(h.doc, fakeEvent('change', input));

    assert.equal(created.length, 1);
    const xhr = created[0]!;
    assert.equal(xhr.method, 'POST');
    assert.equal(xhr.url, COMPONENT_UPLOAD_ENDPOINT);
    assert.equal(
      xhr.body!.get(COMPONENT_UPLOAD_SNAPSHOT_FIELD),
      root.getAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE),
    );
    const sentFile = xhr.body!.get(COMPONENT_UPLOAD_FILE_FIELD);
    assert.ok(sentFile instanceof File);
    assert.equal(sentFile.name, 'avatar.png');
    assert.equal(input.getAttribute(COMPONENT_UPLOADING_ATTRIBUTE), 'true');

    xhr.status = 201;
    xhr.responseText = JSON.stringify({ reference: 'ref-1' });
    xhr.onload!();
    await flush();

    assert.equal(input.getAttribute(COMPONENT_UPLOADING_ATTRIBUTE), null);

    // The stored reference is not clobbered by a later capture and rides the next action.
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    dispatch(h.doc, fakeEvent('click', trigger));
    assert.deepEqual(h.fetchCalls[0]!.body.updates, {
      avatar: { [UPLOAD_REFERENCE_KEY]: 'ref-1' },
    });
  });

  it('shows the fixed failure message, clears the input, and recovers on retry', async () => {
    const root = componentRoot('counter-1');
    const input = append(root, fakeElement('input', { [MODEL_ATTRIBUTE]: 'avatar', type: 'file' }));
    const { factory, created } = fakeUploadXhrFactory();
    const h = harness([root], { uploadRequest: factory });
    h.bindings.mountAll();

    input.files = [testFile('avatar.png')];
    dispatch(h.doc, fakeEvent('change', input));
    created[0]!.status = 500;
    created[0]!.responseText = '{}';
    created[0]!.onload!();
    await flush();

    assert.equal(input.getAttribute(COMPONENT_UPLOADING_ATTRIBUTE), null);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(input.value, '');
    assert.equal(root.children.length, 2);
    assert.equal(root.children[1]!.textContent, COMPONENT_UPLOAD_FAILED_MESSAGE);
    assert.equal(h.errors.length, 1);

    // Retrying a new selection clears the prior error and starts a fresh upload.
    input.files = [testFile('avatar2.png')];
    dispatch(h.doc, fakeEvent('change', input));
    assert.equal(input.getAttribute('aria-invalid'), null);
    assert.equal(root.children.length, 1);
    assert.equal(input.getAttribute(COMPONENT_UPLOADING_ATTRIBUTE), 'true');
    assert.equal(created.length, 2);
  });

  it('rejects an oversized file from the size hint without uploading', () => {
    const root = componentRoot('counter-1');
    root.setAttribute(COMPONENT_UPLOAD_MAX_BYTES_ATTRIBUTE, '4');
    const input = append(root, fakeElement('input', { [MODEL_ATTRIBUTE]: 'avatar', type: 'file' }));
    const { factory, created } = fakeUploadXhrFactory();
    const h = harness([root], { uploadRequest: factory });
    h.bindings.mountAll();

    input.files = [testFile('big.png', 'x'.repeat(100))];
    dispatch(h.doc, fakeEvent('change', input));

    assert.equal(created.length, 0);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(input.value, '');
    assert.equal(root.children[1]!.textContent, COMPONENT_UPLOAD_FAILED_MESSAGE);
    assert.equal(h.errors.length, 1);
  });

  it('dispose aborts an in-flight upload without stale UI callbacks', async () => {
    const root = componentRoot('counter-1');
    const input = append(root, fakeElement('input', { [MODEL_ATTRIBUTE]: 'avatar', type: 'file' }));
    const { factory, created } = fakeUploadXhrFactory();
    const h = harness([root], { uploadRequest: factory });
    h.bindings.mountAll();

    input.files = [testFile('avatar.png')];
    dispatch(h.doc, fakeEvent('change', input));
    assert.equal(input.getAttribute(COMPONENT_UPLOADING_ATTRIBUTE), 'true');

    h.bindings.disposeAll();
    await flush();

    assert.equal(created.length, 1);
    assert.equal(input.getAttribute('aria-invalid'), null);
    assert.equal(root.children.length, 1);
    assert.equal(h.errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

describe('polling', () => {
  /** The latest a 250 ms tick can fire: the interval plus its 10% jitter. */
  const LATEST_TICK_MS = 275;

  it('refreshes on the interval through the refresh action and reschedules after each render', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const root = componentRoot('counter-1');
    root.setAttribute(POLL_ATTRIBUTE, JSON.stringify({ intervalMs: 250 }));
    const h = harness([root], { fetch: echoFetch });
    h.bindings.mountAll();
    await drain();

    t.mock.timers.tick(224);
    await drain();
    assert.equal(h.fetchCalls.length, 0, 'no tick before the earliest jittered deadline');

    t.mock.timers.tick(LATEST_TICK_MS - 224);
    await drain();
    assert.equal(h.fetchCalls.length, 1);
    assert.equal((h.fetchCalls[0]!.body.action as { name: string }).name, REFRESH_ACTION);
    assert.deepEqual(h.fetchCalls[0]!.body.updates, {});

    t.mock.timers.tick(LATEST_TICK_MS);
    await drain();
    assert.equal(h.fetchCalls.length, 2);
  });

  it('pauses while hidden by default and catches up on visibility', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const root = componentRoot('counter-1');
    root.setAttribute(POLL_ATTRIBUTE, JSON.stringify({ intervalMs: 250 }));
    const poll = makePollSignals();
    const h = harness([root], { fetch: echoFetch, pollSignals: poll.signals });
    h.bindings.mountAll();
    await drain();

    poll.set({ hidden: true });
    t.mock.timers.tick(LATEST_TICK_MS * 4);
    await drain();
    assert.equal(h.fetchCalls.length, 0);

    // A tick came due while hidden: one catch-up refresh on return.
    poll.set({ hidden: false });
    await drain();
    assert.equal(h.fetchCalls.length, 1);
  });

  it('pauses while offline by default and catches up on reconnect', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const root = componentRoot('counter-1');
    root.setAttribute(POLL_ATTRIBUTE, JSON.stringify({ intervalMs: 250 }));
    const poll = makePollSignals();
    const h = harness([root], { fetch: echoFetch, pollSignals: poll.signals });
    h.bindings.mountAll();
    await drain();

    poll.set({ online: false });
    t.mock.timers.tick(LATEST_TICK_MS * 4);
    await drain();
    assert.equal(h.fetchCalls.length, 0);

    poll.set({ online: true });
    await drain();
    assert.equal(h.fetchCalls.length, 1);
  });

  it('keeps ticking while hidden when the marker says continue', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const root = componentRoot('counter-1');
    root.setAttribute(POLL_ATTRIBUTE, JSON.stringify({ intervalMs: 250, whenHidden: 'continue' }));
    const poll = makePollSignals({ hidden: true });
    const h = harness([root], { fetch: echoFetch, pollSignals: poll.signals });
    h.bindings.mountAll();
    await drain();

    t.mock.timers.tick(LATEST_TICK_MS);
    await drain();
    assert.equal(h.fetchCalls.length, 1);
  });

  it('backs off after a rate-limited refresh, honouring Retry-After, and stays bound', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const root = componentRoot('counter-1');
    root.setAttribute(POLL_ATTRIBUTE, JSON.stringify({ intervalMs: 250 }));
    let limited = true;
    const h = harness([root], {
      fetch: async (url, init) => {
        if (limited) {
          limited = false;
          return new Response(
            JSON.stringify({ sequence: 0, error: { code: 'rate_limited', message: 'x' } }),
            { status: 429, headers: { 'retry-after': '30' } },
          );
        }
        return echoFetch(url, init);
      },
    });
    h.bindings.mountAll();
    await drain();

    t.mock.timers.tick(LATEST_TICK_MS);
    await drain();
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(root.textContent, null, 'a 429 does not block the component');

    t.mock.timers.tick(29_000);
    await drain();
    assert.equal(h.fetchCalls.length, 1, 'no tick before Retry-After elapsed');

    t.mock.timers.tick(1_000);
    await drain();
    assert.equal(h.fetchCalls.length, 2);
  });

  it('leaves a failed poll refresh to the loop backoff, never retrying it in the queue', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const root = componentRoot('counter-1');
    root.setAttribute(POLL_ATTRIBUTE, JSON.stringify({ intervalMs: 5_000 }));
    let failing = true;
    const h = harness([root], {
      fetch: async (url, init) => {
        if (failing) {
          failing = false;
          return new Response('bad gateway', { status: 502 });
        }
        return echoFetch(url, init);
      },
    });
    h.bindings.mountAll();
    await drain();

    t.mock.timers.tick(5_500);
    for (let i = 0; i < 5; i += 1) await drain();
    assert.equal(h.fetchCalls.length, 1);

    // The controller's own retry would have come after 500 ms; the loop's
    // backoff (two intervals, less 10% jitter) comes no sooner than 9 s.
    t.mock.timers.tick(8_000);
    for (let i = 0; i < 5; i += 1) await drain();
    assert.equal(h.fetchCalls.length, 1);

    t.mock.timers.tick(3_000);
    for (let i = 0; i < 5; i += 1) await drain();
    assert.equal(h.fetchCalls.length, 2);
  });

  it('stops polling on dispose', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const root = componentRoot('counter-1');
    root.setAttribute(POLL_ATTRIBUTE, JSON.stringify({ intervalMs: 250 }));
    const h = harness([root], { fetch: echoFetch });
    h.bindings.mountAll();
    await drain();

    h.bindings.disposeAll();
    t.mock.timers.tick(LATEST_TICK_MS * 2);
    await drain();
    assert.equal(h.fetchCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Loading and dirty markers
// ---------------------------------------------------------------------------

describe('loading and dirty markers', () => {
  it('sets the loading marker while a commit is in flight and clears it after', async () => {
    const root = componentRoot('counter-1');
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('click', trigger));
    assert.equal(root.getAttribute(LOADING_ATTRIBUTE), 'true');

    h.resolveNext(successResponse(1, { title: 'hello', count: 0 }));
    await flush();
    assert.equal(root.getAttribute(LOADING_ATTRIBUTE), null);
  });

  it('clears the loading marker even when the commit blocks fatally', async () => {
    const root = componentRoot('counter-1');
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('click', trigger));
    assert.equal(root.getAttribute(LOADING_ATTRIBUTE), 'true');
    h.resolveNext(new Response('boom', { status: 500 }));
    await flush();

    assert.equal(root.textContent, COMPONENT_BLOCKED_MESSAGE);
    assert.equal(root.getAttribute(LOADING_ATTRIBUTE), null);
  });

  it('marks a root and its edited field dirty, then clears both after a successful sync', async () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    input.value = 'changed';
    dispatch(h.doc, fakeEvent('input', input));
    assert.equal(root.getAttribute(DIRTY_ATTRIBUTE), 'true');
    assert.equal(input.getAttribute(DIRTY_ATTRIBUTE), 'true');

    dispatch(h.doc, fakeEvent('click', trigger));
    h.resolveNext(successResponse(1, { title: 'changed', count: 0 }));
    await flush();

    assert.equal(root.getAttribute(DIRTY_ATTRIBUTE), null);
    assert.equal(input.getAttribute(DIRTY_ATTRIBUTE), null);
  });
});

// ---------------------------------------------------------------------------
// Bound value modifiers
// ---------------------------------------------------------------------------

describe('bound value modifiers', () => {
  /** The updates the next action carries after `edit` changes a bound control. */
  function capturedAfter(
    attributes: Readonly<Record<string, string>>,
    edit: (input: FakeElement, doc: FakeDocument) => void,
  ): Record<string, unknown> {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    for (const [name, value] of Object.entries(attributes)) input.setAttribute(name, value);
    const h = harness([root]);
    h.bindings.mountAll();
    edit(input, h.doc);
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    dispatch(h.doc, fakeEvent('click', trigger));
    return h.fetchCalls[0]!.body.updates as Record<string, unknown>;
  }

  const type = (value: string) => (input: FakeElement, doc: FakeDocument) => {
    input.value = value;
    dispatch(doc, fakeEvent('input', input));
  };

  it('trims a text value', () => {
    assert.deepEqual(capturedAfter({ [TRIM_ATTRIBUTE]: '' }, type('  milk  ')), { title: 'milk' });
  });

  it('reads a numeric text as a number and leaves other text as it is', () => {
    assert.deepEqual(capturedAfter({ [NUMBER_ATTRIBUTE]: '' }, type(' 42 ')), { title: 42 });
    assert.deepEqual(capturedAfter({ [NUMBER_ATTRIBUTE]: '' }, type('4x')), { title: '4x' });
    assert.deepEqual(capturedAfter({ [NUMBER_ATTRIBUTE]: '' }, type('')), { title: '' });
  });

  it('takes a lazy value on change, not on input', () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    input.setAttribute(LAZY_ATTRIBUTE, '');
    input.setAttribute(TRIM_ATTRIBUTE, '');
    const h = harness([root]);
    h.bindings.mountAll();

    input.value = ' typed ';
    dispatch(h.doc, fakeEvent('input', input));
    assert.equal(input.getAttribute(DIRTY_ATTRIBUTE), null);

    dispatch(h.doc, fakeEvent('change', input));
    assert.equal(input.getAttribute(DIRTY_ATTRIBUTE), 'true');
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    dispatch(h.doc, fakeEvent('click', trigger));
    assert.deepEqual(h.fetchCalls[0]!.body.updates, { title: 'typed' });
  });

  it('keeps the uncommitted text of a lazy control across a render it did not trigger', async () => {
    // The morph either leaves the control alone or writes the server's value
    // into it; either way the user's text comes back as typed.
    for (const resets of [false, true]) {
      const root = componentRoot('counter-1');
      const count = append(root, modelInput('count', '0', 'number'));
      count.setAttribute(DEBOUNCE_ATTRIBUTE, '100');
      const title = append(root, modelInput('title', 'hello'));
      title.setAttribute(LAZY_ATTRIBUTE, '');
      title.setAttribute(TRIM_ATTRIBUTE, '');
      const h = harness([root], {
        fetch: echoFetch,
        morph: async () => {
          if (resets) title.value = 'hello';
        },
      });
      h.bindings.mountAll();

      // A debounced field flushes on focusout while the user types into the
      // lazy field, which commits nothing until `change`.
      count.value = '3';
      dispatch(h.doc, fakeEvent('input', count));
      dispatch(h.doc, fakeEvent('focusout', count));
      title.value = 'Buy milk ';
      dispatch(h.doc, fakeEvent('input', title));
      await flush();
      await drain();
      assert.equal(h.fetchCalls.length, 1);
      assert.deepEqual(h.fetchCalls[0]!.body.updates, { count: 3 });
      assert.equal(title.value, 'Buy milk ', `resets: ${resets}`);

      dispatch(h.doc, fakeEvent('change', title));
      const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
      dispatch(h.doc, fakeEvent('click', trigger));
      assert.deepEqual(h.fetchCalls[1]!.body.updates, { title: 'Buy milk' });
    }
  });
});

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

describe('debounce', () => {
  it('flushes a debounced edit on its timer as a sync', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    input.setAttribute(DEBOUNCE_ATTRIBUTE, '100');
    const h = harness([root], { fetch: echoFetch });
    h.bindings.mountAll();

    input.value = 'changed';
    dispatch(h.doc, fakeEvent('input', input));
    assert.equal(h.fetchCalls.length, 0);

    t.mock.timers.tick(100);
    await drain();
    assert.equal(h.fetchCalls.length, 1);
    assert.equal((h.fetchCalls[0]!.body.action as { name: string }).name, REFRESH_ACTION);
    assert.deepEqual(h.fetchCalls[0]!.body.updates, { title: 'changed' });
  });

  it('flushes a pending debounce immediately on focusout', async () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    input.setAttribute(DEBOUNCE_ATTRIBUTE, '100');
    const h = harness([root], { fetch: echoFetch });
    h.bindings.mountAll();

    input.value = 'changed';
    dispatch(h.doc, fakeEvent('input', input));
    assert.equal(h.fetchCalls.length, 0);

    dispatch(h.doc, fakeEvent('focusout', input));
    await flush();
    assert.equal(h.fetchCalls.length, 1);
    assert.equal((h.fetchCalls[0]!.body.action as { name: string }).name, REFRESH_ACTION);
    assert.deepEqual(h.fetchCalls[0]!.body.updates, { title: 'changed' });
  });

  it('cancels a pending debounce on dispose', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    input.setAttribute(DEBOUNCE_ATTRIBUTE, '100');
    const h = harness([root], { fetch: echoFetch });
    h.bindings.mountAll();

    input.value = 'changed';
    dispatch(h.doc, fakeEvent('input', input));
    h.bindings.disposeAll();
    t.mock.timers.tick(1000);

    assert.equal(h.fetchCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Confirm directive
// ---------------------------------------------------------------------------

describe('confirm directive', () => {
  it('dispatches a click action when user confirms', () => {
    const root = componentRoot('counter-1');
    const trigger = append(
      root,
      fakeElement('button', {
        [CALL_ATTRIBUTE]: 'delete',
        [CONFIRM_ATTRIBUTE]: 'Are you sure?',
      }),
    );
    let asked: string | null = null;
    const h = harness([root], {
      confirm: (message) => {
        asked = message;
        return true;
      },
    });
    h.bindings.mountAll();

    const event = fakeEvent('click', trigger);
    dispatch(h.doc, event);

    assert.equal(asked, 'Are you sure?');
    assert.equal(event.prevented, true);
    assert.equal(h.fetchCalls.length, 1);
    assert.deepEqual(h.fetchCalls[0]!.body.action, { name: 'delete', args: {} });
  });

  it('does NOT dispatch when user cancels, and still prevents the default', () => {
    const root = componentRoot('counter-1');
    const trigger = append(
      root,
      fakeElement('button', {
        [CALL_ATTRIBUTE]: 'delete',
        [CONFIRM_ATTRIBUTE]: 'Are you sure?',
      }),
    );
    const h = harness([root], { confirm: () => false });
    h.bindings.mountAll();

    const event = fakeEvent('click', trigger);
    dispatch(h.doc, event);

    assert.equal(event.prevented, true);
    assert.equal(h.fetchCalls.length, 0);
  });

  it('dispatches a click action when confirm is absent (no prompt)', () => {
    const root = componentRoot('counter-1');
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('click', trigger);
    dispatch(h.doc, event);

    assert.equal(h.fetchCalls.length, 1);
    assert.deepEqual(h.fetchCalls[0]!.body.action, { name: 'save', args: {} });
  });

  it('dispatches a submit action when user confirms', () => {
    const root = componentRoot('counter-1');
    const form = append(
      root,
      fakeElement('form', {
        [SUBMIT_ATTRIBUTE]: 'delete',
        [CONFIRM_ATTRIBUTE]: 'Delete everything?',
      }),
    );
    let asked: string | null = null;
    const h = harness([root], {
      confirm: (message) => {
        asked = message;
        return true;
      },
    });
    h.bindings.mountAll();

    const event = fakeEvent('submit', form);
    dispatch(h.doc, event);

    assert.equal(asked, 'Delete everything?');
    assert.equal(event.prevented, true);
    assert.equal(h.fetchCalls.length, 1);
  });

  it('does NOT dispatch a submit when user cancels', () => {
    const root = componentRoot('counter-1');
    const form = append(
      root,
      fakeElement('form', {
        [SUBMIT_ATTRIBUTE]: 'delete',
        [CONFIRM_ATTRIBUTE]: 'Delete everything?',
      }),
    );
    const h = harness([root], { confirm: () => false });
    h.bindings.mountAll();

    const event = fakeEvent('submit', form);
    dispatch(h.doc, event);

    assert.equal(event.prevented, true);
    assert.equal(h.fetchCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Loading-target directive
// ---------------------------------------------------------------------------

describe('loading-target directive', () => {
  it('sets and clears the loading marker on the element a marker names', async () => {
    const root = componentRoot('counter-1');
    append(root, fakeElement('p', { [LOADING_TARGET_ATTRIBUTE]: '#spinner' }));
    const spinner = append(root, fakeElement('div', { id: 'spinner' }));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    assert.equal(spinner.getAttribute(LOADING_ATTRIBUTE), null);

    dispatch(h.doc, fakeEvent('click', trigger));
    assert.equal(spinner.getAttribute(LOADING_ATTRIBUTE), 'true');

    h.resolveNext(successResponse(1, { title: 'hello', count: 0 }));
    await flush();
    assert.equal(spinner.getAttribute(LOADING_ATTRIBUTE), null);
  });

  it('marks the marked element itself when the marker is empty', async () => {
    const root = componentRoot('counter-1');
    const trigger = append(
      root,
      fakeElement('button', { [CALL_ATTRIBUTE]: 'save', [LOADING_TARGET_ATTRIBUTE]: '' }),
    );
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('click', trigger));
    assert.equal(trigger.getAttribute(LOADING_ATTRIBUTE), 'true');

    h.resolveNext(successResponse(1, { title: 'hello', count: 0 }));
    await flush();
    assert.equal(trigger.getAttribute(LOADING_ATTRIBUTE), null);
  });

  it('leaves a marker inside a nested component to that component', () => {
    const root = componentRoot('counter-1');
    const nested = append(root, componentRoot('counter-2'));
    const marker = append(nested, fakeElement('p', { [LOADING_TARGET_ATTRIBUTE]: '' }));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('click', trigger));
    assert.equal(root.getAttribute(LOADING_ATTRIBUTE), 'true');
    assert.equal(marker.getAttribute(LOADING_ATTRIBUTE), null);
  });

  it('does not throw when the selector matches nothing', () => {
    const root = componentRoot('counter-1');
    append(root, fakeElement('p', { [LOADING_TARGET_ATTRIBUTE]: '#missing' }));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('click', trigger);
    assert.doesNotThrow(() => dispatch(h.doc, event));
    assert.equal(h.fetchCalls.length, 1);
  });

  it('does not throw when the selector is malformed', () => {
    const root = componentRoot('counter-1');
    append(root, fakeElement('p', { [LOADING_TARGET_ATTRIBUTE]: '!!bad!!' }));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('click', trigger);
    assert.doesNotThrow(() => dispatch(h.doc, event));
    assert.equal(h.fetchCalls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Ignore directive
// ---------------------------------------------------------------------------

describe('ignore directive', () => {
  it('does not capture controls inside an ignored subtree', () => {
    const root = componentRoot('counter-1');
    const ignore = append(root, fakeElement('div', { [IGNORE_ATTRIBUTE]: '' }));
    append(ignore, modelInput('title', 'hidden-value'));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('click', trigger));

    assert.equal(h.fetchCalls.length, 1);
    assert.deepEqual(h.fetchCalls[0]!.body.updates, {});
  });

  it('does not dispatch a call trigger inside an ignored subtree', () => {
    const root = componentRoot('counter-1');
    const ignore = append(root, fakeElement('div', { [IGNORE_ATTRIBUTE]: '' }));
    const trigger = append(ignore, fakeElement('button', { [CALL_ATTRIBUTE]: 'delete' }));
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('click', trigger);
    dispatch(h.doc, event);

    assert.equal(event.prevented, false);
    assert.equal(h.fetchCalls.length, 0);
  });

  it('does not dispatch a submit inside an ignored subtree', () => {
    const root = componentRoot('counter-1');
    const ignore = append(root, fakeElement('div', { [IGNORE_ATTRIBUTE]: '' }));
    const form = append(ignore, fakeElement('form', { [SUBMIT_ATTRIBUTE]: 'delete' }));
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('submit', form);
    dispatch(h.doc, event);

    assert.equal(event.prevented, false);
    assert.equal(h.fetchCalls.length, 0);
  });

  it('does not capture input events inside an ignored subtree', () => {
    const root = componentRoot('counter-1');
    const ignore = append(root, fakeElement('div', { [IGNORE_ATTRIBUTE]: '' }));
    const input = append(ignore, modelInput('title', 'hidden'));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    input.value = 'changed';
    dispatch(h.doc, fakeEvent('input', input));
    dispatch(h.doc, fakeEvent('click', trigger));

    assert.deepEqual(h.fetchCalls[0]!.body.updates, {});
  });
});

// ---------------------------------------------------------------------------
// Show directive
// ---------------------------------------------------------------------------

describe('show directive', () => {
  it('shows the element when the named state field is truthy', () => {
    const root = componentRoot('counter-1', { isVisible: true, name: 'x' });
    const shown = append(root, fakeElement('span', { [SHOW_ATTRIBUTE]: 'isVisible' }));
    const h = harness([root]);
    h.bindings.mountAll();

    // The test double has no `hidden` idl property, so visibility is driven
    // by the `data-jsails-hidden` attribute.
    assert.equal(shown.getAttribute('data-jsails-hidden'), null);
    assert.equal(shown.hidden, undefined);
  });

  it('hides the element when the named state field is falsy', () => {
    const root = componentRoot('counter-1', { isVisible: false, name: 'x' });
    const hidden = append(root, fakeElement('span', { [SHOW_ATTRIBUTE]: 'isVisible' }));
    const h = harness([root]);
    h.bindings.mountAll();

    assert.equal(hidden.getAttribute('data-jsails-hidden'), '');
  });

  it('hides the element when the named state field is missing', () => {
    const root = componentRoot('counter-1', { name: 'x' });
    const hidden = append(root, fakeElement('span', { [SHOW_ATTRIBUTE]: 'isVisible' }));
    const h = harness([root]);
    h.bindings.mountAll();

    // A missing field is falsy — the element stays hidden.
    assert.equal(hidden.getAttribute('data-jsails-hidden'), '');
  });

  it('toggles visibility on every marker sync (idempotent)', async () => {
    const root = componentRoot('counter-1', { flag: false });
    const target = append(root, fakeElement('div', { [SHOW_ATTRIBUTE]: 'flag' }));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'toggle' }));
    const h = harness([root]);
    h.bindings.mountAll();

    // Initial: flag is false → hidden.
    assert.equal(target.getAttribute('data-jsails-hidden'), '');

    // A render that flips the flag to truthy shows the element.
    dispatch(h.doc, fakeEvent('click', trigger));
    h.resolveNext(successResponse(1, { flag: true }));
    await flush();
    assert.equal(target.getAttribute('data-jsails-hidden'), null);

    // A second call that keeps it truthy is a no-op (idempotent).
    dispatch(h.doc, fakeEvent('click', trigger));
    h.resolveNext(successResponse(2, { flag: true }));
    await flush();
    assert.equal(target.getAttribute('data-jsails-hidden'), null);
  });
});

// ---------------------------------------------------------------------------
// Text directive
// ---------------------------------------------------------------------------

describe('text directive', () => {
  it('sets textContent from a string state field', () => {
    const root = componentRoot('counter-1', { message: 'Hello world' });
    const output = append(root, fakeElement('p', { [TEXT_ATTRIBUTE]: 'message' }));
    const h = harness([root]);
    h.bindings.mountAll();

    assert.equal(output.textContent, 'Hello world');
  });

  it('sets textContent from a numeric state field (stringified)', () => {
    const root = componentRoot('counter-1', { count: 42 });
    const output = append(root, fakeElement('span', { [TEXT_ATTRIBUTE]: 'count' }));
    const h = harness([root]);
    h.bindings.mountAll();

    assert.equal(output.textContent, '42');
  });

  it('sets textContent from an object field via JSON.stringify', () => {
    const root = componentRoot('counter-1', { meta: { key: 'value' } });
    const output = append(root, fakeElement('span', { [TEXT_ATTRIBUTE]: 'meta' }));
    const h = harness([root]);
    h.bindings.mountAll();

    assert.equal(output.textContent, JSON.stringify({ key: 'value' }));
  });

  it('sets textContent to empty for a missing field', () => {
    const root = componentRoot('counter-1', { name: 'x' });
    const output = append(root, fakeElement('span', { [TEXT_ATTRIBUTE]: 'missing' }));
    const h = harness([root]);
    h.bindings.mountAll();

    assert.equal(output.textContent, '');
  });

  it('never sets innerHTML — XSS safety', () => {
    const root = componentRoot('counter-1', {
      message: '<script>alert(1)</script>',
    });
    const output = append(root, fakeElement('p', { [TEXT_ATTRIBUTE]: 'message' }));
    const h = harness([root]);
    h.bindings.mountAll();

    // The HTML-like content is set as text, never parsed.
    assert.equal(output.textContent, '<script>alert(1)</script>');
    assert.notEqual(output.innerHTML, '<script>alert(1)</script>');
    // The innerHTML was never mutated — it stays as-is (empty for a fresh fake).
    assert.equal(output.innerHTML, '');
  });
});

// ---------------------------------------------------------------------------
// Sort directive
// ---------------------------------------------------------------------------

describe('sort directive', () => {
  it('dispatches a sort action on click', () => {
    const root = componentRoot('counter-1');
    const trigger = append(root, fakeElement('th', { [SORT_ATTRIBUTE]: 'title' }));
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('click', trigger);
    dispatch(h.doc, event);

    assert.equal(event.prevented, true);
    assert.equal(h.fetchCalls.length, 1);
    assert.deepEqual(h.fetchCalls[0]!.body.action, { name: 'sort', args: { field: 'title' } });
  });

  it('the explicit call wins when both CALL_ATTRIBUTE and SORT_ATTRIBUTE are present', () => {
    const root = componentRoot('counter-1');
    const trigger = append(
      root,
      fakeElement('th', {
        [CALL_ATTRIBUTE]: 'customSort',
        [SORT_ATTRIBUTE]: 'title',
      }),
    );
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('click', trigger);
    dispatch(h.doc, event);

    // The explicit CALL_ATTRIBUTE takes precedence.
    assert.equal(event.prevented, true);
    assert.equal(h.fetchCalls.length, 1);
    assert.deepEqual(h.fetchCalls[0]!.body.action, {
      name: 'customSort',
      args: {},
    });
  });

  it('ignores a click on a plain element with no call or sort marker', () => {
    const root = componentRoot('counter-1');
    const plain = append(root, fakeElement('th'));
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('click', plain);
    dispatch(h.doc, event);

    assert.equal(event.prevented, false);
    assert.equal(h.fetchCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Ref directive
// ---------------------------------------------------------------------------

describe('findRef', () => {
  it('returns the element whose ref name matches', () => {
    const root = componentRoot('counter-1');
    const target = append(root, fakeElement('div', { [REF_ATTRIBUTE]: 'my-el' }));
    append(root, fakeElement('div', { [REF_ATTRIBUTE]: 'other' }));
    const h = harness([root]);
    h.bindings.mountAll();

    const found = h.bindings.findRef(root, 'my-el');
    assert.strictEqual(found, target);
  });

  it('returns null when no element has that ref name', () => {
    const root = componentRoot('counter-1');
    append(root, fakeElement('div', { [REF_ATTRIBUTE]: 'other' }));
    const h = harness([root]);
    h.bindings.mountAll();

    assert.strictEqual(h.bindings.findRef(root, 'missing'), null);
  });

  it('returns null for an empty name', () => {
    const root = componentRoot('counter-1');
    append(root, fakeElement('div', { [REF_ATTRIBUTE]: 'x' }));
    const h = harness([root]);
    h.bindings.mountAll();

    assert.strictEqual(h.bindings.findRef(root, ''), null);
  });
});

// ---------------------------------------------------------------------------
// Intersect directive
// ---------------------------------------------------------------------------

describe('intersect directive', () => {
  it('observes elements with a data-jsails-intersect attribute on mount', () => {
    const root = componentRoot('counter-1');
    const target = append(root, fakeElement('div', { [INTERSECT_ATTRIBUTE]: 'loadMore' }));
    const { factory, created } = fakeIntersectionObserverFactory();
    const h = harness([root], { createIntersectionObserver: factory });
    h.bindings.mountAll();

    assert.equal(h.bindings.size, 1);
    assert.equal(created.length, 1);
    assert.ok(created[0]!.observed.includes(target));
  });

  it('dispatches the named action when an element intersects', () => {
    const root = componentRoot('counter-1');
    const target = append(root, fakeElement('div', { [INTERSECT_ATTRIBUTE]: 'loadMore' }));
    const { factory, created } = fakeIntersectionObserverFactory();
    const h = harness([root], { createIntersectionObserver: factory });
    h.bindings.mountAll();

    // Simulate the observer firing with an intersecting entry.
    const observer = created[0]!;
    observer.callback([{ target, isIntersecting: true }]);

    assert.equal(h.fetchCalls.length, 1);
    assert.deepEqual(h.fetchCalls[0]!.body.action, { name: 'loadMore', args: {} });
  });

  it('does NOT dispatch when an entry is not intersecting', () => {
    const root = componentRoot('counter-1');
    const target = append(root, fakeElement('div', { [INTERSECT_ATTRIBUTE]: 'loadMore' }));
    const { factory, created } = fakeIntersectionObserverFactory();
    const h = harness([root], { createIntersectionObserver: factory });
    h.bindings.mountAll();

    const observer = created[0]!;
    observer.callback([{ target, isIntersecting: false }]);

    assert.equal(h.fetchCalls.length, 0);
  });

  it('unobserves the element after firing once (fire-once semantics)', () => {
    const root = componentRoot('counter-1');
    const target = append(root, fakeElement('div', { [INTERSECT_ATTRIBUTE]: 'loadMore' }));
    const { factory, created } = fakeIntersectionObserverFactory();
    const h = harness([root], { createIntersectionObserver: factory });
    h.bindings.mountAll();

    const observer = created[0]!;
    observer.callback([{ target, isIntersecting: true }]);

    // The element should no longer be observed after the first fire.
    assert.ok(!observer.observed.includes(target));

    // A second intersection must not dispatch.
    observer.callback([{ target, isIntersecting: true }]);
    assert.equal(h.fetchCalls.length, 1);
  });

  it('disconnect observer on dispose', () => {
    const root = componentRoot('counter-1');
    append(root, fakeElement('div', { [INTERSECT_ATTRIBUTE]: 'loadMore' }));
    const { factory, created } = fakeIntersectionObserverFactory();
    const h = harness([root], { createIntersectionObserver: factory });
    h.bindings.mountAll();

    assert.equal(created[0]!.disconnected, false);

    h.bindings.disposeAll();

    assert.equal(created[0]!.disconnected, true);
  });

  it('does not create an observer when the root has no intersect elements', () => {
    const root = componentRoot('counter-1');
    const { factory, created } = fakeIntersectionObserverFactory();
    const h = harness([root], { createIntersectionObserver: factory });
    h.bindings.mountAll();

    assert.equal(h.bindings.size, 1);
    assert.equal(created.length, 0);
  });

  it('disconnects the old observer and observes new elements after morph', async () => {
    const root = componentRoot('counter-1');
    const oldTarget = append(root, fakeElement('div', { [INTERSECT_ATTRIBUTE]: 'first' }));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const { factory, created } = fakeIntersectionObserverFactory();
    const h = harness([root], { createIntersectionObserver: factory });
    h.bindings.mountAll();

    assert.equal(created.length, 1);
    const firstObserver = created[0]!;
    assert.ok(firstObserver.observed.includes(oldTarget));
    assert.equal(firstObserver.disconnected, false);

    // Dispatch a click to trigger a morph.
    dispatch(h.doc, fakeEvent('click', trigger));
    // Replace the root with a new one that has a different intersect element.
    const replacement = componentRoot('counter-1');
    const newTarget = append(replacement, fakeElement('div', { [INTERSECT_ATTRIBUTE]: 'second' }));
    h.doc.roots[0] = replacement;
    h.resolveNext(successResponse(1, { title: 'hello', count: 0 }));
    await flush();

    // The old observer must be disconnected.
    assert.equal(firstObserver.disconnected, true);
    // A new observer must be created for the new subtree.
    assert.equal(created.length, 2);
    const secondObserver = created[1]!;
    assert.ok(secondObserver.observed.includes(newTarget));
  });
});

// ---------------------------------------------------------------------------
// Action redirect
// ---------------------------------------------------------------------------

describe('action redirect', () => {
  it('navigates when the update response carries a redirect', async () => {
    const navigateCalls: string[] = [];
    const root = componentRoot('counter-1');
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'go' }));

    const h = harness([root], {
      navigate: (url) => {
        navigateCalls.push(url);
      },
    });
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('click', trigger));
    h.resolveNext(successResponse(1, { title: 'hello' }, '<div>ok</div>', '/dashboard'));
    await flush();

    assert.equal(navigateCalls.length, 1);
    assert.equal(navigateCalls[0], '/dashboard');
  });

  it('falls back to location.assign when no navigate option is wired', async () => {
    const assigned: string[] = [];
    const original = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = {
      assign: (url: string) => {
        assigned.push(url);
      },
    };
    try {
      const root = componentRoot('counter-1');
      const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'go' }));

      const h = harness([root]);
      h.bindings.mountAll();

      dispatch(h.doc, fakeEvent('click', trigger));
      h.resolveNext(successResponse(1, { title: 'hello' }, '<div>ok</div>', '/dashboard'));
      await flush();

      assert.equal(assigned.length, 1);
      assert.equal(assigned[0], '/dashboard');
    } finally {
      (globalThis as { location?: unknown }).location = original;
    }
  });

  it('does not navigate when the response carries no redirect', async () => {
    const navigateCalls: string[] = [];
    const root = componentRoot('counter-1');
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'noop' }));

    const h = harness([root], {
      navigate: (url) => {
        navigateCalls.push(url);
      },
    });
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('click', trigger));
    h.resolveNext(successResponse(1, { title: 'hello' }));
    await flush();

    assert.equal(navigateCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Nested server components
// ---------------------------------------------------------------------------
// Nested server components
// ---------------------------------------------------------------------------

/** A `renderNested` wrapper with its slot and component, holding one child component root. */
function nestedChild(
  parent: FakeElement,
  slot: string,
  childId: string,
  state: Record<string, unknown>,
  component = 'card',
): FakeElement {
  const wrapper = append(
    parent,
    fakeElement('div', { [NESTED_SLOT_ATTRIBUTE]: slot, [NESTED_COMPONENT_ATTRIBUTE]: component }),
  );
  return append(wrapper, componentRoot(childId, state));
}

/** The `have` member of a recorded update request. */
function haveOf(call: { body: Record<string, unknown> }): {
  render: string | null;
  slots: Array<{ slot: string; component: string }>;
} {
  return call.body.have as {
    render: string | null;
    slots: Array<{ slot: string; component: string }>;
  };
}

function clickRefresh(h: Harness, root: FakeElement): void {
  const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
  dispatch(h.doc, fakeEvent('click', trigger));
}

function replyResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('nested server components', () => {
  it('reports each direct child by slot and component, and the root render tag', () => {
    const root = componentRoot('jsails-component-parent');
    root.setAttribute(COMPONENT_RENDER_ATTRIBUTE, 'parent-tag');
    const first = nestedChild(root, 'k:main', 'jsails-component-a', { count: 1 });
    nestedChild(first, 'p:leaf:0', 'jsails-component-g', { count: 3 }, 'leaf');
    nestedChild(root, 'p:shelf:0', 'jsails-component-b', { count: 2 }, 'shelf');
    const h = harness([root]);
    h.bindings.mountAll();
    assert.equal(h.bindings.size, 4);

    clickRefresh(h, root);

    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.fetchCalls[0]!.body.v, 2);
    // Grandchildren belong to their own parent; tokens never travel.
    assert.deepEqual(haveOf(h.fetchCalls[0]!), {
      render: 'parent-tag',
      slots: [
        { slot: 'k:main', component: 'card' },
        { slot: 'p:shelf:0', component: 'shelf' },
      ],
    });
    assert.equal(JSON.stringify(h.fetchCalls[0]!.body).includes('children'), false);
  });

  it('reports no slots when the root has no nested component, and no render without a tag', () => {
    const root = componentRoot('jsails-component-parent');
    const h = harness([root]);
    h.bindings.mountAll();
    clickRefresh(h, root);
    assert.deepEqual(haveOf(h.fetchCalls[0]!), { render: null, slots: [] });
  });

  it('leaves out a child that is blocked, unbound, or out of bounds', async () => {
    const root = componentRoot('jsails-component-parent');
    const blocked = nestedChild(root, 'k:blocked', 'jsails-component-blocked', { count: 0 });
    nestedChild(root, `k:${'s'.repeat(300)}`, 'jsails-component-long', { count: 0 });
    const unbound = append(
      root,
      fakeElement('div', {
        [NESTED_SLOT_ATTRIBUTE]: 'k:empty',
        [NESTED_COMPONENT_ATTRIBUTE]: 'card',
      }),
    );
    nestedChild(root, 'k:ok', 'jsails-component-ok', { count: 0 });
    const h = harness([root]);
    h.bindings.mountAll();
    assert.ok(unbound.children.length === 0);

    clickRefresh(h, blocked);
    h.resolveNext(new Response('boom', { status: 500 }));
    await flush();

    clickRefresh(h, root);
    assert.deepEqual(haveOf(h.fetchCalls[1]!).slots, [{ slot: 'k:ok', component: 'card' }]);
  });

  it('blocks without sending when the children exceed the cap', async () => {
    const root = componentRoot('jsails-component-parent');
    for (let index = 0; index < 1000; index += 1) {
      nestedChild(root, `k:item-${index}`, `jsails-component-${index}`, { count: 0 });
    }
    const h = harness([root]);
    h.bindings.mountAll();

    clickRefresh(h, root);
    await flush();

    assert.equal(h.fetchCalls.length, 0);
    assert.ok(
      h.errors.some(
        (error) => error instanceof ComponentControllerError && error.code === 'too_many_children',
      ),
    );
  });

  it('reconciles nested bindings after the parent morph', async () => {
    const root = componentRoot('jsails-component-parent');
    const kept = nestedChild(root, 'k:kept', 'jsails-component-kept', { count: 1 });
    const removed = nestedChild(root, 'k:removed', 'jsails-component-removed', { count: 2 });
    const swapped = nestedChild(root, 'k:swapped', 'jsails-component-old', { count: 3 });
    let added: FakeElement | undefined;
    const h = harness([root], {
      morph: async () => {
        // Removed child leaves the document.
        removed.isConnected = false;
        removed.parentElement!.remove();
        // A morph that keeps the element but swaps in another instance.
        (swapped as { id: string }).id = 'jsails-component-new';
        swapped.setAttribute('id', 'jsails-component-new');
        swapped.setAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE, makeToken({ count: 30 }));
        // A freshly mounted child appears.
        added = nestedChild(root, 'k:added', 'jsails-component-added', { count: 4 });
      },
    });
    h.bindings.mountAll();
    assert.equal(h.bindings.size, 4);

    clickRefresh(h, root);
    h.resolveNext(successResponse(1, { title: 'hello', count: 0 }));
    await flush();

    // parent, kept, swapped (rebound), added; removed is disposed.
    assert.equal(h.bindings.size, 4);
    assert.equal(removed.hasAttribute(ISLAND_HYDRATED_ATTRIBUTE), false);
    assert.equal(added?.getAttribute(ISLAND_HYDRATED_ATTRIBUTE), 'true');
    assert.equal(kept.getAttribute(ISLAND_HYDRATED_ATTRIBUTE), 'true');
    // No child issued a request of its own.
    assert.equal(h.fetchCalls.length, 1);

    clickRefresh(h, root);
    assert.deepEqual(
      haveOf(h.fetchCalls[1]!).slots.map(({ slot }) => slot),
      ['k:kept', 'k:swapped', 'k:added'],
    );
  });

  it('refreshes the kept children a parent action names, each with its own token', async () => {
    const root = componentRoot('jsails-component-parent');
    const child = nestedChild(root, 'k:main', 'jsails-component-a', { count: 1 });
    nestedChild(root, 'k:other', 'jsails-component-b', { count: 2 });
    const h = harness([root]);
    h.bindings.mountAll();

    clickRefresh(h, root);
    h.resolveNext(
      replyResponse({
        kind: 'render',
        sequence: 1,
        snapshot: makeToken({ title: 'hello', count: 0 }),
        html: '<div>ok</div>',
        render: 'tag-2',
        effects: { refresh: ['k:main', 'k:absent'] },
      }),
    );
    await flush();

    assert.equal(h.fetchCalls.length, 2);
    const refresh = h.fetchCalls[1]!;
    assert.deepEqual(refresh.body.action, { name: REFRESH_ACTION, args: {} });
    assert.equal(refresh.body.snapshot, child.getAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE));
  });

  it('retries a named child refresh the server answered busy, after its Retry-After', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const root = componentRoot('jsails-component-parent');
    nestedChild(root, 'k:main', 'jsails-component-a', { count: 1 });
    let call = 0;
    const h = harness([root], {
      fetch: async (url, init) => {
        call += 1;
        if (call === 1) {
          return replyResponse({
            kind: 'render',
            sequence: 1,
            snapshot: makeToken({ title: 'hello', count: 0 }),
            html: '<div>ok</div>',
            render: 'tag-2',
            effects: { refresh: ['k:main'] },
          });
        }
        if (call === 2) {
          // The component boundary's busy answer: 503 with `retry-after: 1`.
          return new Response('busy', { status: 503, headers: { 'retry-after': '1' } });
        }
        return echoFetch(url, init);
      },
    });
    h.bindings.mountAll();

    clickRefresh(h, root);
    for (let i = 0; i < 10; i += 1) await drain();
    assert.equal(h.fetchCalls.length, 2, 'the parent action and the child refresh');

    t.mock.timers.tick(999);
    for (let i = 0; i < 10; i += 1) await drain();
    assert.equal(h.fetchCalls.length, 2, 'the retry waits out the named second');

    t.mock.timers.tick(1);
    for (let i = 0; i < 10; i += 1) await drain();
    assert.equal(h.fetchCalls.length, 3);
    assert.deepEqual(h.fetchCalls[2]!.body.action, { name: REFRESH_ACTION, args: {} });
    assert.deepEqual(h.errors, [], 'the recovered refresh reports nothing');
  });

  it('re-renders the parent in full once when a keep marker lands in the DOM', async () => {
    const root = componentRoot('jsails-component-parent');
    root.setAttribute(COMPONENT_RENDER_ATTRIBUTE, 'tag-1');
    const h = harness([root], {
      morph: async () => {
        // The server kept a child the client no longer holds.
        const wrapper = append(
          root,
          fakeElement('div', {
            [NESTED_SLOT_ATTRIBUTE]: 'k:main',
            [NESTED_COMPONENT_ATTRIBUTE]: 'card',
          }),
        );
        append(wrapper, fakeElement('template', { [NESTED_KEEP_ATTRIBUTE]: '' }));
      },
    });
    h.bindings.mountAll();

    clickRefresh(h, root);
    h.resolveNext(successResponse(1, { title: 'hello', count: 0 }));
    await flush();

    assert.equal(h.fetchCalls.length, 2);
    assert.deepEqual(h.fetchCalls[1]!.body.action, { name: REFRESH_ACTION, args: {} });
    assert.equal(haveOf(h.fetchCalls[1]!).render, null);
  });

  it('applies an unchanged reply without a morph and pins a re-signed token', async () => {
    const root = componentRoot('jsails-component-parent');
    root.setAttribute(COMPONENT_RENDER_ATTRIBUTE, 'tag-1');
    const h = harness([root]);
    h.bindings.mountAll();

    clickRefresh(h, root);
    h.resolveNext(replyResponse({ kind: 'unchanged', sequence: 1 }));
    await flush();
    assert.equal(h.morphs.length, 0);

    const renewed = makeToken({ title: 'hello', count: 0 });
    clickRefresh(h, root);
    h.resolveNext(replyResponse({ kind: 'unchanged', sequence: 2, snapshot: renewed }));
    await flush();

    assert.equal(h.morphs.length, 0);
    assert.equal(root.getAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE), renewed);
    assert.equal(haveOf(h.fetchCalls[1]!).render, 'tag-1');
    assert.equal(h.errors.length, 0);
  });

  it('reloads once on a protocol mismatch, then blocks', async () => {
    const stored = new Map<string, string>();
    const reloads: string[] = [];
    const scope = globalThis as {
      sessionStorage?: unknown;
      location?: unknown;
    };
    const previous = { sessionStorage: scope.sessionStorage, location: scope.location };
    scope.sessionStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    };
    scope.location = { href: `${ORIGIN}/page` };
    try {
      for (const expected of [1, 1]) {
        const root = componentRoot(`jsails-component-${expected}-${reloads.length}`);
        const h = harness([root], {
          navigate: (url) => {
            reloads.push(url);
          },
        });
        h.bindings.mountAll();
        clickRefresh(h, root);
        h.resolveNext(replyResponse({ kind: 'protocol_mismatch', sequence: 0, v: 3 }, 400));
        await flush();
        assert.equal(reloads.length, expected);
      }
    } finally {
      scope.sessionStorage = previous.sessionStorage;
      scope.location = previous.location;
    }
    assert.deepEqual(reloads, [`${ORIGIN}/page`]);
  });
});

describe('keepsNestedWrapper', () => {
  function wrapper(id: string, slot: string, component: string): FakeElement {
    return fakeElement('div', {
      id,
      [NESTED_SLOT_ATTRIBUTE]: slot,
      [NESTED_COMPONENT_ATTRIBUTE]: component,
    });
  }

  it('keeps a wrapper whose replacement carries the keep marker', () => {
    const current = wrapper('w1', 'k:main', 'card');
    append(current, componentRoot('jsails-component-a'));
    const next = wrapper('w1', 'k:main', 'card');
    append(next, fakeElement('template', { [NESTED_KEEP_ATTRIBUTE]: '' }));
    assert.equal(keepsNestedWrapper(current, next), true);
  });

  it('morphs anything else', () => {
    const current = wrapper('w1', 'k:main', 'card');
    append(current, componentRoot('jsails-component-a'));
    const marker = (): FakeElement => fakeElement('template', { [NESTED_KEEP_ATTRIBUTE]: '' });
    const withMarker = (element: FakeElement): FakeElement => {
      append(element, marker());
      return element;
    };
    // Another id, slot, or component; no marker; a nested (not direct) marker.
    assert.equal(keepsNestedWrapper(current, withMarker(wrapper('w2', 'k:main', 'card'))), false);
    assert.equal(keepsNestedWrapper(current, withMarker(wrapper('w1', 'k:x', 'card'))), false);
    assert.equal(keepsNestedWrapper(current, withMarker(wrapper('w1', 'k:main', 'x'))), false);
    assert.equal(keepsNestedWrapper(current, wrapper('w1', 'k:main', 'card')), false);
    const deep = wrapper('w1', 'k:main', 'card');
    append(append(deep, fakeElement('div')), marker());
    assert.equal(keepsNestedWrapper(current, deep), false);
    // A current wrapper that lost its child cannot be kept.
    const empty = wrapper('w1', 'k:main', 'card');
    assert.equal(keepsNestedWrapper(empty, withMarker(wrapper('w1', 'k:main', 'card'))), false);
    // Non-elements (a removal passes no replacement).
    assert.equal(keepsNestedWrapper(current, undefined), false);
    assert.equal(keepsNestedWrapper(null, current), false);
  });
});
