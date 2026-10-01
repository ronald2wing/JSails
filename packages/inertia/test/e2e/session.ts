/**
 * One end-to-end session: the demo server on a loopback port, a happy-dom
 * browser on its origin, and a fresh client graph of one flavor, plus the
 * user actions and observations a scenario is written in.
 *
 * Actions are what a user or app code does: open a URL, click, type (through
 * the native value setter, so React's value tracker sees the change), call
 * the router. Observations are what the scenario asserts on and what the
 * differential compares between `preact/compat` and React 19: a trace of
 * labelled snapshots (the root element serialized with sorted attributes, the
 * location, the history length), where an input shows its current `value`
 * property instead of its `value` attribute, because React mirrors a
 * controlled value into the attribute and Preact sets only the property, a
 * renderer difference no user or protocol step can observe; the server's
 * request log; and the client events (`flash`, `location`) the app received. Any error the page raised
 * and any `console.error` or `console.warn` during the session fails it.
 */

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import type { Node, Window } from 'happy-dom';

import type { InertiaSsr } from '../../src/index.js';
import { startAppServer, type AppServer, type RequestRecord } from './app-server.js';
import { openBrowser, type Browser } from './browser.js';
import {
  createDemoClient,
  createDemoServer,
  type DemoClient,
  type DemoServer,
} from './demo-app.js';
import { loadClient, type ClientFlavor, type ClientModules } from './module-graph.js';

/** One labelled observation of the page. */
export interface Snapshot {
  readonly label: string;
  readonly html: string;
  readonly url: string;
  readonly historyLength: number;
}

/** What a session observed, compared across flavors. */
export interface SessionRecord {
  readonly trace: readonly Snapshot[];
  readonly requests: readonly RequestRecord[];
  readonly events: readonly (readonly [string, unknown])[];
}

/** A running session. */
export interface Session {
  readonly flavor: ClientFlavor;
  readonly demo: DemoServer;
  readonly server: AppServer;
  readonly browser: Browser;
  readonly client: ClientModules;
  readonly demoClient: DemoClient;
  /**
   * Client events received, as `[name, detail]`; a `location` event's URL is
   * relative to the server's origin when it points there.
   */
  readonly events: (readonly [string, unknown])[];
  /** Load `path` as a first visit and boot the client app on it. */
  boot(path: string): Promise<void>;
  /** Boot the client app on the document already open (`browser.open`). */
  start(): Promise<void>;
  /** The text of the first match, or `''` when nothing matches. */
  text(selector: string): string;
  count(selector: string): number;
  click(selector: string): void;
  type(selector: string, value: string): void;
  /** Wait until `predicate` holds, failing with `what` after the timeout. */
  until(what: string, predicate: () => boolean): Promise<void>;
  /** Wait until no request is in flight and none started for a few ticks. */
  settle(): Promise<void>;
  /**
   * The page URL of the current history entry when it holds a plain page,
   * else `null`. The client writes history after it swaps the page (after
   * encrypting the previous entry, for `encryptHistory`), so a scenario waits
   * for this before it navigates back.
   */
  historyUrl(): string | null;
  snapshot(label: string): void;
  /** The request log from entry `from` on. */
  requests(from?: number): RequestRecord[];
  record(): SessionRecord;
  close(): Promise<void>;
}

const UNTIL_TIMEOUT_MS = 4000;
const POLL_MS = 5;

