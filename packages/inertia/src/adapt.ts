/**
 * Adapt any response to an Inertia request, whatever produced it.
 *
 * Handlers outside the engine (a plain `Response.redirect`, a static HTML
 * page, an auth redirect) answer Inertia visits too, and the client turns a
 * wrong-shaped answer into its error modal. `adaptInertiaResponse` applies
 * the protocol to such a response:
 *
 * - every response gets `Vary: X-Inertia, Precognition` appended, and a
 *   response to a Precognition request gets `Precognition: true`;
 * - for an Inertia request, a redirect goes through the redirect rules
 *   (`303` after `PUT`/`PATCH`/`DELETE`/`QUERY`, off-origin to a `409`
 *   location visit, fragment to a `409` `X-Inertia-Redirect` except for
 *   prefetch);
 * - a `200` `text/html` answer without `X-Inertia` to an Inertia `GET` is a
 *   page that is not an Inertia page, so it becomes a `409` location visit to
 *   the request path and query and the browser loads it in full.
 *
 * Headers are copied, never mutated, so responses with immutable headers
 * (`Response.redirect`, `fetch` results) are handled. Cookies the handler set
 * are kept on a `409`, and the replaced body is cancelled unless something
 * already holds a reader on it; a failed cancel is not the caller's problem.
 * A network-error or opaque response (status `0`) cannot be rebuilt and
 * carries nothing to adapt, so it is returned as it is. Applying it twice
 * changes nothing more.
 */

import { controlOutcome, decideRedirect, pathAndQuery, REDIRECT_STATUSES } from './control.js';
import { outcomeToResponse } from './outcome.js';
import type { InertiaControlOutcome } from './outcome.js';
import { isPrecognitive, PRECOGNITION_HEADERS } from './precognition.js';
import { appendVary, INERTIA_VARY } from './response-headers.js';
import { readInertiaVisit } from './visit.js';
import type { InertiaRequestFacts } from './visit.js';

/** Apply the Inertia response rules to a response answering `facts`. */
export function adaptInertiaResponse(facts: InertiaRequestFacts, response: Response): Response {
  if (response.status === 0) return response;
  const visit = readInertiaVisit(facts.headers);
  const headers = new Headers(response.headers);
  appendVary(headers, INERTIA_VARY);
  if (isPrecognitive(facts.headers)) headers.set(PRECOGNITION_HEADERS.precognition, 'true');

  if (visit.isInertia) {
    const location = headers.get('location');
    if (REDIRECT_STATUSES.has(response.status) && location !== null) {
      const decision = decideRedirect(facts, visit, response.status, location);
      if (decision.kind === 'control') {
        return replaceWithControl(
          response,
          controlOutcome(decision.control, decision.target, { extra: headers }),
        );
      }
      return rebuild(response, decision.status, headers);
    }
    if (isForeignPage(facts, response, headers)) {
      return replaceWithControl(
        response,
        controlOutcome('location', pathAndQuery(facts.url), { extra: headers }),
      );
    }
  }
  return rebuild(response, response.status, headers);
}

function isForeignPage(facts: InertiaRequestFacts, response: Response, headers: Headers): boolean {
  return (
    facts.method.toUpperCase() === 'GET' &&
    response.status === 200 &&
    !headers.has('x-inertia') &&
    (headers.get('content-type') ?? '').trim().toLowerCase().startsWith('text/html')
  );
}

function replaceWithControl(response: Response, control: InertiaControlOutcome): Response {
  const body = response.body;
  // A locked stream belongs to whoever holds its reader; cancelling it would
  // reject. A cancel that fails anyway (a throwing source) must not surface as
  // an unhandled rejection, so its rejection is dropped.
  if (body !== null && !body.locked) body.cancel().catch(() => undefined);
  return outcomeToResponse(control);
}

function rebuild(response: Response, status: number, headers: Headers): Response {
  return new Response(response.body, {
    status,
    ...(status === response.status ? { statusText: response.statusText } : {}),
    headers,
  });
}
