/**
 * The access chain: the one decision every route surface's request passes
 * before any of the route's own code runs.
 *
 * The route boundary (`server/route-boundary.ts`) calls it for every route,
 * after the stages that come first in a fixed order: the request frame
 * resolved the origin and the client first (a host the app does not serve
 * was answered 421), the rate-limit hook then answers for the client
 * address, and the claim
 * authenticates (the identity source) and resolves the request scopes. The
 * identity the chain decides with is the one the surface's credentials accept
 * (`credentials.ts`): a cookie session on a surface that leaves out `cookie`
 * is anonymous there, so a surface the cross-site check skips never acts on
 * the visitor's cookie. Then {@link runAccessChain}:
 *
 * 1. the cross-site check (`origin-check.ts`): an unsafe request to a surface
 *    accepting cookies must name the origin it was addressed to, for every
 *    caller, anonymous included (a hostile page could otherwise sign a visitor
 *    in to its own account); a request whose identity came from a header
 *    credential is exempt, since no cross-site page can send one;
 * 2. the gate: a public surface admits everyone; a legacy check admits only
 *    when it resolves to exactly `true` for the route's request context.
 *
 * The request body is never read here: the frame's body budget reads it
 * lazily, counted against the surface's limit, so a denied request costs no
 * body bytes. A denial carries the failure the boundary renders: a gate
 * denial with no identity is `request.unauthenticated` (401), with one
 * `request.forbidden` (403); a cross-site request is `access.cross_site`
 * (403); a check that throws is a fault, `access.fault` (503), reported with
 * phase `authorize`, never a silent deny. The chain records each denial
 * and each admission on the frame (`access-record.ts`): the response
 * finalizer (`server/output.ts`) sends a denial `private, no-store` and
 * without `Set-Cookie`, whatever a renderer or a response transform put on
 * it, and shares an admitted answer only when `isPubliclyCacheable`
 * says so (a public surface, an anonymous caller).
 */

import { accessCheck } from '../api/access-ref.js';
import { toFailure } from '../api/error-response.js';
import type { Failure } from '../api/failure-response.js';
import { forbidden, RequestErrors } from '../errors/kernel.js';
import type { ClaimedScope, RequestFrame, RoutedFrame } from '../server/request-frame.js';
import { AccessErrors } from './access-errors.js';
import { accessProbeOf, recordAdmission, recordDenial, type Admitted } from './access-record.js';
import { acceptedIdentity, credentialOf } from './credentials.js';
import { crossSiteVerdict, requiresOriginCheck } from './origin-check.js';
import type { SurfaceDescriptor } from './surfaces.js';

/** What the chain decided. */
export type AccessOutcome =
  | { readonly kind: 'admitted'; readonly admitted: Admitted }
  | { readonly kind: 'denied'; readonly failure: Failure };

/**
 * Decide `routed`'s request for `surface`, after its claim settled as
 * `claimed`. Never throws: a failing check is a `denied` fault.
 */
export async function runAccessChain(
  surface: SurfaceDescriptor,
  routed: RoutedFrame,
  claimed: ClaimedScope,
): Promise<AccessOutcome> {
  const frame = routed.frame;
  const identity = acceptedIdentity(claimed.identity, surface.credentials);
  if (
    requiresOriginCheck(routed.request.method, surface.credentials) &&
    (identity === null || credentialOf(identity) === 'cookie') &&
    crossSiteVerdict(routed.request, frame.origin.origin) === 'cross-site'
  ) {
    return denied(surface, frame, toFailure(new AccessErrors.Error('cross_site')));
  }
  const verdict = await decideGate(surface, frame);
  if (verdict === 'fault') {
    return denied(surface, frame, toFailure(new AccessErrors.Error('fault')));
  }
  if (verdict === 'deny') {
    return denied(surface, frame, toFailure(identity === null ? unauthenticated() : forbidden()));
  }
  const admitted: Admitted = Object.freeze({ surface, anonymous: identity === null });
  recordAdmission(frame, admitted);
  return Object.freeze({ kind: 'admitted', admitted });
}

function denied(surface: SurfaceDescriptor, frame: RequestFrame, failure: Failure): AccessOutcome {
  recordDenial(frame);
  accessProbeOf(frame.request)?.denied(surface, failure.code);
  return Object.freeze({ kind: 'denied', failure });
}

function unauthenticated(): Error {
  return new RequestErrors.Error('unauthenticated');
}

/**
 * The gate's verdict for `surface`: a public surface allows; a
 * legacy check allows only on exactly `true`, and a throw is a reported fault.
 */
async function decideGate(
  surface: SurfaceDescriptor,
  frame: RequestFrame,
): Promise<'allow' | 'deny' | 'fault'> {
  const check = accessCheck(surface.access);
  if (check === undefined) return 'allow';
  try {
    return (await check(frame.requestContext())) === true ? 'allow' : 'deny';
  } catch (error) {
    frame.report(error, 'authorize');
    return 'fault';
  }
}
