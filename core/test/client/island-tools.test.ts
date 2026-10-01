/**
 * Island tool runtime tests (Node-import safe).
 *
 * These exercise the hook's DOM half against a small structural element double:
 * the delegated call/submit/sort listeners, `.once`/`.confirm` gating, the
 * intersection observer's fire-once/re-arm contract, bind/debounce/capture,
 * show/text directives, loading markers, polling, ref lookup, nested-island
 * exclusion, unknown-action reporting, and teardown. A separate SSR case proves
 * the hook renders without running effects.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createElement } from 'preact';

import { attachIslandTools, findRefIn, useIslandTools } from '../../src/client/island-tools.js';
import { ISLAND_ATTRIBUTE } from '../../src/client/islands.js';
import { renderToString } from '../../src/jsx/render-to-string.js';
import {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  CONFIRM_ATTRIBUTE,
  DEBOUNCE_ATTRIBUTE,
  INTERSECT_ATTRIBUTE,
  LOADING_ATTRIBUTE,
  LOADING_TARGET_ATTRIBUTE,
  MODEL_ATTRIBUTE,
  ONCE_ATTRIBUTE,
  POLL_ATTRIBUTE,
  REF_ATTRIBUTE,
  SHOW_ATTRIBUTE,
  SORT_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
  TEXT_ATTRIBUTE,
} from '../../src/server-components/protocol.js';

// ---------------------------------------------------------------------------
// Structural element double
// ---------------------------------------------------------------------------

interface FakeElement {
  readonly tagName: string;
  readonly attributes: Map<string, string>;
  readonly children: FakeElement[];
  parentElement: FakeElement | null;
  readonly listeners: Map<string, Array<(event: Event) => void>>;
  hidden: boolean;
  textContent: string;
  value: string;
  checked: boolean;
  type: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  closest(selector: string): FakeElement | null;
  contains(other: FakeElement | null): boolean;
  querySelectorAll(selector: string): FakeElement[];
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

function fakeElement(
  attrs: Record<string, string> = {},
  options: { tagName?: string; type?: string; value?: string; checked?: boolean } = {},
): FakeElement {
  const attributes = new Map<string, string>(Object.entries(attrs));
  const element: FakeElement = {
    tagName: options.tagName ?? 'div',
    attributes,
    children: [],
    parentElement: null,
    listeners: new Map(),
    hidden: false,
    textContent: '',
    value: options.value ?? '',
    checked: options.checked ?? false,
    type: options.type ?? '',
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => {
      attributes.set(name, value);
    },
    removeAttribute: (name) => {
      attributes.delete(name);
    },
    hasAttribute: (name) => attributes.has(name),
    closest: (selector) => closest(element, selector),
    contains: (other) => {
      if (other === null) {
        return false;
      }
      if (other === element) {
        return true;
      }
      return element.children.some((child) => child.contains(other));
    },
    querySelectorAll: (selector) =>
      descendants(element).filter((candidate) => matches(candidate, selector)),
    addEventListener: (type, listener) => {
      const list = element.listeners.get(type) ?? [];
      list.push(listener);
      element.listeners.set(type, list);
    },
    removeEventListener: (type, listener) => {
      const list = (element.listeners.get(type) ?? []).filter((entry) => entry !== listener);
      element.listeners.set(type, list);
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

/** Minimal selector support: `[attr]` only, which is all the runtime uses. */
function matches(element: FakeElement, selector: string): boolean {
  const attrMatch = /^\[([^\]]+)\]$/.exec(selector);
  return attrMatch !== null && element.attributes.has(attrMatch[1]!);
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

interface FakeEvent extends Event {
  readonly prevented: boolean;
}

function fakeEvent(target: FakeElement | null): FakeEvent {
  const event = {
    target,
    prevented: false,
    preventDefault: () => {
      event.prevented = true;
    },
  };
  return event as unknown as FakeEvent;
}

function dispatch(root: FakeElement, type: string, target: FakeElement): FakeEvent {
  const event = fakeEvent(target);
  for (const listener of root.listeners.get(type) ?? []) {
    listener(event);
  }
  return event;
}

