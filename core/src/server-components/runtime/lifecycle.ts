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
import type { SnapshotPage } from '../snapshot.js';
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

/**
 * Reconstruct the mount-time request context from a credential's signed page
 * provenance. Every lane's credential carries the page it was minted on, so an
 * update, an upload, and a download all authorize against the same url and
 * route params the component was mounted with. `signal` is the lane's
 * deadline signal, aborted when the client goes away or the deadline passes.
 */
export function reconstructContext(
  context: RequestContext,
  page: SnapshotPage,
  origin: string,
  signal: AbortSignal,
): RequestContext {
  return {
    // The transport request itself stays the actual request; only url/params
    // are reconstructed from the page the component was signed on.
    request: context.request,
    url: new URL(page.path, origin),
    params: { ...page.params },
    signal,
    session: context.session,
    ...(context.origin === undefined ? {} : { origin: context.origin }),
    ...(context.client === undefined ? {} : { client: context.client }),
    ...(context.renderMode === undefined ? {} : { renderMode: context.renderMode }),
    ...(context.services === undefined ? {} : { services: context.services }),
    ...(context.assetUrl === undefined ? {} : { assetUrl: context.assetUrl }),
    ...(context.storagePath === undefined ? {} : { storagePath: context.storagePath }),
  };
}
