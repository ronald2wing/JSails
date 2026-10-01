/**
 * The browser the real client runs in: a happy-dom window whose DOM API is
 * installed as this thread's globals for one scenario.
 *
 * The window's URL is the loopback origin of the scenario's server, so
 * happy-dom's XHR and `fetch` make real HTTP requests with browser
 * semantics: redirects are followed (a `303` turns into a `GET`, a `302`
 * after `PUT` stays a `PUT`), request headers survive a redirect, and
 * `Set-Cookie` lands in the cookie jar, `HttpOnly` cookies included, and goes
 * back on the next request. Main-frame navigation is disabled, so a full page
 * visit (`location.href = …`) only changes the URL; the scenario reads it.
 *
 * Every own and inherited property of the window that this thread does not
 * already define becomes a global, plus the overrides below where Node's own
 * global would be the wrong object for client code (`fetch` must resolve
 * relative URLs against the page and use the cookie jar; `Event` and
 * `CustomEvent` must be happy-dom's to be dispatched on its nodes; Node's Web
 * Storage must not stand in for the page's; timers must belong to the window,
 * so closing it cancels whatever a finished scenario's client still had
 * scheduled instead of letting it run against the next scenario's globals).
 * Node's `Request`, `Response`, and `Headers` stay in place for the server
 * half running in the same thread. `close()` restores every global it
 * replaced.
 */

import { Window } from 'happy-dom';

const SKIPPED: ReadonlySet<string> = new Set(['constructor', 'undefined', 'NaN', 'Infinity']);

const TIMER_NAMES = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
] as const;

const OVERRIDES: ReadonlySet<string> = new Set([
  'window',
  'self',
  'document',
  'navigator',
  'location',
  'history',
  'fetch',
  'Event',
  'CustomEvent',
  'localStorage',
  'sessionStorage',
  ...TIMER_NAMES,
]);

/** The window whose timers the global timer functions schedule on, if any. */
let current: Window | null = null;

const NODE_TIMERS: ReadonlyMap<string, unknown> = new Map(
  TIMER_NAMES.map((name) => [name, Reflect.get(globalThis, name)]),
);

/**
 * A stable global timer function that schedules on the window open when it
 * is called, else on Node's timers. Stable because React's CommonJS build is
 * shared by every `react` graph and captures the timer functions once, when
 * it first loads; a callback still pending when its window closes is
 * cancelled with it.
 */
function delegateTimer(name: string): (...args: unknown[]) => unknown {
  return (...args) => {
    const target: unknown = current === null ? NODE_TIMERS.get(name) : Reflect.get(current, name);
    if (typeof target !== 'function') throw new Error(`no ${name} to delegate to`);
    return Reflect.apply(target, current ?? globalThis, args);
  };
}

const TIMERS: ReadonlyMap<string, unknown> = new Map(
  TIMER_NAMES.map((name) => [name, delegateTimer(name)]),
);

/** An open browser window bound to the globals. */
export interface Browser {
  readonly window: Window;
  /** Errors the page raised in event listeners and timers. */
  readonly errors: unknown[];
  /** Load `path` as a full page visit: fetch the document and write it into the window. */
  open(path: string): Promise<void>;
  /** Restore the globals and close the window. */
  close(): Promise<void>;
}

/** Open a window on `origin` and install it as the globals. */
export function openBrowser(origin: string): Browser {
  const window = new Window({
    url: `${origin}/`,
    settings: { navigation: { disableMainFrameNavigation: true } },
  });
  const errors: unknown[] = [];
  window.addEventListener('error', (event) => {
    errors.push(Reflect.get(event, 'error') ?? event);
  });
  const restore = installGlobals(window);
  current = window;
  return {
    window,
    errors,
    async open(path: string): Promise<void> {
      const url = new URL(path, origin).href;
      window.happyDOM.setURL(url);
      const response = await window.fetch(url, { headers: { Accept: 'text/html' } });
      const html = await response.text();
      window.document.open();
      window.document.write(html);
      window.document.close();
    },
    async close(): Promise<void> {
      restore();
      if (current === window) current = null;
      await window.happyDOM.abort();
      await window.happyDOM.close();
    },
  };
}

function installGlobals(window: Window): () => void {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of windowNames(window)) {
    const existing = Object.getOwnPropertyDescriptor(globalThis, name);
    if (existing !== undefined && !OVERRIDES.has(name)) continue;
    if (existing !== undefined && existing.configurable !== true) continue;
    if (!OVERRIDES.has(name) && name in globalThis) continue;
    const value: unknown = Reflect.get(window, name);
    previous.set(name, existing);
    Object.defineProperty(globalThis, name, {
      value:
        name === 'window' || name === 'self'
          ? window
          : (TIMERS.get(name) ?? bindMethod(window, name, value)),
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

/** Methods (lower-case names) are bound to the window; classes are installed as they are. */
function bindMethod(window: Window, name: string, value: unknown): unknown {
  if (typeof value !== 'function' || !/^[a-z]/u.test(name)) return value;
  const method: (...args: unknown[]) => unknown = value.bind(window);
  return method;
}

function windowNames(window: Window): Set<string> {
  const names = new Set<string>(OVERRIDES);
  for (
    let target: object | null = window;
    target !== null && target !== Object.prototype;
    target = Reflect.getPrototypeOf(target)
  ) {
    for (const name of Object.getOwnPropertyNames(target)) {
      if (!SKIPPED.has(name)) names.add(name);
    }
  }
  return names;
}