function asRoot(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Fake document
// ---------------------------------------------------------------------------

interface FakeDocument {
  hidden: boolean;
  readonly listeners: Map<string, Array<() => void>>;
  querySelector(selector: string): FakeElement | null;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

function installFakeDocument(selectors: Record<string, FakeElement> = {}): {
  doc: FakeDocument;
  restore: () => void;
} {
  const original = (globalThis as { document?: unknown }).document;
  const listeners = new Map<string, Array<() => void>>();
  const doc: FakeDocument = {
    hidden: false,
    listeners,
    querySelector: (selector) => selectors[selector] ?? null,
    addEventListener: (type, listener) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener: (type, listener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
  };
  (globalThis as { document?: unknown }).document = doc;
  return {
    doc,
    restore: () => {
      if (original === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = original;
      }
    },
  };
}

function fireDocument(doc: FakeDocument, type: string): void {
  for (const listener of doc.listeners.get(type) ?? []) {
    listener();
  }
}

// ---------------------------------------------------------------------------
// Fake IntersectionObserver
// ---------------------------------------------------------------------------

interface FakeObserver {
  callback: (entries: IntersectionObserverEntry[]) => void;
  observed: FakeElement[];
  disconnected: boolean;
  observe(element: FakeElement): void;
  unobserve(element: FakeElement): void;
  disconnect(): void;
}

function installFakeIntersectionObserver(): {
  created: FakeObserver[];
  restore: () => void;
} {
  const created: FakeObserver[] = [];
  const original = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

  class FakeIntersectionObserver {
    readonly callback: (entries: IntersectionObserverEntry[]) => void;
    observed: FakeElement[] = [];
    disconnected = false;

    constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
      this.callback = callback;
      created.push(this);
    }

    observe(element: FakeElement): void {
      this.observed.push(element);
    }

    unobserve(element: FakeElement): void {
      this.observed = this.observed.filter((entry) => entry !== element);
    }

    disconnect(): void {
      this.disconnected = true;
      this.observed = [];
    }
  }

  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    FakeIntersectionObserver;

  return {
    created,
    restore: () => {
      if (original === undefined) {
        delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
      } else {
        (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original;
      }
    },
  };
}

function intersect(observer: FakeObserver, target: FakeElement): void {
  if (!observer.observed.includes(target)) {
    return;
  }
  observer.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry]);
}

// ---------------------------------------------------------------------------
// Intersect
// ---------------------------------------------------------------------------

describe('island tools: intersect', () => {
  it('fires the named handler once with an empty object and re-arms after a re-render', () => {
    const root = fakeElement();
    const sentinel = append(root, fakeElement({ [INTERSECT_ATTRIBUTE]: 'loadMore' }));
    const calls: Array<Record<string, unknown>> = [];
    const handlers = {
      loadMore: (args: Record<string, unknown>) => {
        calls.push(args);
      },
    };
    const fake = installFakeIntersectionObserver();
    try {
      const teardown = attachIslandTools(asRoot(root), { handlers });
      assert.equal(fake.created.length, 1);
      const first = fake.created[0]!;
      assert.equal(first.observed.length, 1);
      assert.equal(first.observed[0], sentinel);

      intersect(first, sentinel);
      assert.deepEqual(calls, [{}]);
      assert.equal(first.observed.length, 0);

      intersect(first, sentinel);
      assert.equal(calls.length, 1);

      teardown();
      assert.equal(first.disconnected, true);
      const teardownAgain = attachIslandTools(asRoot(root), { handlers });
      assert.equal(fake.created.length, 2);
      const second = fake.created[1]!;
      assert.equal(second.observed.length, 1);
      assert.equal(second.observed[0], sentinel);
      intersect(second, sentinel);
      assert.equal(calls.length, 2);
      teardownAgain();
    } finally {
      fake.restore();
    }
  });

  it('skips intersection wiring when IntersectionObserver is unavailable', () => {
    const root = fakeElement();
    append(root, fakeElement({ [INTERSECT_ATTRIBUTE]: 'loadMore' }));
    const button = append(root, fakeElement({ [CALL_ATTRIBUTE]: 'save' }));
    const original = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    try {
      const calls: Array<Record<string, unknown>> = [];
      const teardown = attachIslandTools(asRoot(root), {
        handlers: {
          save: (args) => {
            calls.push(args);
          },
        },
      });
      dispatch(root, 'click', button);
      assert.deepEqual(calls, [{}]);
      teardown();
    } finally {
      if (original === undefined) {
        delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
      } else {
        (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Call
// ---------------------------------------------------------------------------

describe('island tools: call', () => {
  it('parses data-jsails-args JSON and invokes the named handler on click', () => {
    const root = fakeElement();
    const button = append(
      root,
      fakeElement({ [CALL_ATTRIBUTE]: 'save', [ARGS_ATTRIBUTE]: '{"id":7}' }),
    );
    const calls: Array<Record<string, unknown>> = [];
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {
        save: (args) => {
          calls.push(args);
        },
      },
    });

    const event = dispatch(root, 'click', button);
    assert.deepEqual(calls, [{ id: 7 }]);
    assert.equal(event.prevented, true);
    teardown();
  });

  it('invokes a call handler with an empty object when args are absent', () => {
    const root = fakeElement();
    const button = append(root, fakeElement({ [CALL_ATTRIBUTE]: 'save' }));
    const calls: Array<Record<string, unknown>> = [];
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {
        save: (args) => {
          calls.push(args);
        },
      },
    });

    dispatch(root, 'click', button);
    assert.deepEqual(calls, [{}]);
    teardown();
  });

  it('honours data-jsails-once across repeated clicks', () => {
    const root = fakeElement();
    const button = append(root, fakeElement({ [CALL_ATTRIBUTE]: 'save', [ONCE_ATTRIBUTE]: '' }));
    let count = 0;
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {
        save: () => {
          count += 1;
        },
      },
    });

    dispatch(root, 'click', button);
    dispatch(root, 'click', button);
    assert.equal(count, 1);
    teardown();
  });

  it('aborts dispatch when the confirm callback returns false', () => {
    const root = fakeElement();
    const button = append(
      root,
      fakeElement({ [CALL_ATTRIBUTE]: 'save', [CONFIRM_ATTRIBUTE]: 'Sure?' }),
    );
    let count = 0;
    const messages: string[] = [];
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {
        save: () => {
          count += 1;
        },
      },
      confirm: (message) => {
        messages.push(message);
        return false;
      },
    });

    const event = dispatch(root, 'click', button);
    assert.equal(count, 0);
    assert.deepEqual(messages, ['Sure?']);
    assert.equal(event.prevented, false);
    teardown();
  });

  it('dispatches when the confirm callback returns true', () => {
    const root = fakeElement();
    const button = append(
      root,
      fakeElement({ [CALL_ATTRIBUTE]: 'save', [CONFIRM_ATTRIBUTE]: 'Sure?' }),
    );
    let count = 0;
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {
        save: () => {
          count += 1;
        },
      },
      confirm: () => true,
    });

    dispatch(root, 'click', button);
    assert.equal(count, 1);
    teardown();
  });

  it('reports malformed args and does not dispatch', () => {
    const root = fakeElement();
    const button = append(
      root,
      fakeElement({ [CALL_ATTRIBUTE]: 'save', [ARGS_ATTRIBUTE]: '{bad' }),
    );
    const calls: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...data: unknown[]) => {
      warnings.push(String(data[0]));
    };
    try {
      const teardown = attachIslandTools(asRoot(root), {
        handlers: {
          save: (args) => {
            calls.push(args);
          },
        },
      });
      const event = dispatch(root, 'click', button);
      assert.deepEqual(calls, []);
      assert.deepEqual(warnings, ['jsails: component binding failed: invalid action arguments']);
      assert.equal(event.prevented, false);
      teardown();
    } finally {
      console.warn = originalWarn;
    }
  });

  it('reports an unknown action instead of throwing', () => {
    const root = fakeElement();
    const button = append(root, fakeElement({ [CALL_ATTRIBUTE]: 'missing' }));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...data: unknown[]) => {
      warnings.push(String(data[0]));
    };
    try {
      const teardown = attachIslandTools(asRoot(root), { handlers: {} });
      const event = dispatch(root, 'click', button);
      assert.deepEqual(warnings, ['jsails: component binding failed: Unknown action']);
      assert.equal(event.prevented, true);
      teardown();
    } finally {
      console.warn = originalWarn;
    }
  });

  it('ignores clicks on unrelated markup', () => {
    const root = fakeElement();
    const plain = append(root, fakeElement());
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...data: unknown[]) => {
      warnings.push(String(data[0]));
    };
    try {
      const teardown = attachIslandTools(asRoot(root), { handlers: {} });
      const event = dispatch(root, 'click', plain);
      assert.deepEqual(warnings, []);
      assert.equal(event.prevented, false);
      teardown();
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

describe('island tools: sort', () => {
  it('dispatches the reserved sort action with the field name', () => {
    const root = fakeElement();
    const trigger = append(root, fakeElement({ [SORT_ATTRIBUTE]: 'title' }));
    const calls: Array<Record<string, unknown>> = [];
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {
        sort: (args) => {
          calls.push(args);
        },
      },
    });

    const event = dispatch(root, 'click', trigger);
    assert.deepEqual(calls, [{ field: 'title' }]);
    assert.equal(event.prevented, true);
    teardown();
  });

  it('prefers an explicit call marker over the sort fallback', () => {
    const root = fakeElement();
    const trigger = append(
      root,
      fakeElement({ [CALL_ATTRIBUTE]: 'save', [SORT_ATTRIBUTE]: 'title' }),
    );
    const calls: string[] = [];
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {
        save: () => {
          calls.push('save');
        },
        sort: () => {
          calls.push('sort');
        },
      },
    });

    dispatch(root, 'click', trigger);
    assert.deepEqual(calls, ['save']);
    teardown();
  });
});

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

