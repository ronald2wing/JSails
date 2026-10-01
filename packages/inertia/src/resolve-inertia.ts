/**
 * The render entry point: answer one request for one component.
 *
 * `resolveInertia(config, facts, spec)` returns a plain-data outcome:
 *
 * 1. Version guard (v3 Asset Versioning). An Inertia `GET` or `HEAD` whose
 *    `X-Inertia-Version` (`''` when absent, the reference comparison) differs
 *    from the current version gets a `409` with `X-Inertia-Location` set to the
 *    request path and query and `X-Inertia-Version` set to the new version,
 *    before any prop resolves and without touching the carrier, so flash
 *    survives the reload. The protocol names the full URL; the path is used so
 *    a proxy-derived origin can never send the client elsewhere, and the
 *    client resolves it against its own location.
 * 2. Carrier. Carried errors are consumed by any page render, partial reloads
 *    included, because `errors` is always sent. Carried flash,
 *    `clearHistory`, and `preserveFragment` are consumed only by a
 *    non-partial render: the client
 *    ignores flash on deferred-props requests, and a poll could otherwise eat
 *    it. A partial render that consumed errors re-seals the rest. A prefetch
 *    neither reads nor consumes the carrier and gets no flash, because the
 *    client replays a prefetched response later as the real visit. `HEAD`
 *    consumes nothing.
 * 3. Props, page, and representation: the JSON page with `X-Inertia: true`
 *    for an Inertia visit, else the HTML document, server-rendered when an SSR
 *    gateway is configured and the render does not opt out.
 *
 * Every answer appends `Vary: X-Inertia, Precognition`. Pages are
 * `Cache-Control: private`, and `private, no-store` when the request carried
 * partial, once, reset, or error-bag headers or the response sets the
 * carrier cookie. `HEAD` gets the `GET` status and headers with no body.
 */

import type { CarrierContents, CarrierRead, InertiaFlash } from './carrier.js';
import { assertFlash, clearCarrier, isEmptyCarrier, readCarrier, writeCarrier } from './carrier.js';
import { buildInertiaPage } from './build-page.js';
import { controlOutcome, pathAndQuery } from './control.js';
import { buildDocument } from './document.js';
import { currentVersion } from './inertia-config.js';
import type { InertiaConfig } from './inertia-config.js';
import { InertiaError } from './inertia-error.js';
import type { InertiaControlOutcome, InertiaOutcome } from './outcome.js';
import { assertComponent } from './page.js';
import type { InertiaPageObject } from './page.js';
import { partialSelection } from './partial-reload.js';
import { isPlainObject } from './plain-data.js';
import type { InertiaPropContext } from './props.js';
import type { PropsTree } from './resolve-props.js';
import { appendVary, headerList, INERTIA_VARY } from './response-headers.js';
import { serializePage } from './serialize-page.js';
import { renderSsr } from './ssr.js';
import { readInertiaVisit } from './visit.js';
import type { InertiaRequestFacts, InertiaVisit } from './visit.js';

/** What to render for one request. */
export interface InertiaRenderSpec {
  readonly component: string;
  readonly props: PropsTree;
  /** The response status: 2xx, or 4xx/5xx for an error page. Defaults to 200. */
  readonly status?: number;
  /** Extra response headers; Inertia's own headers take precedence. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Flash data for this response, merged over carried flash. */
  readonly flash?: InertiaFlash;
  /** Overrides the configured `encryptHistory`. */
  readonly encryptHistory?: boolean;
  readonly clearHistory?: boolean;
  readonly preserveFragment?: boolean;
  /** `false` skips server-side rendering for this response. */
  readonly ssr?: boolean;
}

const EMPTY_READ: CarrierRead = Object.freeze({ present: false, contents: null, expiresAt: null });

/**
 * The version-guard outcome for a request, or `null` when it passes. Run it
 * before handler work that a `409` would waste; `resolveInertia` runs it too.
 */
export function versionGuard(
  config: InertiaConfig,
  facts: InertiaRequestFacts,
): InertiaControlOutcome | null {
  return guard(config, facts, readInertiaVisit(facts.headers));
}

