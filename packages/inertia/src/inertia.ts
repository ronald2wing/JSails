/**
 * Minimal Inertia-style page adapter.
 *
 * Constructs the Inertia page-object protocol `{ component, props, url, version }`
 * so a JSails handler can return it, and `renderInertiaPage` responds with JSON
 * (for `X-Inertia` / XHR requests) or a minimal HTML document that embeds the
 * page object in a `data-page` attribute on a `<div id="app">` element.
 *
 * No Inertia client-side router, no view layer, no framework integration
 * beyond the request/response boundary: the caller owns the frontend adapter
 * and component resolution.
 *
 * ## Page object
 *
 * The page object mirrors the standard Inertia protocol:
 *
 *   { component: string, props: Record<string, unknown>, url: string, version: string | null }
 *
 * `createInertiaPage` validates the input and rejects a missing `component` or
 * `url` with a value-free `TypeError`. `props` defaults to `{}`.
 *
 * ## Response
 *
 * - When the incoming `Request` carries an `X-Inertia` header, the response is
 *   `application/json` with an `X-Inertia: true` response header and a
 *   200/303 status per Inertia conventions.
 * - For a full page load, the response is `text/html; charset=utf-8` with the
 *   JSON page object embedded in `<div id="app" data-page="...">`. The JSON is
 *   HTML-entity-escaped so it never breaks the attribute boundary. The HTML
 *   shell is minimal and can be overridden via the `shell` option.
 *
 * ## Version
 *
 * `inertiaVersion(assets)` computes a deterministic version from an asset map
 * (`Record<string, string>`). Keys are sorted, values are concatenated, and the
 * result is hashed with SHA-256 (truncated to 8 hex chars to keep it short).
 *
 * ## Partial reloads
 *
 * `X-Inertia-Partial-Data` and `X-Inertia-Partial-Except` are attacker-supplied
 * dot-paths. Every segment is checked against the forbidden-key set before it
 * is used to read or build an object, so a header such as `__proto__.polluted`
 * can neither reach `Object.prototype` nor create a `__proto__` own key on the
 * reshaped props.
 */

import { isForbiddenKey, isRecord, valueAtPath } from 'jsails/plugin-sdk';
import { Str } from 'jsails/support';
import { hashSync } from 'jsails/support/server';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An Inertia page object as defined by the protocol. */
export interface InertiaPage {
  readonly component: string;
  readonly props: Record<string, unknown>;
  readonly url: string;
  readonly version: string | null;
  /** Transient flash data (e.g. notice after a redirect). */
  readonly flash?: Readonly<Record<string, unknown>>;
}

/** Options accepted by {@link createInertiaPage}. */
export interface CreateInertiaPageOptions {
  readonly component: string;
  readonly props?: Record<string, unknown>;
  readonly url: string;
  readonly version?: string | null;
  /** Transient flash data included on the page. Omitted from the object when absent. */
  readonly flash?: Readonly<Record<string, unknown>>;
}

/** Options accepted by {@link renderInertiaPage}. */
export interface RenderInertiaPageOptions {
  /** The incoming `Request` whose headers determine JSON vs HTML branch. */
  readonly request: Request;
  /**
   * HTML shell wrapping the `data-page` element.
   * Must include the string `{{page}}` exactly once, which is replaced by the
   * `<div id="app" data-page="..."></div>` tag.
   *
   * @default
   * `'<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body>{{page}}</body></html>'`
   */
  readonly shell?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a validated Inertia page object.
 *
 * Rejects with a value-free `TypeError` when `component` or `url` is missing
 * or empty. `props` defaults to `{}`; `version` defaults to `null`.
 */
export function createInertiaPage(options: CreateInertiaPageOptions): InertiaPage {
  if (!options.component) {
    throw new TypeError('an Inertia page requires a non-empty "component"');
  }
  if (!options.url) {
    throw new TypeError('an Inertia page requires a non-empty "url"');
  }
  const base: InertiaPage = {
    component: options.component,
    props: options.props ?? {},
    url: options.url,
    version: options.version ?? null,
  };
  if (options.flash !== undefined) {
    return { ...base, flash: options.flash };
  }
  return base;
}

/**
 * Render an Inertia page object into an HTTP {@link Response}.
 *
 * When the incoming request carries an `X-Inertia` header, the response is
 * `application/json` with the full page object and an `X-Inertia: true`
 * response header. Otherwise a minimal HTML document is returned with the
 * page object embedded in `<div id="app" data-page="...">`.
 *
 * The `shell` option replaces the default HTML wrapper. It must contain the
 * placeholder `{{page}}` exactly once.
 */
export function renderInertiaPage(page: InertiaPage, options: RenderInertiaPageOptions): Response {
  const isInertia = options.request.headers.get('X-Inertia') !== null;

  if (isInertia) {
    const body = JSON.stringify(page);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Vary: 'X-Inertia',
        'X-Inertia': 'true',
      },
    });
  }

  const escaped = Str.escapeHtml(JSON.stringify(page));
  const appDiv = `<div id="app" data-page="${escaped}"></div>`;

  const shell = options.shell ?? DEFAULT_HTML_SHELL;
  if (!shell.includes('{{page}}')) {
    throw new TypeError('the shell must include the "{{page}}" placeholder');
  }
  const html = shell.replace('{{page}}', appDiv);

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

