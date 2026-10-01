/**
 * Inertia outcomes: what the engine decided to answer, as plain data.
 *
 * Every engine entry point (`resolveInertia`, the redirect helpers,
 * `validationFailure`, `precognition`, `originGuard`) returns an {@link InertiaOutcome}
 * instead of a framework response, so a request pipeline maps it onto its
 * own reply type and a test asserts on it directly. Each outcome carries its
 * final status, header pairs, and body (`null` for none, as for `HEAD`).
 * {@link outcomeToResponse} is the one web-standard mapping.
 */

import type { InertiaPageObject } from './page.js';
import type { InertiaHeaderList } from './response-headers.js';

interface OutcomeBase {
  readonly status: number;
  readonly headers: InertiaHeaderList;
  /** The response body, or `null` when there is none. */
  readonly body: string | null;
}

/** The JSON page object, answered to an Inertia visit (`X-Inertia: true`). */
export interface InertiaPageOutcome extends OutcomeBase {
  readonly kind: 'page';
  readonly page: InertiaPageObject;
}

/** The full HTML document, answered to a first (non-Inertia) visit. */
export interface InertiaDocumentOutcome extends OutcomeBase {
  readonly kind: 'document';
  readonly page: InertiaPageObject;
  /** Whether the body holds server-rendered markup from the SSR gateway. */
  readonly ssr: boolean;
}

/**
 * A `409` control response. `version` and `location` carry
 * `X-Inertia-Location` (the client makes a full page visit); `fragment`
 * carries `X-Inertia-Redirect` (the client makes a new Inertia visit). None
 * carries `X-Inertia`.
 */
export interface InertiaControlOutcome extends OutcomeBase {
  readonly kind: 'control';
  readonly status: 409;
  readonly control: 'version' | 'location' | 'fragment';
  /** The URL in the control header. */
  readonly target: string;
}

/** A plain HTTP redirect. */
export interface InertiaRedirectOutcome extends OutcomeBase {
  readonly kind: 'redirect';
  readonly location: string;
}

/** A Precognition answer: `204` when validation passed, `422` with errors otherwise. */
export interface InertiaPrecognitionOutcome extends OutcomeBase {
  readonly kind: 'precognition';
  readonly success: boolean;
}

/** A `403` from the Origin check: the request did not come from the trusted origin. */
export interface InertiaForbiddenOutcome extends OutcomeBase {
  readonly kind: 'forbidden';
  readonly status: 403;
  readonly code: 'origin_mismatch';
}

/** Everything the Inertia engine can answer. */
export type InertiaOutcome =
  | InertiaPageOutcome
  | InertiaDocumentOutcome
  | InertiaControlOutcome
  | InertiaRedirectOutcome
  | InertiaPrecognitionOutcome
  | InertiaForbiddenOutcome;

/** Map an outcome onto a web-standard `Response`. */
export function outcomeToResponse(outcome: InertiaOutcome): Response {
  const headers = new Headers();
  for (const [name, value] of outcome.headers) headers.append(name, value);
  return new Response(outcome.body, { status: outcome.status, headers });
}
