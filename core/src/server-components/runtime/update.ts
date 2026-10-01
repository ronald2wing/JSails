/**
 * The update pipeline: one update POST from a mounted component, mounted only
 * through {@link updateRoute}, speaking the version 2 wire protocol
 * (`wire/protocol.ts`).
 *
 * The request crosses the access chain (its cross-site check) and the lane
 * boundary (snapshot, subject, concurrency slot, component authorization, deadline) on the `update` lane,
 * or the `refresh` lane for a `$refresh` poll; then the `hydrate`/`updating`
 * hooks run, client edits are applied under `writableKeys`, the candidate is
 * validated strictly, at most one allowlisted action runs on a deep clone, the
 * result is re-validated, the `updated` hook runs, and the root is rendered.
 *
 * What goes back depends on what changed. The token is re-signed only when the
 * state changed, its sliding lifetime is more than half spent, or it was
 * signed under a retired key; otherwise the presented token is handed back
 * byte for byte. When the render tag equals the client's `have.render`, no
 * client edit was applied, the action raised no effect, and every nested
 * child was kept, the answer is `unchanged` (carrying the token only when it
 * was re-signed); otherwise it is a `render`. Nested children the client reported in `have.slots` are kept by
 * reference, never re-derived; an action asks the client to refresh them
 * through `effects.refresh`.
 *
 * Every rejection before the action runs is side-effect free. A rejection after
 * it (re-validation, `updated`) cannot undo the action, which is why handlers
 * must make their own persistence idempotent.
 */

import { ZodError } from 'zod';

import { readJsonBody } from '../../api/json-body.js';
import { deepCloneJson } from '../../json/shape.js';
import {
  isRedirect,
  type ServerComponentActionContext,
  type ServerComponentState,
} from '../component.js';
import { isDownload, type DownloadReferenceSigner } from '../downloads.js';
import { COMPONENT_DOWNLOAD_ENDPOINT, REFRESH_ACTION } from '../protocol.js';
import { isJsonSafeValue, type ComponentSigner, type SnapshotPayload } from '../snapshot.js';
import { canonicalJson } from '../../wire/json-scan.js';
import { RedirectErrors, sameOriginLocation } from '../../url/redirect-target.js';
import {
  COMPONENT_PROTOCOL_VERSION,
  parseUpdateRequest,
  type ComponentUpdateDownload,
  type ComponentUpdateEffects,
  type ComponentUpdateRequest,
} from '../../wire/protocol.js';
import { ComponentAuthorizeErrors, evaluateAuthorize } from './authorize.js';
import {
  componentRoute,
  jsonResponse,
  laneFailure,
  type AuthorizedComponentRequest,
  type BoundaryDeps,
  type ComponentRead,
  type ComponentRoute,
  type LaneEcho,
} from './boundary.js';
import { runStateHook } from './lifecycle.js';
import { buildValues, parseActionArgs } from './payload.js';
import {
  lookupAction,
  renderComponentHtml,
  validationFailureResult,
  type RenderedRoot,
  type ValidationFailureTarget,
} from './render-root.js';
import {
  errorResult,
  zodIssuesToFieldErrors,
  type ServerComponentUpdateResult,
} from './value-errors.js';

/** What the update pipeline reads from the assembled runtime. */
export interface UpdatePipelineDeps {
  readonly boundary: BoundaryDeps;
  readonly signer: ComponentSigner;
  /** Present only when downloads are configured; otherwise a `download()` result is ignored. */
  readonly downloadSigner: DownloadReferenceSigner | undefined;
}

type AuthorizedUpdate = AuthorizedComponentRequest<'snapshot', ComponentUpdateRequest>;

/** Members of every error body the update lane answers. */
function errorEcho(sequence: number): LaneEcho {
  return { kind: 'error', sequence };
}

/**
 * Mint a signed download reference for the stored file, carrying the
 * authorized snapshot's envelope (component, subject, origin, page), so the
 * download lane re-authorizes against the page this update ran for. The
 * client navigates to the signed GET endpoint and the browser's
 * Content-Disposition handling turns it into a download without leaving the page.
 */
function mintDownload(
  actionResult: unknown,
  authorized: AuthorizedUpdate,
  deps: UpdatePipelineDeps,
): ComponentUpdateDownload | undefined {
  if (!isDownload(actionResult) || deps.downloadSigner === undefined) {
    return undefined;
  }
  const snapshot = authorized.credential;
  const token = deps.downloadSigner.sign({
    downloadId: actionResult.id,
    component: authorized.componentId,
    subject: deps.signer.subjectFor(authorized.subjectId),
    origin: snapshot.origin,
    page: snapshot.page,
    filename: actionResult.filename,
    contentType: actionResult.contentType,
  });
  return {
    url: `${COMPONENT_DOWNLOAD_ENDPOINT}?ref=${encodeURIComponent(token)}`,
    filename: actionResult.filename,
  };
}

