/**
 * The mount pipeline: the first, live server render of a component.
 *
 * Authorize (a throwing authorize is a reported fault, not a quiet deny),
 * produce the initial state (seeded once from the URL when the
 * component declares `urlBinding`), validate it strictly, run the `mount` hook,
 * sign a snapshot bound to the page, origin, and subject, and render the root
 * carrying the snapshot, id, and render-tag markers.
 *
 * A nested child is never restored from anything the client sent: during its
 * parent's update it is either kept by reference (the client already holds it;
 * the child is authorized but not executed) or mounted here from scratch.
 */

import type { z } from 'zod';

import type { RequestContext } from '../../contracts/http.js';
import type { ServerComponentDefinition, ServerComponentState } from '../component.js';
import type { ComponentSigner } from '../snapshot.js';
import { seedFromUrl } from '../url-binding.js';
import { ComponentAuthorizeErrors, evaluateAuthorize, trustedOriginOf } from './authorize.js';
import { generateComponentId, runMountHook } from './lifecycle.js';
import { renderComponentHtml } from './render-root.js';
import { ServerComponentRuntimeError } from './value-errors.js';

/** `context` with `signal` set: the request's own signal unless the caller already set one. */
export function withRenderSignal(context: RequestContext): RequestContext {
  return context.signal === undefined ? { ...context, signal: context.request.signal } : context;
}

/**
 * Run the component's `authorize` for `context`: `true` only on an exact
 * `true`; a throw is reported as a fault.
 */
export async function authorizeComponent(
  id: string,
  component: ServerComponentDefinition<any>,
  context: RequestContext,
): Promise<boolean> {
  const outcome = await evaluateAuthorize(() => component.authorize(context));
  if (outcome.kind === 'fault') {
    throw new ComponentAuthorizeErrors.Error(
      'component_failed',
      { component: id },
      { cause: outcome.error },
    );
  }
  return outcome.kind === 'allow';
}

/**
 * Mount the component registered as `id` for `context`, returning its signed
 * root HTML. Its hooks and render see `context.signal`, the request's own
 * signal unless the caller already set one.
 */
export async function mountComponent(
  id: string,
  component: ServerComponentDefinition<any>,
  requestContext: RequestContext,
  signer: ComponentSigner,
): Promise<string> {
  const context = withRenderSignal(requestContext);
  if (!(await authorizeComponent(id, component, context))) {
    throw new ServerComponentRuntimeError('forbidden', 'component access denied');
  }
  return mountAuthorized(id, component, context, signer);
}

/** Mount a component whose `authorize` already allowed for `context`. */
export async function mountAuthorized(
  id: string,
  component: ServerComponentDefinition<any>,
  context: RequestContext,
  signer: ComponentSigner,
): Promise<string> {
  let initial = await component.initialState(context);

  // URL seeding is a graceful hint applied exactly once, at mount: uncoercible
  // or missing values leave initialState alone and the schema parse below is
  // the canonical validation. Updates reconstruct state only from the signed
  // snapshot, so the URL is never re-read after the first render.
  const urlFields = component.urlBinding;
  if (urlFields !== undefined && urlFields.length > 0) {
    // stateSchema is validated to be a ZodObject at definition time.
    initial = seedFromUrl(
      initial,
      component.stateSchema as unknown as z.ZodObject<any>,
      context.url,
      new Set(urlFields),
    );
  }

  let state: ServerComponentState;
  try {
    state = component.stateSchema.parse(initial);
  } catch {
    throw new ServerComponentRuntimeError(
      'invalid_state',
      'component produced an invalid initial state',
    );
  }

  await runMountHook(component, context);

  const instanceId = generateComponentId();
  const token = signer.sign({
    v: 1,
    component: id,
    id: instanceId,
    state,
    page: { path: context.url.pathname, params: { ...context.params } },
    origin: trustedOriginOf(context),
    subject: signer.subjectFor(context.session?.id ?? null),
  });
  const rendered = await renderComponentHtml(component, state, {
    componentId: id,
    id: instanceId,
    token,
    errors: {},
    values: {},
    context,
  });
  return rendered.html;
}
