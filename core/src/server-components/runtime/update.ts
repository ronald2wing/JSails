/**
 * The update pipeline: one update POST from a mounted component.
 *
 * The request crosses the shared snapshot boundary (origin, snapshot, CSRF,
 * component authorization), then the `hydrate`/`updating` hooks run, client
 * edits are applied under `writableKeys`, the candidate is validated strictly,
 * at most one allowlisted action runs on a deep clone, the result is
 * re-validated, the `updated` hook runs, and the state is re-signed and
 * re-rendered so the returned snapshot and HTML are always in sync.
 *
 * Every rejection before the action runs is side-effect free. A rejection after
 * it (re-validation, `updated`) cannot undo the action, which is why handlers
 * must make their own persistence idempotent.
 */

import { ZodError } from 'zod';

import type { JsonObject, RequestContext } from '../../contracts/http.js';
import { deepCloneJson } from '../../json/shape.js';
import { isSameOriginRequest } from '../../security/trusted-mutation.js';
import {
  isRedirect,
  type ServerComponentDefinition,
  type ServerComponentState,
} from '../component.js';
import { isDownload, type DownloadReferenceSigner } from '../downloads.js';
import type { ComponentUpdateDownload } from '../protocol.js';
import { COMPONENT_DOWNLOAD_ENDPOINT, REFRESH_ACTION } from '../protocol.js';
import type { ComponentSigner, SnapshotPayload } from '../snapshot.js';
import {
  actionAuthorizeAllows,
  authorizeSnapshotRequest,
  resolveTrustedOrigin,
} from './authorize.js';
import { runStateHook } from './lifecycle.js';
import { buildValues, parseActionArgs, parseUpdatePayload } from './payload.js';
import {
  lookupAction,
  renderComponentHtml,
  validationFailureResult,
  type ValidationFailureTarget,
} from './render-root.js';
import {
  errorResult,
  zodIssuesToFieldErrors,
  type ServerComponentUpdateResult,
} from './value-errors.js';

/** What the update pipeline reads from the assembled runtime. */
export interface UpdatePipelineDeps {
  readonly components: ReadonlyMap<string, ServerComponentDefinition<any>>;
  readonly signer: ComponentSigner;
  /** Present only when downloads are configured; otherwise a `download()` result is ignored. */
  readonly downloadSigner: DownloadReferenceSigner | undefined;
}

/**
 * Probe the signer's existing JSON-safety validation without keeping the token.
 *
 * The signer rejects forbidden own keys, non-plain/non-finite values, cycles,
 * and over-deep nesting before it signs. That check otherwise runs only at the
 * final sign, after an action has already taken effect, so probe it up front to
 * reject a nested dangerous/non-JSON update or arg before any side effect.
 */