describe('island tools: submit', () => {
  it('parses args and invokes the submit handler', () => {
    const root = fakeElement();
    const form = append(
      root,
      fakeElement({ [SUBMIT_ATTRIBUTE]: 'save', [ARGS_ATTRIBUTE]: '{"id":3}' }),
    );
    const calls: Array<Record<string, unknown>> = [];
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {
        save: (args) => {
          calls.push(args);
        },
      },
    });

    const event = dispatch(root, 'submit', form);
    assert.deepEqual(calls, [{ id: 3 }]);
    assert.equal(event.prevented, true);
    teardown();
  });

  it('honours once and confirm on submit', () => {
    const root = fakeElement();
    const form = append(
      root,
      fakeElement({
        [SUBMIT_ATTRIBUTE]: 'save',
        [ONCE_ATTRIBUTE]: '',
        [CONFIRM_ATTRIBUTE]: 'Sure?',
      }),
    );
    let count = 0;
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {
        save: () => {
          count += 1;
        },
      },
      confirm: () => true,
    });

    dispatch(root, 'submit', form);
    dispatch(root, 'submit', form);
    assert.equal(count, 1);
    teardown();
  });
});

// ---------------------------------------------------------------------------
// Show / text
// ---------------------------------------------------------------------------

describe('island tools: show and text', () => {
  it('applies show/text from the state snapshot and re-applies on re-attach', () => {
    const root = fakeElement();
    const shown = append(root, fakeElement({ [SHOW_ATTRIBUTE]: 'visible' }));
    const text = append(root, fakeElement({ [TEXT_ATTRIBUTE]: 'label' }));

    const first = attachIslandTools(asRoot(root), {
      handlers: {},
      state: { visible: true, label: 'hello' },
    });
    assert.equal(shown.hidden, false);
    assert.equal(text.textContent, 'hello');
    first();

    const second = attachIslandTools(asRoot(root), {
      handlers: {},
      state: { visible: false, label: { a: 1 } },
    });
    assert.equal(shown.hidden, true);
    assert.equal(text.textContent, '{"a":1}');
    second();
  });

  it('renders null/undefined text as an empty string', () => {
    const root = fakeElement();
    const text = append(root, fakeElement({ [TEXT_ATTRIBUTE]: 'label' }));
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {},
      state: { label: null },
    });
    assert.equal(text.textContent, '');
    teardown();
  });
});