/** Default HTML shell replaced by {@link RenderInertiaPageOptions.shell}. */
const DEFAULT_HTML_SHELL =
  '<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body>{{page}}</body></html>';

/**
 * Compute a deterministic version string from an asset map.
 *
 * Keys are sorted, each value is appended, and the concatenated string is
 * hashed with SHA-256. The first 8 hex chars of the digest are returned.
 * An `undefined` value or an empty map returns `null`.
 *
 * @example
 * inertiaVersion({ 'app.js': 'abc123', 'app.css': 'def456' })
 * // => e.g. "1a2b3c4d"
 */
export function inertiaVersion(assets: Record<string, string> | undefined): string | null {
  if (!assets) return null;

  const keys = Object.keys(assets);
  if (keys.length === 0) return null;

  keys.sort();
  const source = keys.map((key) => assets[key] ?? '').join('');
  return hashSync('SHA-256', source).slice(0, 8);
}

// ---------------------------------------------------------------------------
// Partial reloads — header parsing (pure; response reshaping is caller-owned)
// ---------------------------------------------------------------------------

/**
 * Filter page props for a partial Inertia reload.
 *
 * Reads the standard Inertia partial-reload headers from the incoming request:
 * - `X-Inertia-Partial-Data` — comma-separated dot-path keys to **keep**
 * - `X-Inertia-Partial-Except` — comma-separated dot-path keys to **drop**
 *
 * `only` (Partial-Data) takes precedence over `except`. When neither header is
 * present the full `page.props` is returned unchanged.
 *
 * Dot-paths support one or more levels of navigation: `"user.name"` selects the
 * nested key. Missing intermediate ancestors produce `undefined` for that path.
 * A path containing a forbidden segment (`__proto__`, `constructor`,
 * `prototype`) is ignored: it can never name a legitimate prop, and honoring
 * it would let the header reach `Object.prototype`.
 *
 * The returned object is always a **new** object; `page.props` is never mutated.
 *
 * @example
 * // Keep only title and user.name:
 * resolveInertiaProps(page, request)
 * // => { title: 'Hello', user: { name: 'Alice' } }
 */
export function resolveInertiaProps(page: InertiaPage, request: Request): Record<string, unknown> {
  const onlyHeader = request.headers.get('X-Inertia-Partial-Data');
  const exceptHeader = request.headers.get('X-Inertia-Partial-Except');

  if (onlyHeader !== null) {
    return pickPaths(page.props, parsePathList(onlyHeader));
  }

  if (exceptHeader !== null) {
    return dropPaths(page.props, parsePathList(exceptHeader));
  }

  return page.props;
}

// ---------------------------------------------------------------------------
// Shared props
// ---------------------------------------------------------------------------

/**
 * Merge a shared props object into a page so it is available to every page
 * response without duplicating common data in every handler.
 *
 * Page-level props win over shared (page `props` are spread last).
 * Returns a new `InertiaPage`; the original page is unchanged.
 *
 * `shared` must be a plain object — arrays and `null` are rejected with a
 * value-free `TypeError`.
 */
export function mergeSharedProps(page: InertiaPage, shared: Record<string, unknown>): InertiaPage {
  if (!isRecord(shared)) {
    throw new TypeError('shared props must be a plain object');
  }

  return {
    ...page,
    props: { ...shared, ...page.props },
  };
}

// ---------------------------------------------------------------------------
// Deferred props
// ---------------------------------------------------------------------------

/**
 * A deferred prop: a lazy resolver paired with an optional group name.
 *
 * Inertia's `@defer` directive marks a prop whose value is resolved after the
 * initial page load. The server renders a placeholder; the client fetches the
 * deferred values in a separate request. This interface captures the
 * **server-side** half — a named resolver that produces the final value when
 * called.
 *
 * Props in the same `group` are resolved together; props without an explicit
 * group belong to the default `'default'` group. The caller owns error
 * handling: a throwing resolver (sync or async) propagates to
 * {@link resolveDeferredProps}.
 */