/** Resolve the props and answer one request with a page, document, or `409`. */
export async function resolveInertia(
  config: InertiaConfig,
  facts: InertiaRequestFacts,
  spec: InertiaRenderSpec,
): Promise<InertiaOutcome> {
  assertSpec(spec);
  const visit = readInertiaVisit(facts.headers);
  const guarded = guard(config, facts, visit);
  if (guarded !== null) return guarded;

  const isHead = facts.method.toUpperCase() === 'HEAD';
  const now = config.now();
  const carried =
    config.carrier === null || visit.prefetch || isHead
      ? EMPTY_READ
      : await readCarrier(config.carrier, facts, now);
  const partial = partialSelection(visit, spec.component) !== null;
  const contents: CarrierContents = carried.contents ?? {};
  const flash = visit.prefetch
    ? undefined
    : mergeFlash(partial ? undefined : contents.flash, spec.flash);

  const shared =
    config.share === null ? undefined : await config.share(shareContext(spec.component, facts));
  const encryptHistory = spec.encryptHistory ?? config.encryptHistory;
  if (encryptHistory) warnInsecureContext(config, facts);
  const page = await buildInertiaPage({
    component: spec.component,
    facts,
    visit,
    props: spec.props,
    ...(shared === undefined ? {} : { shared }),
    errors: contents.errors ?? {},
    report: (error, path) => config.report(error, 'rescued_prop', path),
    now: config.now,
    version: currentVersion(config),
    ...(flash === undefined ? {} : { flash }),
    encryptHistory,
    clearHistory: spec.clearHistory === true || (!partial && contents.clearHistory === true),
    preserveFragment:
      spec.preserveFragment === true || (!partial && contents.preserveFragment === true),
  });

  const setCookie = await consumeCarrier(config, facts, carried, partial, now);
  const headers = responseHeaders(spec.headers);
  if (setCookie !== null) headers.append('set-cookie', setCookie);
  const noStore =
    setCookie !== null ||
    visit.partial !== null ||
    visit.exceptOnce.length > 0 ||
    visit.reset.length > 0 ||
    visit.errorBag !== null;
  if (noStore) headers.set('cache-control', 'private, no-store');
  else if (!headers.has('cache-control')) headers.set('cache-control', 'private');
  appendVary(headers, INERTIA_VARY);
  const status = spec.status ?? 200;

  if (visit.isInertia) {
    headers.set('content-type', 'application/json');
    headers.set('x-inertia', 'true');
    const body = serializePage(page);
    return Object.freeze({
      kind: 'page',
      page,
      status,
      headers: headerList(headers),
      body: isHead ? null : body,
    });
  }

  headers.set('content-type', 'text/html; charset=utf-8');
  const rendered = isHead ? null : await serverRender(config, facts, spec, page);
  const nonce = config.nonce(facts);
  const html = buildDocument({
    page,
    rootId: config.rootId,
    ...(config.lang === null ? {} : { lang: config.lang }),
    assets: config.assets(facts),
    ...(nonce === undefined ? {} : { nonce }),
    ...(rendered === null ? {} : { head: rendered.head, ssrBody: rendered.body }),
  });
  return Object.freeze({
    kind: 'document',
    page,
    ssr: rendered !== null,
    status,
    headers: headerList(headers),
    body: isHead ? null : html,
  });
}

function guard(
  config: InertiaConfig,
  facts: InertiaRequestFacts,
  visit: InertiaVisit,
): InertiaControlOutcome | null {
  if (!visit.isInertia) return null;
  const method = facts.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  const version = currentVersion(config);
  if (visit.version === version) return null;
  return controlOutcome('version', pathAndQuery(facts.url), { version });
}

/**
 * The `Set-Cookie` that consumes the carrier, or `null` to leave it alone: a
 * cookie that did not open is cleared, a full render clears it, and a partial
 * render that took errors re-seals the flash and flags it left.
 */
