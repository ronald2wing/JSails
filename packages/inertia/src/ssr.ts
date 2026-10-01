/**
 * Server-side rendering gateways and the render policy.
 *
 * An {@link InertiaSsr} gateway turns a page object into `{ head, body }`:
 * `head` holds the `<Head>` elements as HTML strings, and `body` holds the
 * page data block and the server-rendered root element, which the document
 * puts in place of the client-only data block and empty root.
 *
 * - {@link inProcessSsr} runs the app's server render function in this
 *   process. It takes exactly what `createInertiaApp` returns in server mode
 *   (`(page, renderToString) => Promise<{ head, body }>`, @inertiajs/react
 *   3.11.0 `dist/index.js` 262-291) and supplies preact-render-to-string, for
 *   apps whose React imports resolve to `preact/compat`. The page it passes is
 *   the one the browser will parse, read back through the serializer (dates as
 *   ISO strings, big integers revived), so server and client render the same
 *   data.
 * - {@link httpSsr} posts the page to an external render server's `/render`
 *   endpoint, the official contract (@inertiajs/core 3.11.0 `dist/server.js`):
 *   `200` with `{ head, body }`, or `500` with a classified error.
 *
 * The policy ({@link renderSsr}) bounds every render by a timeout (2000 ms by
 * default) and the request's abort signal, and on failure either falls back to
 * client-side rendering and reports (`fallback`) or throws (`throw`, the
 * default under `NODE_ENV=test`). The bound applies to asynchronous work only:
 * in-process rendering shares the request's thread, so a synchronous render
 * that loops cannot be preempted by any timer. `httpSsr` is the isolation
 * option for renders that must be bounded absolutely.
 */

import type { VNode } from 'preact';
import { renderToString } from 'preact-render-to-string';

import { InertiaError } from './inertia-error.js';
import type { InertiaPageObject } from './page.js';
import { isPlainObject } from './plain-data.js';
import { BIGINT_MARKER, serializePage } from './serialize-page.js';

/** What a render produces: `<Head>` elements and the body markup. */
export interface InertiaSsrResult {
  readonly head: readonly string[];
  readonly body: string;
}

/** Renders a page on the server. */
export interface InertiaSsr {
  render(
    page: InertiaPageObject,
    init: { readonly signal: AbortSignal },
  ): Promise<InertiaSsrResult>;
}

/**
 * The page an SSR app receives: the page object as the browser parses it.
 * Typed loosely enough that @inertiajs/core's `Page` (whose `version` is
 * `string | null`) satisfies it; the engine always sends a string.
 */
export interface InertiaSsrPage {
  readonly component: string;
  readonly props: object;
  readonly url: string;
  readonly version: string | null;
}

/**
 * The server render function `createInertiaApp` returns in server mode.
 *
 * Declared as a method so its page parameter compares bivariantly: the
 * upstream function is typed with @inertiajs/core's `Page`, which this
 * package does not depend on. `renderToString` accepts any value and rejects
 * one that is not an element at run time.
 */
export type InertiaSsrApp = {
  render(
    page: InertiaSsrPage,
    renderToString: (element: unknown) => string,
  ): InertiaSsrResult | Promise<InertiaSsrResult>;
}['render'];

/** SSR configuration. */
export interface InertiaSsrOptions {
  readonly gateway: InertiaSsr;
  /** The render budget in milliseconds, 1 to 60000. Defaults to 2000. */
  readonly timeoutMs?: number;
  /**
   * `fallback` sends the client-rendered document and reports the failure;
   * `throw` fails the request. Defaults to `throw` when `NODE_ENV` is
   * `test`, else `fallback`.
   */
  readonly onError?: 'fallback' | 'throw';
  /** Skip SSR for matching URLs. */
  readonly exclude?: (url: URL) => boolean;
}

/** Validated SSR configuration. */
export interface ResolvedSsr {
  readonly gateway: InertiaSsr;
  readonly timeoutMs: number;
  readonly onError: 'fallback' | 'throw';
  readonly exclude: ((url: URL) => boolean) | null;
}

/** Options for {@link httpSsr}. */
export interface HttpSsrOptions {
  /** The render server's base URL; `/render` is appended. */
  readonly url: string;
  /** A gateway-level time limit in milliseconds, in addition to the policy's. */
  readonly timeoutMs?: number;
  /** The fetch implementation; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_TIMEOUT_MS = 60_000;

/** A gateway over the app's in-process server render function. */
export function inProcessSsr(app: InertiaSsrApp): InertiaSsr {
  if (typeof app !== 'function') throw new InertiaError('invalid_options');
  return Object.freeze({
    async render(
      page: InertiaPageObject,
      init: { readonly signal: AbortSignal },
    ): Promise<InertiaSsrResult> {
      init.signal.throwIfAborted();
      return app(clientPage(page), renderElement);
    },
  });
}

/** A gateway posting to an external render server (`POST <url>/render`). */
export function httpSsr(options: HttpSsrOptions): InertiaSsr {
  if (!isPlainObject(options) || typeof options.url !== 'string') {
    throw new InertiaError('invalid_options');
  }
  const base = parseServerUrl(options.url);
  const endpoint = `${base.href.replace(/\/+$/u, '')}/render`;
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined) assertTimeout(timeoutMs);
  const fetchImpl = options.fetch ?? fetch;
  if (typeof fetchImpl !== 'function') throw new InertiaError('invalid_options');
  return Object.freeze({
    async render(
      page: InertiaPageObject,
      init: { readonly signal: AbortSignal },
    ): Promise<InertiaSsrResult> {
      const timeout = timeoutMs === undefined ? null : AbortSignal.timeout(timeoutMs);
      const signal = timeout === null ? init.signal : AbortSignal.any([init.signal, timeout]);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: serializePage(page),
          signal,
        });
      } catch (error) {
        if (timeout?.aborted === true && !init.signal.aborted) {
          throw new InertiaError('ssr_timeout', { cause: error });
        }
        throw error;
      }
      if (!response.ok) {
        throw new InertiaError('ssr_failed', { cause: await renderFailure(response) });
      }
      return checkResult(await response.json());
    },
  });
}