export interface DeferredProp {
  readonly group?: string;
  /** May return a value or a Promise. {@link resolveDeferredProps} awaits both. */
  readonly resolve: (context: unknown) => unknown;
}

/**
 * Resolve every deferred prop into a flat map of resolved values.
 *
 * Each prop's `resolve(context)` is called; sync values are awaited through
 * `Promise.resolve()` so the returned map is uniformly async-safe.
 *
 * Props are grouped by `DeferredProp.group` (defaults to `'default'`) for the
 * caller's benefit, but resolution is fully parallel — every resolver fires at
 * once. The group metadata exists so the caller can batch responses to the
 * client by group if desired.
 *
 * Errors propagate unwrapped: a throwing resolver rejects the returned promise
 * directly, so the caller controls the failure surface. No values are echoed
 * in error messages.
 */
export async function resolveDeferredProps(
  deferred: Readonly<Record<string, DeferredProp>>,
  context: unknown,
): Promise<Readonly<Record<string, unknown>>> {
  const results: Record<string, unknown> = {};

  const promises = Object.entries(deferred).map(([key, def]) =>
    Promise.resolve(def.resolve(context)).then((value) => {
      results[key] = value;
    }),
  );

  await Promise.all(promises);
  return results;
}

// ---------------------------------------------------------------------------
// Error bags
// ---------------------------------------------------------------------------

/**
 * Read the Inertia error-bag header from a request.
 *
 * Returns `undefined` when the `X-Inertia-Error-Bag` header is absent or
 * yields an empty string after trimming. The returned value is caller-owned
 * and is never echoed in error messages.
 */
export function resolveErrorBag(request: Request): string | undefined {
  const header = request.headers.get('X-Inertia-Error-Bag');
  if (header === null) return undefined;
  const trimmed = header.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Scope server-side errors to a specific error bag.
 *
 * When `bag` is `undefined` or empty the full `errors` object is returned.
 * Otherwise the error bag's own nested entry is returned (`errors[bag]`),
 * defaulting to `{}` when the bag key is missing or not an object.
 */
export function errorsFor(
  errors: Record<string, unknown>,
  bag: string | undefined,
): Record<string, unknown> {
  if (!bag) return errors;

  const bagErrors = errors[bag];
  return isRecord(bagErrors) ? bagErrors : {};
}

// ---------------------------------------------------------------------------
// Dot-path helpers (module-private)
// ---------------------------------------------------------------------------

/** A parsed dot-path whose every segment has passed the forbidden-key check. */
type PropPath = readonly string[];

/**
 * Split a comma-separated header value into trimmed, non-empty dot-paths,
 * dropping any path with a forbidden segment before it can be walked.
 */
function parsePathList(header: string): PropPath[] {
  const paths: PropPath[] = [];
  for (const entry of header.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const segments = trimmed.split('.');
    if (segments.some((segment) => isForbiddenKey(segment))) continue;
    paths.push(segments);
  }
  return paths;
}

/** Build a new object containing only the listed paths from `source`. */
function pickPaths(
  source: Record<string, unknown>,
  paths: readonly PropPath[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const path of paths) {
    assignAtPath(result, path, valueAtPath(source, path));
  }
  return result;
}

/**
 * Write `value` into `target` at `path`, creating missing ancestors as plain
 * `{}`. The segments were vetted by {@link parsePathList}, so no write can
 * land on `__proto__`, `constructor`, or `prototype`.
 */
function assignAtPath(target: Record<string, unknown>, path: PropPath, value: unknown): void {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    if (isRecord(existing)) {
      current = existing;
      continue;
    }
    const created: Record<string, unknown> = {};
    current[segment] = created;
    current = created;
  }
  const last = path[path.length - 1];
  if (last !== undefined) {
    current[last] = value;
  }
}

/** Return a shallow clone of `source` with the listed paths removed. */
function dropPaths(
  source: Record<string, unknown>,
  paths: readonly PropPath[],
): Record<string, unknown> {
  let result: Record<string, unknown> = { ...source };
  for (const path of paths) {
    result = withoutPath(result, path);
  }
  return result;
}

/** Copy `source` without `path`, cloning each ancestor along the way. */
function withoutPath(source: Record<string, unknown>, path: PropPath): Record<string, unknown> {
  const [first, ...rest] = path;
  if (first === undefined) return source;
  const copy = { ...source };
  if (rest.length === 0) {
    delete copy[first];
    return copy;
  }
  const child = copy[first];
  if (isRecord(child)) {
    copy[first] = withoutPath(child, rest);
  }
  return copy;
}