// ---------------------------------------------------------------------------
// Bind / debounce / capture
// ---------------------------------------------------------------------------

describe('island tools: bind', () => {
  it('writes input values through onInput', () => {
    const root = fakeElement();
    const input = append(
      root,
      fakeElement({ [MODEL_ATTRIBUTE]: 'name' }, { tagName: 'input', value: 'Ada' }),
    );
    const writes: Array<[string, unknown]> = [];
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {},
      onInput: (name, value) => {
        writes.push([name, value]);
      },
    });

    dispatch(root, 'input', input);
    assert.deepEqual(writes, [['name', 'Ada']]);
    teardown();
  });

  it('reads a checkbox as its checked boolean', () => {
    const root = fakeElement();
    const input = append(
      root,
      fakeElement(
        { [MODEL_ATTRIBUTE]: 'active' },
        { tagName: 'input', type: 'checkbox', checked: true },
      ),
    );
    const writes: Array<[string, unknown]> = [];
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {},
      onInput: (name, value) => {
        writes.push([name, value]);
      },
    });

    dispatch(root, 'change', input);
    assert.deepEqual(writes, [['active', true]]);
    teardown();
  });

  it('skips file inputs', () => {
    const root = fakeElement();
    const input = append(
      root,
      fakeElement({ [MODEL_ATTRIBUTE]: 'upload' }, { tagName: 'input', type: 'file' }),
    );
    const writes: Array<[string, unknown]> = [];
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {},
      onInput: (name, value) => {
        writes.push([name, value]);
      },
    });

    dispatch(root, 'change', input);
    assert.deepEqual(writes, []);
    teardown();
  });

  it('debounces a field and flushes on focusout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const root = fakeElement();
    const input = append(
      root,
      fakeElement(
        { [MODEL_ATTRIBUTE]: 'q', [DEBOUNCE_ATTRIBUTE]: '100' },
        { tagName: 'input', value: 'a' },
      ),
    );
    const writes: Array<[string, unknown]> = [];
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {},
      onInput: (name, value) => {
        writes.push([name, value]);
      },
    });

    dispatch(root, 'input', input);
    assert.deepEqual(writes, []);
    t.mock.timers.tick(100);
    await flush();
    assert.deepEqual(writes, [['q', 'a']]);

    input.value = 'b';
    dispatch(root, 'input', input);
    assert.deepEqual(writes, [['q', 'a']]);
    dispatch(root, 'focusout', input);
    assert.deepEqual(writes, [
      ['q', 'a'],
      ['q', 'b'],
    ]);
    teardown();
  });

  it('captures bound values before dispatching a call', () => {
    const root = fakeElement();
    append(root, fakeElement({ [MODEL_ATTRIBUTE]: 'name' }, { tagName: 'input', value: 'Ada' }));
    const button = append(root, fakeElement({ [CALL_ATTRIBUTE]: 'save' }));
    const order: string[] = [];
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {
        save: () => {
          order.push('save');
        },
      },
      onInput: (name, value) => {
        order.push(`input:${name}=${String(value)}`);
      },
    });

    dispatch(root, 'click', button);
    assert.deepEqual(order, ['input:name=Ada', 'save']);
    teardown();
  });
});