async function consumeCarrier(
  config: InertiaConfig,
  facts: InertiaRequestFacts,
  carried: CarrierRead,
  partial: boolean,
  now: number,
): Promise<string | null> {
  const carrier = config.carrier;
  if (carrier === null || !carried.present) return null;
  const contents = carried.contents;
  if (contents === null || carried.expiresAt === null || !partial) {
    return clearCarrier(carrier, facts);
  }
  if (contents.errors === undefined) return null;
  const remaining: CarrierContents = {
    ...(contents.flash === undefined ? {} : { flash: contents.flash }),
    ...(contents.clearHistory === true ? { clearHistory: true as const } : {}),
    ...(contents.preserveFragment === true ? { preserveFragment: true as const } : {}),
  };
  if (isEmptyCarrier(remaining)) return clearCarrier(carrier, facts);
  return writeCarrier(carrier, facts, remaining, carried.expiresAt, now, (error) =>
    config.report(error, 'carrier'),
  );
}

async function serverRender(
  config: InertiaConfig,
  facts: InertiaRequestFacts,
  spec: InertiaRenderSpec,
  page: InertiaPageObject,
): Promise<{ readonly head: readonly string[]; readonly body: string } | null> {
  const ssr = config.ssr;
  if (ssr === null || spec.ssr === false) return null;
  if (ssr.exclude?.(facts.url) === true) return null;
  return renderSsr(ssr, page, facts.signal, (error) => config.report(error, 'ssr'));
}

function shareContext(component: string, facts: InertiaRequestFacts): InertiaPropContext {
  return Object.freeze({
    component,
    method: facts.method,
    url: facts.url,
    headers: facts.headers,
    signal: facts.signal,
  });
}

function mergeFlash(
  carried: InertiaFlash | undefined,
  rendered: InertiaFlash | undefined,
): InertiaFlash | undefined {
  if (carried === undefined) return rendered;
  if (rendered === undefined) return carried;
  return Object.freeze({ ...carried, ...rendered });
}

function responseHeaders(extra: Readonly<Record<string, string>> | undefined): Headers {
  try {
    return new Headers(extra);
  } catch (error) {
    throw new InertiaError('invalid_options', { cause: error });
  }
}

function assertSpec(spec: InertiaRenderSpec): void {
  if (!isPlainObject(spec)) throw new InertiaError('invalid_options');
  assertComponent(spec.component);
  const status = spec.status;
  if (
    status !== undefined &&
    (!Number.isInteger(status) ||
      !((status >= 200 && status < 300) || (status >= 400 && status < 600)))
  ) {
    throw new InertiaError('invalid_options');
  }
  if (spec.headers !== undefined && !isPlainObject(spec.headers)) {
    throw new InertiaError('invalid_options');
  }
  if (spec.flash !== undefined) assertFlash(spec.flash);
  for (const flag of [spec.encryptHistory, spec.clearHistory, spec.preserveFragment, spec.ssr]) {
    if (flag !== undefined && typeof flag !== 'boolean') throw new InertiaError('invalid_options');
  }
}

const warnedConfigs = new WeakSet<InertiaConfig>();

/** Loopback hosts browsers treat as potentially trustworthy: 127.0.0.0/8 and [::1]. */
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|\[::1\])$/u;

/**
 * `encryptHistory` needs `crypto.subtle`, which browsers expose only in a
 * secure context (https, or localhost over http). Warn once per config in
 * development when a page asks for it over plain http elsewhere.
 */
function warnInsecureContext(config: InertiaConfig, facts: InertiaRequestFacts): void {
  if (process.env.NODE_ENV === 'production' || facts.url.protocol !== 'http:') return;
  const host = facts.url.hostname;
  if (host === 'localhost' || host.endsWith('.localhost') || LOOPBACK.test(host)) return;
  if (warnedConfigs.has(config)) return;
  warnedConfigs.add(config);
  console.warn(
    '[jsails/inertia] encryptHistory needs a secure context (https or localhost); ' +
      'the browser will not be able to encrypt history over plain http',
  );
}