/** Open a session of `flavor`; `ssr` turns on server-side rendering. */
export async function openSession(
  flavor: ClientFlavor,
  options: { readonly ssr?: InertiaSsr } = {},
): Promise<Session> {
  const demo = createDemoServer(options);
  const server = await startAppServer(demo.routes);
  const consoleOutput: string[] = [];
  const restoreConsole = captureConsole(consoleOutput);
  const browser = openBrowser(server.origin);
  const client = await loadClient(flavor);
  const demoClient = createDemoClient(client);
  const { pages, layoutFor } = demoClient;
  const { window } = browser;
  const trace: Snapshot[] = [];
  const events: (readonly [string, unknown])[] = [];

  const element = (selector: string) => {
    const found = window.document.querySelector(selector);
    if (found === null) throw new Error(`no element matches ${selector}`);
    return found;
  };

  const session: Session = {
    flavor,
    demo,
    server,
    browser,
    client,
    demoClient,
    events,
    async boot(path) {
      await browser.open(path);
      await session.start();
    },
    async start() {
      client.inertia.router.on('flash', (event) => events.push(['flash', event.detail.flash]));
      window.document.addEventListener('inertia:location', (event) => {
        const detail: unknown = Reflect.get(event, 'detail');
        const url = String(Reflect.get(Object(detail), 'url'));
        events.push([
          'location',
          {
            url: url.startsWith(`${server.origin}/`) ? url.slice(server.origin.length) : url,
            versionChange: Reflect.get(Object(detail), 'versionChange'),
          },
        ]);
      });
      await client.inertia.createInertiaApp({
        resolve: (name: string) => pages[name],
        layout: layoutFor,
        progress: false,
      });
    },
    text: (selector) => window.document.querySelector(selector)?.textContent ?? '',
    count: (selector) => window.document.querySelectorAll(selector).length,
    click(selector) {
      const target = element(selector);
      if (!(target instanceof window.HTMLElement)) throw new Error(`${selector} is not clickable`);
      target.click();
    },
    type(selector, value) {
      const input = element(selector);
      if (!(input instanceof window.HTMLInputElement)) throw new Error(`${selector} is no input`);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      setter?.set?.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    async until(what, predicate) {
      const deadline = Date.now() + UNTIL_TIMEOUT_MS;
      while (!predicate()) {
        if (Date.now() > deadline) {
          const root = window.document.getElementById('app')?.innerHTML ?? '';
          throw new Error(`timed out waiting for ${what}; #app: ${root}`);
        }
        await delay(POLL_MS);
      }
    },
    async settle() {
      let quiet = 0;
      let seen = server.log.length;
      while (quiet < 4) {
        await delay(10);
        const idle = server.pending() === 0 && server.log.length === seen;
        quiet = idle ? quiet + 1 : 0;
        seen = server.log.length;
      }
    },
    historyUrl() {
      const page: unknown = Reflect.get(Object(window.history.state), 'page');
      const url: unknown = Reflect.get(Object(page), 'url');
      return typeof url === 'string' ? url : null;
    },
    snapshot(label) {
      const root = window.document.getElementById('app');
      trace.push({
        label,
        html: root === null ? '' : serialize(window, root),
        url: `${window.location.pathname}${window.location.search}`,
        historyLength: window.history.length,
      });
    },
    requests: (from = 0) => server.log.slice(from).map((entry) => ({ ...entry })),
    record: () => ({
      trace: [...trace],
      requests: server.log.map((entry) => ({ ...entry })),
      events: [...events],
    }),
    async close() {
      await session.settle();
      await browser.close();
      await server.close();
      restoreConsole();
      assert.deepEqual(browser.errors, [], 'the page raised errors');
      assert.deepEqual(consoleOutput, [], 'the session wrote to console.error or console.warn');
    },
  };
  return session;
}

/** The subtree as markup with each element's attributes sorted by name. */
function serialize(window: Window, node: Node): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) {
    if (child instanceof window.Element) {
      const tag = child.localName;
      const pairs = Array.from(child.attributes)
        .filter(({ name }) => !(child instanceof window.HTMLInputElement && name === 'value'))
        .map(({ name, value }) => `${name}="${value}"`);
      if (child instanceof window.HTMLInputElement) pairs.push(`.value="${child.value}"`);
      pairs.sort();
      out += `<${[tag, ...pairs].join(' ')}>${serialize(window, child)}</${tag}>`;
    } else if (child instanceof window.Text) {
      out += child.textContent;
    }
  }
  return out;
}

function captureConsole(output: string[]): () => void {
  const { error, warn } = console;
  console.error = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  return () => {
    console.error = error;
    console.warn = warn;
  };
}