// ---------------------------------------------------------------------------
// Loading markers
// ---------------------------------------------------------------------------

describe('island tools: loading markers', () => {
  it('sets the root and loading-target markers while a handler is in flight', async () => {
    const root = fakeElement();
    const spinner = fakeElement();
    const button = append(root, fakeElement({ [CALL_ATTRIBUTE]: 'save' }));
    append(root, fakeElement({ [LOADING_TARGET_ATTRIBUTE]: '#spinner' }));
    const fakeDoc = installFakeDocument({ '#spinner': spinner });
    let resolveHandler: (() => void) | undefined;
    try {
      const teardown = attachIslandTools(asRoot(root), {
        handlers: {
          save: () =>
            new Promise<void>((resolve) => {
              resolveHandler = resolve;
            }),
        },
      });

      dispatch(root, 'click', button);
      assert.equal(root.getAttribute(LOADING_ATTRIBUTE), 'true');
      assert.equal(spinner.getAttribute(LOADING_ATTRIBUTE), 'true');

      resolveHandler?.();
      await flush();
      assert.equal(root.getAttribute(LOADING_ATTRIBUTE), null);
      assert.equal(spinner.getAttribute(LOADING_ATTRIBUTE), null);
      teardown();
    } finally {
      fakeDoc.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

describe('island tools: poll', () => {
  it('invokes $refresh on the interval', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const root = fakeElement();
    append(root, fakeElement({ [POLL_ATTRIBUTE]: '{"intervalMs":250}' }));
    let count = 0;
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {
        $refresh: () => {
          count += 1;
        },
      },
    });

    t.mock.timers.tick(250);
    await flush();
    assert.equal(count, 1);
    t.mock.timers.tick(250);
    await flush();
    assert.equal(count, 2);
    teardown();
  });

  it('pauses while the document is hidden and resumes on visibilitychange', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fakeDoc = installFakeDocument();
    fakeDoc.doc.hidden = true;
    const root = fakeElement();
    append(root, fakeElement({ [POLL_ATTRIBUTE]: '{"intervalMs":250,"pauseWhenHidden":true}' }));
    let count = 0;
    try {
      const teardown = attachIslandTools(asRoot(root), {
        handlers: {
          $refresh: () => {
            count += 1;
          },
        },
      });

      t.mock.timers.tick(250);
      await flush();
      assert.equal(count, 0);

      fakeDoc.doc.hidden = false;
      fireDocument(fakeDoc.doc, 'visibilitychange');
      t.mock.timers.tick(250);
      await flush();
      assert.equal(count, 1);
      teardown();
    } finally {
      fakeDoc.restore();
    }
  });

  it('rejects an invalid poll marker', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const root = fakeElement();
    append(root, fakeElement({ [POLL_ATTRIBUTE]: '{"intervalMs":10}' }));
    let count = 0;
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {
        $refresh: () => {
          count += 1;
        },
      },
    });

    t.mock.timers.tick(1000);
    await flush();
    assert.equal(count, 0);
    teardown();
  });
});

