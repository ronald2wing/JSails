/**
 * Component instance identity, author lifecycle hooks, and context
 * reconstruction for the server-component runtime.
 *
 * Every author callback is sanitized here: a hook throw never reaches the
 * client as anything but a value-free error or a 422 with field errors.
 */

import { ZodError } from 'zod';

import type { RequestContext } from '../../contracts/http.js';
import { Encoding } from '../../support/encoding.js';
import type { ServerComponentDefinition, ServerComponentState } from '../component.js';
import type { SnapshotPayload } from '../snapshot.js';
import { validationFailureResult, type ValidationFailureTarget } from './render-root.js';
import {
  ServerComponentRuntimeError,
  errorResult,
  zodIssuesToFieldErrors,
  type ServerComponentUpdateResult,
} from './value-errors.js';
import type { Awaitable } from '../../contracts/awaitable.js';

/** Random bytes minted for a new component instance (or upload) id. */
const ID_BYTES = 16;

/** Mint an unguessable base64url id for a component instance or stored upload. */
export function generateComponentId(): string {
  return Encoding.base64url(Encoding.randomBytes(ID_BYTES));
}

/** Await the optional `mount` hook, sanitizing a throw into a value-free error. */
export async function runMountHook(
  component: ServerComponentDefinition<any>,
  context: RequestContext,
): Promise<void> {
  if (component.mount === undefined) {
    return;
  }
  try {
    await component.mount(context);
  } catch {
    throw new ServerComponentRuntimeError('mount_failed', 'component mount hook failed');
  }
}

/**
 * Await an optional state lifecycle hook (`hydrate`/`updating`/`updated`),
 * converting a throw into a value-free update result. When `allowValidationReject`
 * is set, a `ZodError` becomes a 422 with field errors (the author's way to
 * reject the update before any side effect); any other throw — and every throw
 * when `allowValidationReject` is false — is a value-free 500. Returns `null`
 * when the hook is absent or ran cleanly.
 */
export async function runStateHook(
  hook: ((state: ServerComponentState, context: RequestContext) => Awaitable<void>) | undefined,
  state: ServerComponentState,
  target: ValidationFailureTarget,
  allowValidationReject: boolean,
): Promise<ServerComponentUpdateResult | null> {
  if (hook === undefined) {
    return null;
  }
  try {
    await hook(state, target.context);
    return null;
  } catch (error) {
    if (allowValidationReject && error instanceof ZodError) {
      return await validationFailureResult(target, zodIssuesToFieldErrors(error.issues, state));
    }
    return errorResult(target.sequence, 'internal_error', 'Internal Server Error');
  }
}

/** Reconstruct the mount-time request context from the signed page provenance. */
export function reconstructContext(
  context: RequestContext,
  snapshot: SnapshotPayload,
  origin: string,
): RequestContext {
  return {
    // The update request itself stays the actual POST; only url/params are
    // reconstructed from the page the component was signed on.
    request: context.request,
    url: new URL(snapshot.page.path, origin),
    params: { ...snapshot.page.params },
    session: context.session,
    ...(context.publicOrigin === undefined ? {} : { publicOrigin: context.publicOrigin }),
    ...(context.renderMode === undefined ? {} : { renderMode: context.renderMode }),
    ...(context.services === undefined ? {} : { services: context.services }),
    ...(context.assetUrl === undefined ? {} : { assetUrl: context.assetUrl }),
    ...(context.storagePath === undefined ? {} : { storagePath: context.storagePath }),
  };
}
