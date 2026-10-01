/**
 * The mount pipeline: the first, live server render of a component.
 *
 * Authorize, produce the initial state (seeded once from the URL when the
 * component declares `urlBinding`), validate it strictly, run the `mount` hook,
 * sign a snapshot bound to the page, origin, and subject, and render the root
 * carrying the snapshot, CSRF, and id markers.
 *
 * A nested child rendered during its parent's update may instead be restored
 * from the snapshot the client offered for its slot. Authorization still runs;
 * the snapshot must verify for this component, subject, origin, and page and
 * its state must still satisfy the schema, or the child mounts fresh. A
 * restored child keeps its id and token: no lifecycle hook runs, nothing is
 * re-signed, and the client's controller for it stays in sync with the DOM.
 */

import type { z } from 'zod';

import type { RequestContext } from '../../contracts/http.js';
import type { ServerComponentDefinition, ServerComponentState } from '../component.js';
import type { ComponentNestedSnapshot } from '../protocol.js';
import { SnapshotError, type ComponentSigner, type SnapshotPayload } from '../snapshot.js';
import { seedFromUrl } from '../url-binding.js';
import { authorizeAllows, resolveTrustedOrigin } from './authorize.js';
import { generateComponentId, runMountHook } from './lifecycle.js';
import { renderComponentHtml } from './render-root.js';
import { ServerComponentRuntimeError } from './value-errors.js';

/** A child snapshot offered for restore by a parent update. */
export interface RestoreOffer {
  /** The signed token the client holds for the child (untrusted until verified). */
  readonly snapshot: string;
  /** The child's own nested child snapshots, offered to its render. */
  readonly children?: readonly ComponentNestedSnapshot[];
}

/**
 * Mount `component` for `context`, returning its signed root HTML, or restore
 * it from `restore` when that snapshot verifies.
 */
export async function mountComponent(
  component: ServerComponentDefinition<any>,
  context: RequestContext,
  signer: ComponentSigner,
  origin: string | undefined,
  restore?: RestoreOffer,
): Promise<string> {
  if (!(await authorizeAllows(component.authorize, context))) {
    throw new ServerComponentRuntimeError('forbidden', 'component access denied');
  }

  if (restore !== undefined) {
    const restored = verifyRestore(component, context, signer, origin, restore.snapshot);
    if (restored !== null) {
      return renderComponentHtml(component, restored.state, {
        id: restored.snapshot.id,
        token: restore.snapshot,
        csrfToken: context.session?.csrfToken ?? restored.snapshot.id,
        errors: {},
        values: {},
        context,
        ...(restore.children === undefined ? {} : { children: restore.children }),
      });
    }
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
    revision: 0,
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

/**
 * Verify an offered child snapshot for `component` in this request, returning
 * its schema-checked state, or `null` when it must mount fresh: a bad MAC, an
 * expired token, another component, subject, or origin, another page, or a
 * state the current schema rejects. Any other failure propagates.
 */
function verifyRestore(
  component: ServerComponentDefinition<any>,
  context: RequestContext,
  signer: ComponentSigner,
  origin: string | undefined,
  token: string,
): { readonly snapshot: SnapshotPayload; readonly state: ServerComponentState } | null {
  let snapshot: SnapshotPayload;
  try {
    const subjectId = context.session?.id ?? null;
    snapshot = signer.verify(token, {
      component: component.name,
      subject: signer.subjectFor(subjectId),
      subjectId,
      origin: resolveTrustedOrigin(origin, context),
    });
  } catch (error) {
    if (error instanceof SnapshotError) {
      return null;
    }
    throw error;
  }
  // The child was signed on the page its parent renders for; a snapshot from
  // another page or route parameters never carries over.
  if (
    snapshot.page.path !== context.url.pathname ||
    !sameParams(snapshot.page.params, context.params)
  ) {
    return null;
  }
  const parsed = component.stateSchema.safeParse(snapshot.state);
  if (!parsed.success) {
    return null;
  }
  // A restored child keeps its token verbatim, so its state must be exactly
  // what was signed: a schema that would normalize it mounts fresh instead.
  if (JSON.stringify(parsed.data) !== JSON.stringify(snapshot.state)) {
    return null;
  }
  return { snapshot, state: snapshot.state };
}

function sameParams(
  signed: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): boolean {
  const signedKeys = Object.keys(signed);
  if (signedKeys.length !== Object.keys(current).length) {
    return false;
  }
  return signedKeys.every((key) => Object.hasOwn(current, key) && current[key] === signed[key]);
}