/** Validate SSR options once, at configuration time. */
export function resolveSsrOptions(options: InertiaSsrOptions): ResolvedSsr {
  if (!isPlainObject(options)) throw new InertiaError('invalid_options');
  const { gateway, timeoutMs, onError, exclude } = options;
  if (typeof gateway !== 'object' || gateway === null || typeof gateway.render !== 'function') {
    throw new InertiaError('invalid_options');
  }
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertTimeout(timeout);
  if (onError !== undefined && onError !== 'fallback' && onError !== 'throw') {
    throw new InertiaError('invalid_options');
  }
  if (exclude !== undefined && typeof exclude !== 'function') {
    throw new InertiaError('invalid_options');
  }
  return Object.freeze({
    gateway,
    timeoutMs: timeout,
    onError: onError ?? (process.env.NODE_ENV === 'test' ? 'throw' : 'fallback'),
    exclude: exclude ?? null,
  });
}

/**
 * Render `page` under the policy. Returns `null` when the render fell back to
 * client-side rendering (the failure went to `report`). A request abort is
 * rethrown as its own reason, never reported as an SSR failure.
 */
export async function renderSsr(
  ssr: ResolvedSsr,
  page: InertiaPageObject,
  requestSignal: AbortSignal,
  report: (error: InertiaError) => void,
): Promise<InertiaSsrResult | null> {
  requestSignal.throwIfAborted();
  const timeout = AbortSignal.timeout(ssr.timeoutMs);
  const signal = AbortSignal.any([requestSignal, timeout]);
  try {
    return checkResult(await untilAborted(ssr.gateway.render(page, { signal }), signal));
  } catch (error) {
    if (requestSignal.aborted) throw requestSignal.reason;
    const failure =
      error instanceof InertiaError && (error.code === 'ssr_failed' || error.code === 'ssr_timeout')
        ? error
        : new InertiaError(timeout.aborted ? 'ssr_timeout' : 'ssr_failed', { cause: error });
    if (ssr.onError === 'throw') throw failure;
    report(failure);
    return null;
  }
}

/** Settle with `work`, or reject as soon as `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as unknown);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as unknown);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new InertiaError('ssr_failed', { cause: error }));
      },
    );
  });
}

function checkResult(value: unknown): InertiaSsrResult {
  if (!isPlainObject(value)) throw new InertiaError('ssr_failed');
  const { head, body } = value;
  if (!Array.isArray(head) || typeof body !== 'string') throw new InertiaError('ssr_failed');
  const entries: unknown[] = head;
  if (!entries.every((entry): entry is string => typeof entry === 'string')) {
    throw new InertiaError('ssr_failed');
  }
  return Object.freeze({ head: Object.freeze([...entries]), body });
}

/** The page as the browser's `parsePage` reads it from the serialized JSON. */
function clientPage(page: InertiaPageObject): InertiaSsrPage {
  const parsed: unknown = JSON.parse(serializePage(page), (_key, value: unknown) =>
    isPlainObject(value) && typeof value[BIGINT_MARKER] === 'string'
      ? BigInt(value[BIGINT_MARKER])
      : value,
  );
  if (!isSsrPage(parsed)) throw new InertiaError('ssr_failed');
  return parsed;
}

function isSsrPage(value: unknown): value is InertiaSsrPage {
  return (
    isPlainObject(value) &&
    typeof value.component === 'string' &&
    isPlainObject(value.props) &&
    typeof value.url === 'string' &&
    (typeof value.version === 'string' || value.version === null)
  );
}

function renderElement(element: unknown): string {
  if (!isVNode(element)) throw new InertiaError('ssr_failed');
  return renderToString(element);
}

function isVNode(value: unknown): value is VNode {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

async function renderFailure(
  response: Response,
): Promise<{ readonly status: number; readonly type: string | null }> {
  let type: string | null = null;
  try {
    const body: unknown = await response.json();
    if (isPlainObject(body) && typeof body.type === 'string') type = body.type;
  } catch {
    type = null;
  }
  return Object.freeze({ status: response.status, type });
}

function parseServerUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InertiaError('invalid_options');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new InertiaError('invalid_options');
  }
  return url;
}

function assertTimeout(value: unknown): void {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new InertiaError('invalid_options');
  }
}