/** Read the update body; anything but a valid v2 request is refused before any credential work. */
async function readUpdate(request: Request): Promise<ComponentRead<ComponentUpdateRequest>> {
  let payload: unknown;
  try {
    payload = await readJsonBody(request);
  } catch {
    return {
      ok: false,
      failure: laneFailure('invalid_request', 'Invalid component update request'),
      echo: errorEcho(0),
    };
  }
  const parsed = parseUpdateRequest(payload);
  if (parsed.ok) {
    return {
      ok: true,
      token: parsed.value.snapshot,
      input: parsed.value,
      echo: errorEcho(parsed.value.sequence),
    };
  }
  switch (parsed.reason) {
    case 'protocol_mismatch':
      return {
        ok: false,
        answer: jsonResponse(400, {
          kind: 'protocol_mismatch',
          sequence: parsed.sequence,
          v: COMPONENT_PROTOCOL_VERSION,
        }),
      };
    case 'too_many_children':
      return {
        ok: false,
        failure: {
          status: 400,
          code: 'too_many_children',
          message: 'The update reports too many nested children',
        },
        echo: errorEcho(parsed.sequence),
      };
    case 'malformed':
      return {
        ok: false,
        failure: laneFailure('invalid_request', 'Invalid component update request'),
        echo: errorEcho(parsed.sequence),
      };
  }
}

/**
 * The update route: `update` lane for actions and client edits, `refresh`
 * lane for a `$refresh` poll.
 */
export function updateRoute(deps: UpdatePipelineDeps): ComponentRoute {
  return componentRoute<'snapshot', ComponentUpdateRequest>(
    {
      credential: 'snapshot',
      lane: 'update',
      laneOf: (input) => (input.action?.name === REFRESH_ACTION ? 'refresh' : 'update'),
      // A refusal before the body is read cannot echo the request's sequence;
      // 0 is never a request's, so the client takes it as an answer to the
      // request in flight.
      echo: errorEcho(0),
      read: readUpdate,
      async handle(authorized) {
        const result = await applyComponentUpdate(authorized, deps);
        return jsonResponse(result.status, result.body);
      },
    },
    deps.boundary,
  );
}

/** The refresh requests an action raised through its context. */
interface RefreshRequests {
  all: boolean;
  readonly keys: Set<string>;
}

/**
 * The request context an update runs its hooks, action, and render under: the
 * reconstructed context plus the action's nested-child refresh calls.
 */
function updateContext(
  authorized: AuthorizedUpdate,
  refresh: RefreshRequests,
): ServerComponentActionContext {
  return {
    ...authorized.context,
    refreshChild(key: string) {
      if (typeof key === 'string') {
        refresh.keys.add(`k:${key}`);
      }
    },
    refreshChildren() {
      refresh.all = true;
    },
  };
}

/** The effects of one update: a redirect, a download, and the kept children to refresh. */
function effectsOf(
  actionResult: unknown,
  download: ComponentUpdateDownload | undefined,
  rendered: RenderedRoot,
  refresh: RefreshRequests,
): ComponentUpdateEffects | undefined {
  // `redirect()` validated its target, but the signal is a plain object an
  // action could build by hand, so the target is checked again here.
  let redirect: string | undefined;
  if (isRedirect(actionResult)) {
    redirect = sameOriginLocation(actionResult.url);
    if (redirect !== actionResult.url) throw new RedirectErrors.Error('invalid_target');
  }
  const slots = rendered.slots
    .filter((entry) => entry.kept && (refresh.all || refresh.keys.has(entry.slot)))
    .map((entry) => entry.slot);
  if (redirect === undefined && download === undefined && slots.length === 0) {
    return undefined;
  }
  return {
    ...(redirect === undefined ? {} : { redirect }),
    ...(download === undefined ? {} : { download }),
    ...(slots.length === 0 ? {} : { refresh: slots }),
  };
}

