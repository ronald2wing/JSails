/**
 * Redirect helpers and the validation-failure answer, as outcomes.
 *
 * - `inertiaRedirect(config, facts, to)` redirects to a same-origin path only
 *   (`invalid_redirect` otherwise), so user-influenced targets can never send
 *   the browser off-site.
 * - `inertiaBack(config, facts)` returns to the same-origin `Referer`, or to
 *   the fallback (`errors.backFallback`, default `/`).
 * - `inertiaLocation(facts, url)` is the explicit full page visit, to any
 *   http(s) URL: a `409` with `X-Inertia-Location` for an Inertia request, a
 *   plain redirect otherwise.
 * - `validationFailure(config, facts, issues)` answers a failed mutation from
 *   an Inertia form: `303` back with the errors sealed in the carrier, shaped
 *   for the request's `X-Inertia-Error-Bag` now, while the header is present.
 *   It returns `null` for `GET`/`HEAD`, non-Inertia, and Precognition
 *   requests, whose failures take their usual path.
 *
 * The default status is `302` after `GET`/`HEAD` and `303` otherwise, and
 * every redirect goes through the redirect rules (`decideRedirect`), so a
 * fragment target becomes a `409` `X-Inertia-Redirect`. Flash, errors,
 * `clearHistory`, and `preserveFragment` are merged into any carrier the
 * request already holds (a redirect chain keeps what an earlier hop carried). A prefetch request never
 * writes the carrier: its response is replayed later, out of order.
 */

import { isSameOriginPath, type ValidationIssue } from 'jsails/api';

import type { CarrierContents, InertiaFlash } from './carrier.js';
import { assertFlash, isEmptyCarrier, readCarrier, writeCarrier } from './carrier.js';
import {
  controlOutcome,
  decideRedirect,
  locationTarget,
  pathAndQuery,
  sameOriginPath,
  REDIRECT_STATUSES,
} from './control.js';
import { DEFAULT_ERROR_BAG, shapeErrorBags } from './error-bags.js';
import type { InertiaErrorBags, InertiaErrors } from './error-bags.js';
import type { InertiaConfig } from './inertia-config.js';
import { InertiaError } from './inertia-error.js';
import type { InertiaControlOutcome, InertiaOutcome, InertiaRedirectOutcome } from './outcome.js';
import { isPlainObject } from './plain-data.js';
import { isPrecognitive } from './precognition.js';
import { appendVary, headerList, INERTIA_VARY } from './response-headers.js';
import { toInertiaErrors } from './validation-errors.js';
import { readInertiaVisit } from './visit.js';
import type { InertiaRequestFacts, InertiaVisit } from './visit.js';

