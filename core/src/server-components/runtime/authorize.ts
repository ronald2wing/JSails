/**
 * Authorization evaluation for server components, shared by the mount
 * pipeline, the lane boundary, and action dispatch.
 *
 * An authorize callback has three outcomes. It allows only on an exact `true`;
 * `false` and every truthy non-boolean deny. A throw or rejection is a fault:
 * the request is still refused, but the failure is the policy's (a store that
 * is down, a bug), not the caller's, so it is answered as unavailable and
 * reported with the original error as its cause, never silently turned into a
 * deny.
 */

import type { Awaitable } from '../../contracts/awaitable.js';
import type { RequestContext } from '../../contracts/http.js';
import { defineErrors, type ErrorRegistry } from '../../errors/registry.js';
import { isHttpOrigin } from '../../url/origin.js';
import type { ComponentSigner } from '../snapshot.js';
import { ServerComponentRuntimeError } from './value-errors.js';

const COMPONENT_AUTHORIZE_ERRORS = {
  component_failed: {
    kind: 'unavailable',
    message: 'the authorize callback of server component {component} failed',
    context: { component: 'identifier' },
  },
  action_failed: {
    kind: 'unavailable',
    message: 'an action authorize callback of server component {component} failed',
    context: { component: 'identifier' },
  },
} as const;

/**
 * Authorization faults, `component_authorize.*`: an authorize callback threw
 * or rejected. The callback's error is the cause.
 *
 * @public
 */
export const ComponentAuthorizeErrors: ErrorRegistry<
  'component_authorize',
  typeof COMPONENT_AUTHORIZE_ERRORS
> = defineErrors('component_authorize', COMPONENT_AUTHORIZE_ERRORS);

/** The outcome of one authorize callback. */
export type AuthorizeOutcome =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny' }
  | { readonly kind: 'fault'; readonly error: unknown };

const ALLOW: AuthorizeOutcome = Object.freeze({ kind: 'allow' });
const DENY: AuthorizeOutcome = Object.freeze({ kind: 'deny' });

/** Run an authorize callback, allowing only on an exact `true` and capturing a throw as a fault. */
export async function evaluateAuthorize(
  authorize: () => Awaitable<unknown>,
): Promise<AuthorizeOutcome> {
  try {
    return (await authorize()) === true ? ALLOW : DENY;
  } catch (error) {
    return { kind: 'fault', error };
  }
}

/** Every subject tag a session id may carry under the signer's current and retired keys. */
export function acceptedSubjects(
  signer: ComponentSigner,
  sessionOrScopeId: string | null,
): readonly (string | null)[] {
  return signer.subjectsFor?.(sessionOrScopeId) ?? [signer.subjectFor(sessionOrScopeId)];
}

/**
 * The trusted origin of a request: the origin it was addressed to (resolved
 * by the HTTP pipeline from `server.origin` and `server.hosts`), else, for a
 * hand-built context, its URL's.
 */
export function trustedOriginOf(context: RequestContext): string {
  const candidate = context.origin?.origin ?? context.url.origin;
  if (!isHttpOrigin(candidate)) {
    throw new ServerComponentRuntimeError('invalid_input', 'origin must be an http(s) origin');
  }
  return candidate;
}
