/**
 * The request boundary shared by every state-carrying runtime operation.
 *
 * Authorization is default-deny: a callback allows only on an exact `true`, and
 * truthy non-booleans, throws, and rejections all deny. Update and upload
 * requests cross the same boundary in the same order — snapshot verification
 * (HMAC, expiry, subject, origin) before the component is looked up, then the
 * CSRF check, then component re-authorization against the mount-time context —
 * so {@link authorizeSnapshotRequest} owns that sequence once and each transport
 * maps its value-free failure code onto its own response shape.
 */

import type { RequestContext } from '../../contracts/http.js';
import { safeEqualStrings } from '../../security/constant-time.js';
import { isHttpOrigin } from '../../url/origin.js';
import type { ServerComponentDefinition, ServerComponentState } from '../component.js';
import { COMPONENT_CSRF_HEADER, type ComponentUpdateErrorCode } from '../protocol.js';
import { SnapshotError, type ComponentSigner, type SnapshotPayload } from '../snapshot.js';
import { reconstructContext } from './lifecycle.js';
import { ServerComponentRuntimeError } from './value-errors.js';
import type { Awaitable } from '../../contracts/awaitable.js';

/** Authorize a component callback, succeeding only on an exact `true`. */
export async function authorizeAllows(
  authorize: (context: RequestContext) => Awaitable<boolean>,
  context: RequestContext,
): Promise<boolean> {
  try {
    return (await authorize(context)) === true;
  } catch {
    return false;
  }
}

/** Authorize an action callback, succeeding only on an exact `true`. */
export async function actionAuthorizeAllows(
  authorize: (
    context: RequestContext,
    state: ServerComponentState,
    input: unknown,
  ) => Awaitable<boolean>,
  context: RequestContext,
  state: ServerComponentState,
  input: unknown,
): Promise<boolean> {
  try {
    return (await authorize(context, state, input)) === true;
  } catch {
    return false;
  }
}

/** Resolve and validate the trusted origin (explicit option, else the request URL). */
export function resolveTrustedOrigin(origin: string | undefined, context: RequestContext): string {
  const candidate = origin ?? context.url.origin;
  if (!isHttpOrigin(candidate)) {
    throw new ServerComponentRuntimeError('invalid_input', 'origin must be an http(s) origin');
  }
  return candidate;
}

/** A request that crossed the snapshot boundary. */
export interface AuthorizedSnapshotRequest {
  readonly ok: true;
  readonly snapshot: SnapshotPayload;
  readonly component: ServerComponentDefinition<any>;
  /** The CSRF token the request proved possession of. */
  readonly csrfToken: string;
  /** The mount-time context reconstructed from the signed page provenance. */
  readonly context: RequestContext;
}

/** A request rejected at the snapshot boundary, as a value-free code and message. */
export interface RejectedSnapshotRequest {
  readonly ok: false;
  readonly code: ComponentUpdateErrorCode;
  readonly message: string;
}

/**
 * Verify a snapshot-carrying request and authorize its component.
 *
 * The caller has already resolved `trustedOrigin` and checked the request
 * `Origin` against it. The CSRF token is required in all cases: a session binds
 * to its own CSRF token, while an anonymous public component binds to the
 * verified snapshot id (a possession token, not an authentication identity).
 */
export async function authorizeSnapshotRequest(input: {
  readonly token: string;
  readonly request: Request;
  readonly context: RequestContext;
  readonly trustedOrigin: string;
  readonly components: ReadonlyMap<string, ServerComponentDefinition<any>>;
  readonly signer: ComponentSigner;
}): Promise<AuthorizedSnapshotRequest | RejectedSnapshotRequest> {
  const { context, signer, trustedOrigin } = input;
  let snapshot: SnapshotPayload;
  try {
    const subject = signer.subjectFor(context.session?.id ?? null);
    snapshot = signer.verify(input.token, { subject, origin: trustedOrigin });
  } catch (error) {
    if (error instanceof SnapshotError) {
      return reject('invalid_snapshot', 'Invalid component snapshot');
    }
    return reject('internal_error', 'Internal Server Error');
  }

  const component = input.components.get(snapshot.component);
  if (component === undefined) {
    return reject('unknown_component', 'Unknown component');
  }

  const csrfToken = context.session?.csrfToken ?? snapshot.id;
  const csrfHeader = input.request.headers.get(COMPONENT_CSRF_HEADER);
  if (typeof csrfHeader !== 'string' || !safeEqualStrings(csrfToken, csrfHeader)) {
    return reject('csrf_mismatch', 'CSRF token missing or mismatch');
  }

  const actionContext = reconstructContext(context, snapshot, trustedOrigin);
  if (!(await authorizeAllows(component.authorize, actionContext))) {
    return reject('forbidden', 'Forbidden');
  }
  return { ok: true, snapshot, component, csrfToken, context: actionContext };
}

function reject(code: ComponentUpdateErrorCode, message: string): RejectedSnapshotRequest {
  return { ok: false, code, message };
}