// ---------------------------------------------------------------------------
// Ref lookup
// ---------------------------------------------------------------------------

describe('island tools: findRef', () => {
  it('finds a descendant by data-jsails-ref value', () => {
    const root = fakeElement();
    const target = append(root, fakeElement({ [REF_ATTRIBUTE]: 'target' }));
    append(root, fakeElement({ [REF_ATTRIBUTE]: 'other' }));

    assert.equal(findRefIn(asRoot(root), 'target'), asRoot(target));
    assert.equal(findRefIn(asRoot(root), 'missing'), null);
    assert.equal(findRefIn(asRoot(root), ''), null);
  });
});

// ---------------------------------------------------------------------------
// Nested islands
// ---------------------------------------------------------------------------

describe('island tools: nested islands', () => {
  it('ignores events inside a nested island subtree', () => {
    const root = fakeElement({ [ISLAND_ATTRIBUTE]: 'outer' });
    const nested = append(root, fakeElement({ [ISLAND_ATTRIBUTE]: 'inner' }));
    const nestedButton = append(nested, fakeElement({ [CALL_ATTRIBUTE]: 'save' }));
    const ownButton = append(root, fakeElement({ [CALL_ATTRIBUTE]: 'save' }));
    let count = 0;
    const teardown = attachIslandTools(asRoot(root), {
      handlers: {
        save: () => {
          count += 1;
        },
      },
    });

    dispatch(root, 'click', nestedButton);
    assert.equal(count, 0);
    dispatch(root, 'click', ownButton);
    assert.equal(count, 1);
    teardown();
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('island tools: teardown', () => {
  it('removes listeners, disconnects the observer, and stops polling', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const root = fakeElement();
    const button = append(root, fakeElement({ [CALL_ATTRIBUTE]: 'save' }));
    append(root, fakeElement({ [INTERSECT_ATTRIBUTE]: 'loadMore' }));
    append(root, fakeElement({ [POLL_ATTRIBUTE]: '{"intervalMs":250}' }));
    let calls = 0;
    let refreshes = 0;
    const fake = installFakeIntersectionObserver();
    try {
      const teardown = attachIslandTools(asRoot(root), {
        handlers: {
          save: () => {
            calls += 1;
          },
          $refresh: () => {
            refreshes += 1;
          },
        },
      });
      const observer = fake.created[0]!;
      teardown();

      assert.equal(observer.disconnected, true);
      dispatch(root, 'click', button);
      assert.equal(calls, 0);
      t.mock.timers.tick(250);
      await flush();
      assert.equal(refreshes, 0);
    } finally {
      fake.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// SSR
// ---------------------------------------------------------------------------

describe('island tools: SSR', () => {
  it('renders without running effects', () => {
    function Island() {
      const { ref } = useIslandTools<HTMLDivElement>({ handlers: {} });
      return createElement('div', { ref });
    }

    const html = renderToString(createElement(Island, {}));
    assert.match(html, /<div/);
  });
});