/** Options for a redirect. */
export interface InertiaRedirectOptions {
  readonly status?: 301 | 302 | 303 | 307 | 308;
  /** Flash data for the next page render. */
  readonly flash?: InertiaFlash;
  /** Clear the client's history on the next page render (logout). */
  readonly clearHistory?: boolean;
  /**
   * Mark the next page render `preserveFragment`, so the client keeps the
   * fragment of the visit that was redirected (a form posted to
   * `/comments#new` lands on the redirect target with `#new`).
   */
  readonly preserveFragment?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Options for {@link inertiaBack}. */
export interface InertiaBackOptions extends InertiaRedirectOptions {
  /** Overrides the configured `errors.backFallback`. */
  readonly fallback?: string;
}

/** Redirect to a same-origin path. */
export async function inertiaRedirect(
  config: InertiaConfig,
  facts: InertiaRequestFacts,
  to: string,
  options: InertiaRedirectOptions = {},
): Promise<InertiaRedirectOutcome | InertiaControlOutcome> {
  return redirectTo(config, facts, sameOriginPath(to), options, undefined);
}

/** Redirect back to the same-origin `Referer`, or to the fallback. */
export async function inertiaBack(
  config: InertiaConfig,
  facts: InertiaRequestFacts,
  options: InertiaBackOptions = {},
): Promise<InertiaRedirectOutcome | InertiaControlOutcome> {
  return redirectTo(config, facts, backTarget(config, facts, options.fallback), options, undefined);
}

/** A full page visit to `url`, on any origin. */
export function inertiaLocation(
  facts: InertiaRequestFacts,
  url: string | URL,
): InertiaRedirectOutcome | InertiaControlOutcome {
  const target = locationTarget(url);
  const visit = readInertiaVisit(facts.headers);
  if (visit.isInertia) return controlOutcome('location', target);
  return plainRedirect(defaultStatus(facts), target, new Headers());
}

/**
 * Answer a failed Inertia mutation with `303` back and the errors carried, or
 * `null` when the request is not one.
 */
export async function validationFailure(
  config: InertiaConfig,
  facts: InertiaRequestFacts,
  issues: readonly ValidationIssue[],
  options: { readonly fallback?: string } = {},
): Promise<InertiaOutcome | null> {
  const visit = readInertiaVisit(facts.headers);
  const method = facts.method.toUpperCase();
  if (!visit.isInertia || method === 'GET' || method === 'HEAD' || isPrecognitive(facts.headers)) {
    return null;
  }
  if (issues.length === 0) return null;
  const bags: InertiaErrorBags = {
    [DEFAULT_ERROR_BAG]: toInertiaErrors(issues, { allMessages: config.allMessages }),
  };
  return redirectTo(
    config,
    facts,
    backTarget(config, facts, options.fallback),
    { status: 303 },
    shapeErrorBags(bags, visit.errorBag),
  );
}

async function redirectTo(
  config: InertiaConfig,
  facts: InertiaRequestFacts,
  location: string,
  options: InertiaRedirectOptions,
  errors: InertiaErrors | InertiaErrorBags | undefined,
): Promise<InertiaRedirectOutcome | InertiaControlOutcome> {
  const plainOptions: boolean = isPlainObject(options);
  if (!plainOptions) throw new InertiaError('invalid_options');
  const status = options.status ?? defaultStatus(facts);
  if (!REDIRECT_STATUSES.has(status)) throw new InertiaError('invalid_options');
  for (const flag of [options.clearHistory, options.preserveFragment]) {
    if (flag !== undefined && typeof flag !== 'boolean') throw new InertiaError('invalid_options');
  }
  const visit = readInertiaVisit(facts.headers);
  const headers = extraHeaders(options.headers);
  const cookie = await carry(config, facts, visit, {
    ...(options.flash === undefined ? {} : { flash: options.flash }),
    ...(errors === undefined ? {} : { errors }),
    ...(options.clearHistory === true ? { clearHistory: true as const } : {}),
    ...(options.preserveFragment === true ? { preserveFragment: true as const } : {}),
  });
  if (cookie !== null) {
    headers.append('set-cookie', cookie);
    headers.set('cache-control', 'private, no-store');
  }
  const decision = decideRedirect(facts, visit, status, location);
  if (decision.kind === 'control') {
    return controlOutcome(decision.control, decision.target, { extra: headers });
  }
  return plainRedirect(decision.status, decision.location, headers);
}

function plainRedirect(status: number, location: string, headers: Headers): InertiaRedirectOutcome {
  headers.set('location', location);
  appendVary(headers, INERTIA_VARY);
  return Object.freeze({
    kind: 'redirect',
    location,
    status,
    headers: headerList(headers),
    body: null,
  });
}

/** Seal what the next page should see into the carrier, merged over what it holds. */
async function carry(
  config: InertiaConfig,
  facts: InertiaRequestFacts,
  visit: InertiaVisit,
  additions: CarrierContents,
): Promise<string | null> {
  if (additions.flash !== undefined) assertFlash(additions.flash);
  if (isEmptyCarrier(additions)) return null;
  const carrier = config.carrier;
  if (carrier === null) throw new InertiaError('invalid_options');
  if (visit.prefetch) return null;
  const now = config.now();
  const existing = (await readCarrier(carrier, facts, now)).contents ?? {};
  const flash =
    existing.flash === undefined && additions.flash === undefined
      ? undefined
      : { ...existing.flash, ...additions.flash };
  const errors = additions.errors ?? existing.errors;
  const merged: CarrierContents = {
    ...(flash === undefined ? {} : { flash }),
    ...(errors === undefined ? {} : { errors }),
    ...(existing.clearHistory === true || additions.clearHistory === true
      ? { clearHistory: true as const }
      : {}),
    ...(existing.preserveFragment === true || additions.preserveFragment === true
      ? { preserveFragment: true as const }
      : {}),
  };
  return writeCarrier(carrier, facts, merged, now + carrier.maxAgeSeconds * 1000, now, (error) =>
    config.report(error, 'carrier'),
  );
}

function backTarget(
  config: InertiaConfig,
  facts: InertiaRequestFacts,
  fallback: string | undefined,
): string {
  const referer = facts.headers.get('referer');
  if (referer !== null && URL.canParse(referer)) {
    const url = new URL(referer);
    const path = pathAndQuery(url);
    if (url.origin === facts.url.origin && isSameOriginPath(path)) return path;
  }
  return fallback === undefined ? config.backFallback : sameOriginPath(fallback);
}

function defaultStatus(facts: InertiaRequestFacts): 302 | 303 {
  const method = facts.method.toUpperCase();
  return method === 'GET' || method === 'HEAD' ? 302 : 303;
}

function extraHeaders(extra: Readonly<Record<string, string>> | undefined): Headers {
  if (extra !== undefined && !isPlainObject(extra)) throw new InertiaError('invalid_options');
  try {
    return new Headers(extra);
  } catch (error) {
    throw new InertiaError('invalid_options', { cause: error });
  }
}