/** Apply one authorized update, returning `{ status, body }`. */
async function applyComponentUpdate(
  authorized: AuthorizedUpdate,
  deps: UpdatePipelineDeps,
): Promise<ServerComponentUpdateResult> {
  const { updates, action, sequence, have } = authorized.input;
  const { token, component, componentId } = authorized;
  const snapshot: SnapshotPayload = authorized.credential;
  const signer = deps.signer;
  const refresh: RefreshRequests = { all: false, keys: new Set() };
  const context = updateContext(authorized, refresh);

  const target: ValidationFailureTarget = {
    sequence,
    token,
    snapshot,
    componentId,
    component,
    context,
    values: buildValues(updates),
    held: have.slots,
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
  // behind a `z.any` field); reject it before any side effect. This is the
  // signer's own structural check, run as a plain traversal rather than a
  // throwaway sign.
  if (!isJsonSafeValue(validated)) {
    return errorResult(sequence, 'invalid_request', 'Invalid component update request');
  }

  // A `z.any` field preserves identity, so a run that mutates nested state and
  // then fails must not corrupt the verified snapshot used by the 422 re-render.
  const workingState = deepCloneJson(validated);

  // Only a redirect or download signal carries meaning; `undefined` both when
  // no action ran (`$refresh`) and when an action returned `void`.
  let actionResult: unknown;
  let actionRan = false;

  // `$refresh` carries no user action: it never looks up an action, runs
  // authorize, or invokes `run`, but still crosses the same boundary and is
  // re-validated and re-rendered.
  if (action !== undefined && action.name !== REFRESH_ACTION) {
    const definition = lookupAction(component, action.name);
    if (definition === undefined) {
      return errorResult(sequence, 'invalid_request', 'Unknown action');
    }
    const argsResult = parseActionArgs(definition, action.args);
    if (!argsResult.ok) {
      return await validationFailureResult(target, argsResult.errors);
    }
    if (argsResult.value !== undefined && !isJsonSafeValue(argsResult.value)) {
      return errorResult(sequence, 'invalid_request', 'Invalid component update request');
    }
    const actionAuthorize = definition.authorize;
    if (actionAuthorize !== undefined) {
      const outcome = await evaluateAuthorize(() =>
        actionAuthorize(context, workingState, argsResult.value),
      );
      if (outcome.kind === 'fault') {
        throw new ComponentAuthorizeErrors.Error(
          'action_failed',
          { component: componentId },
          { cause: outcome.error },
        );
      }
      if (outcome.kind === 'deny') {
        return errorResult(sequence, 'forbidden', 'Forbidden');
      }
    }
    try {
      actionRan = true;
      actionResult = await definition.run(workingState, argsResult.value, context);
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
  // after an action before it is signed. Without one, `workingState` is a
  // clone of the state the schema already produced, so it is not parsed twice.
  try {
    const nextState: ServerComponentState = actionRan
      ? component.stateSchema.parse(workingState)
      : workingState;
    // The action has already taken effect, so an `updated` throw cannot be a
    // 422 rejection; it is sanitized to a value-free 500.
    const updatedResult = await runStateHook(component.updated, nextState, target, false);
    if (updatedResult !== null) {
      return updatedResult;
    }

    // An unchanged state keeps its token, so an idle poll hands back the same
    // bytes, until the sliding lifetime needs renewing or a key rotation
    // needs the token moved to the current key.
    const currentSubject = signer.subjectFor(authorized.subjectId);
    const resign =
      canonicalJson(nextState) !== canonicalJson(snapshot.state) ||
      signer.renewalDue(snapshot) ||
      snapshot.subject !== currentSubject;
    const nextToken = resign
      ? signer.sign({
          v: 1,
          component: componentId,
          id: snapshot.id,
          state: nextState,
          page: snapshot.page,
          origin: snapshot.origin,
          subject: currentSubject,
          // The mount time travels with every re-sign so the absolute lifetime
          // holds. A custom signer that does not report `issuedAt` gets it back
          // unknown.
          ...(snapshot.issuedAt === undefined ? {} : { issuedAt: snapshot.issuedAt }),
        })
      : token;
    const rendered = await renderComponentHtml(component, nextState, {
      componentId,
      id: snapshot.id,
      token: nextToken,
      errors: {},
      values: {},
      context,
      held: have.slots,
    });
    const effects = effectsOf(
      actionResult,
      mintDownload(actionResult, authorized, deps),
      rendered,
      refresh,
    );
    // `unchanged` tells the client its DOM already is this render. The tag
    // elides every child's content, so it cannot tell a kept child from one
    // mounted fresh; a fresh child (one the client left out of `have.slots`
    // because its copy is blocked, or never reported) is content the client
    // lacks, so its render is sent.
    if (
      rendered.tag === have.render &&
      updateKeys.length === 0 &&
      effects === undefined &&
      rendered.slots.every((slot) => slot.kept)
    ) {
      return {
        status: 200,
        body: {
          kind: 'unchanged',
          sequence,
          ...(nextToken === token ? {} : { snapshot: nextToken }),
        },
      };
    }
    // The client applies the render first, then the effects.
    return {
      status: 200,
      body: {
        kind: 'render',
        sequence,
        snapshot: nextToken,
        html: rendered.html,
        render: rendered.tag,
        ...(effects === undefined ? {} : { effects }),
      },
    };
  } catch (error) {
    if (error instanceof ZodError) {
      return await validationFailureResult(
        target,
        zodIssuesToFieldErrors(error.issues, workingState),
      );
    }
    authorized.report(error);
    return errorResult(sequence, 'internal_error', 'Internal Server Error');
  }
}