function isJsonSafeState(
  signer: ComponentSigner,
  snapshot: SnapshotPayload,
  state: unknown,
): boolean {
  try {
    signer.sign({
      v: 1,
      component: snapshot.component,
      id: snapshot.id,
      state: state as JsonObject,
      page: snapshot.page,
      origin: snapshot.origin,
      subject: snapshot.subject,
      revision: snapshot.revision,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Mint a signed download reference bound to the component, subject, and stored
 * file id. The client navigates to the signed GET endpoint and the browser's
 * Content-Disposition handling turns it into a download without leaving the page.
 */
function mintDownload(
  actionResult: unknown,
  component: ServerComponentDefinition<any>,
  context: RequestContext,
  deps: UpdatePipelineDeps,
): ComponentUpdateDownload | undefined {
  if (!isDownload(actionResult) || deps.downloadSigner === undefined) {
    return undefined;
  }
  const token = deps.downloadSigner.sign({
    downloadId: actionResult.id,
    component: component.name,
    subject: deps.signer.subjectFor(context.session?.id ?? null),
    filename: actionResult.filename,
    contentType: actionResult.contentType,
  });
  return {
    url: `${COMPONENT_DOWNLOAD_ENDPOINT}?ref=${encodeURIComponent(token)}`,
    filename: actionResult.filename,
  };
}

/** Handle one update POST, returning `{ status, body }` for the HTTP layer. */
export async function applyComponentUpdate(
  payload: unknown,
  context: RequestContext,
  origin: string | undefined,
  deps: UpdatePipelineDeps,
): Promise<ServerComponentUpdateResult> {
  const parsed = parseUpdatePayload(payload);
  if (!parsed.ok) {
    return errorResult(parsed.sequence, 'invalid_request', 'Invalid component update request');
  }
  const { snapshot: token, updates, action, sequence } = parsed.value;

  let trustedOrigin: string;
  try {
    trustedOrigin = resolveTrustedOrigin(origin, context);
  } catch {
    return errorResult(sequence, 'internal_error', 'Internal Server Error');
  }
  if (!isSameOriginRequest(context.request, trustedOrigin)) {
    return errorResult(sequence, 'origin_mismatch', 'Cross-origin request rejected');
  }

  const authorized = await authorizeSnapshotRequest({
    token,
    request: context.request,
    context,
    trustedOrigin,
    components: deps.components,
    signer: deps.signer,
  });
  if (!authorized.ok) {
    return errorResult(sequence, authorized.code, authorized.message);
  }
  const { snapshot, component, csrfToken, context: actionContext } = authorized;
  const signer = deps.signer;

  const target: ValidationFailureTarget = {
    sequence,
    token,
    snapshot,
    component,
    context: actionContext,
    csrfToken,
    values: buildValues(updates),
  };

  // `hydrate` sees the state reconstructed from the verified snapshot before
  // any client edit or action.
  const baseState: ServerComponentState = { ...snapshot.state };
  const hydrateResult = await runStateHook(component.hydrate, baseState, target, true);
  if (hydrateResult !== null) {
    return hydrateResult;
  }

  // `updating` may reject the update before any client edit is applied.
  const updateKeys = Object.keys(updates);
  if (updateKeys.length > 0) {
    const updatingResult = await runStateHook(component.updating, baseState, target, true);
    if (updatingResult !== null) {
      return updatingResult;
    }
  }

  const writable = new Set(component.writableKeys ?? []);
  for (const key of updateKeys) {
    if (!writable.has(key)) {
      return await validationFailureResult(target, { [key]: 'Field is read-only' });
    }
  }
  for (const [key, value] of Object.entries(updates)) {
    baseState[key] = value;
  }

  // Both the action's `authorize` and its `run` must observe the same
  // schema-validated (and normalized) candidate, so an invalid client edit is
  // rejected here, before either is invoked.
  let validated: ServerComponentState;
  try {
    validated = component.stateSchema.parse(baseState);
  } catch (error) {
    if (error instanceof ZodError) {
      return await validationFailureResult(target, zodIssuesToFieldErrors(error.issues, baseState));
    }
    return errorResult(sequence, 'internal_error', 'Internal Server Error');
  }

  // A nested forbidden key or non-JSON value can survive the schema (e.g.
  // behind a `z.any` field); reject it before any side effect.
  if (!isJsonSafeState(signer, snapshot, validated)) {
    return errorResult(sequence, 'invalid_request', 'Invalid component update request');
  }

  // A `z.any` field preserves identity, so a run that mutates nested state and
  // then fails must not corrupt the verified snapshot used by the 422 re-render.
  const workingState = deepCloneJson(validated);

  // Only a redirect or download signal carries meaning; `undefined` both when
  // no action ran (`$refresh`) and when an action returned `void`.
  let actionResult: unknown;

  // `$refresh` carries no user action: it never looks up an action, runs
  // authorize, or invokes `run`, but still crosses the same boundary and is
  // re-validated, re-signed, and re-rendered.
  if (action !== undefined && action.name !== REFRESH_ACTION) {
    const definition = lookupAction(component, action.name);
    if (definition === undefined) {
      return errorResult(sequence, 'invalid_request', 'Unknown action');
    }
    const argsResult = parseActionArgs(definition, action.args);
    if (!argsResult.ok) {
      return await validationFailureResult(target, argsResult.errors);
    }
    if (
      argsResult.value !== undefined &&
      !isJsonSafeState(signer, snapshot, { args: argsResult.value })
    ) {
      return errorResult(sequence, 'invalid_request', 'Invalid component update request');
    }
    if (
      definition.authorize !== undefined &&
      !(await actionAuthorizeAllows(
        definition.authorize,
        actionContext,
        workingState,
        argsResult.value,
      ))
    ) {
      return errorResult(sequence, 'forbidden', 'Forbidden');
    }
    try {
      actionResult = await definition.run(workingState, argsResult.value, actionContext);
    } catch (error) {
      // A domain validation failure raised by the action is a 422, not a server
      // fault; `snapshot.state` is untouched (the action ran on a deep clone),
      // so the 422 re-render and the original token remain coherent.
      if (error instanceof ZodError) {
        return await validationFailureResult(
          target,
          zodIssuesToFieldErrors(error.issues, workingState),
        );
      }
      return errorResult(sequence, 'internal_error', 'Internal Server Error');
    }
  }

  // Actions may mutate any field server-side, so the full state is re-validated
  // after the action before it is re-signed.
  try {
    const nextState = component.stateSchema.parse(workingState);
    // The action has already taken effect, so an `updated` throw cannot be a
    // 422 rejection; it is sanitized to a value-free 500.
    const updatedResult = await runStateHook(component.updated, nextState, target, false);
    if (updatedResult !== null) {
      return updatedResult;
    }
    const nextToken = signer.sign({
      v: 1,
      component: component.name,
      id: snapshot.id,
      state: nextState,
      page: snapshot.page,
      origin: snapshot.origin,
      subject: snapshot.subject,
      revision: snapshot.revision,
    });
    const html = await renderComponentHtml(component, nextState, {
      id: snapshot.id,
      token: nextToken,
      csrfToken,
      errors: {},
      values: {},
      context: actionContext,
    });
    // The redirect URL was validated when `redirect()` constructed the signal;
    // the client applies the render first, then navigates.
    const redirectUrl = isRedirect(actionResult) ? actionResult.url : undefined;
    const download = mintDownload(actionResult, component, actionContext, deps);
    return {
      status: 200,
      body: {
        sequence,
        snapshot: nextToken,
        html,
        ...(redirectUrl === undefined ? {} : { redirect: redirectUrl }),
        ...(download === undefined ? {} : { download }),
      },
    };
  } catch (error) {
    if (error instanceof ZodError) {
      return await validationFailureResult(
        target,
        zodIssuesToFieldErrors(error.issues, workingState),
      );
    }
    return errorResult(sequence, 'internal_error', 'Internal Server Error');
  }
}
