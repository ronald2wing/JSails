/**
 * The mount pipeline: the first, live server render of a component.
 *
 * Authorize, produce the initial state (seeded once from the URL when the
 * component declares `urlBinding`), validate it strictly, run the `mount` hook,
 * sign a snapshot bound to the page, origin, and subject, and render the root
 * carrying the snapshot, CSRF, and id markers.
 */

import type { z } from 'zod';

import type { RequestContext } from '../../contracts/http.js';
import type { ServerComponentDefinition, ServerComponentState } from '../component.js';
import type { ComponentSigner } from '../snapshot.js';
import { seedFromUrl } from '../url-binding.js';
import { authorizeAllows, resolveTrustedOrigin } from './authorize.js';
import { generateComponentId, runMountHook } from './lifecycle.js';
import { renderComponentHtml } from './render-root.js';
import { ServerComponentRuntimeError } from './value-errors.js';

/** Mount `component` for `context`, returning its signed root HTML. */
export async function mountComponent(
  component: ServerComponentDefinition<any>,
  context: RequestContext,
  signer: ComponentSigner,
  origin: string | undefined,
): Promise<string> {
  if (!(await authorizeAllows(component.authorize, context))) {
    throw new ServerComponentRuntimeError('forbidden', 'component access denied');
  }

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

  const id = generateComponentId();
  const token = signer.sign({
    v: 1,
    component: component.name,
    id,
    state,
    page: { path: context.url.pathname, params: { ...context.params } },
    origin: resolveTrustedOrigin(origin, context),
    subject: signer.subjectFor(context.session?.id ?? null),
  });
  return renderComponentHtml(component, state, {
    id,
    token,
    csrfToken: context.session?.csrfToken ?? id,
    errors: {},
    values: {},
    context,
  });
}
