/**
 * The static-export root of a server component: what `jsails build` writes in
 * place of a live root, which it cannot sign or update.
 *
 * A component has at most one static form. `staticFallback(context)` renders
 * without state. `staticRender: 'initial'` renders the component's own
 * `render` over `initialState(context)`, but only when `authorize(context)`
 * returns exactly `true` for the static context, and with inert tools: `bind`
 * shows the field's value without the model marker, `submit` gives a form
 * that cannot navigate (`method="dialog"`), and every other tool returns no
 * marker, so nothing in the page claims to be live. Actions and their args are
 * still validated, and the bound forms are checked as a live render checks
 * them (`inert-forms.ts`: the inert `submit` spreads a private per-render
 * marker for the check, stripped once it has run), so a render that is wrong
 * when served is wrong here too. Neither form runs the `mount` hook or URL
 * seeding, and neither signs a snapshot or mints an instance id.
 *
 * Both render inside a static nesting frame (`nested-frame.ts`), so a
 * `renderNested` chain under a static form stops at the same depth as a live
 * one, and each child renders its own static form inline.
 *
 * Both render inside a marker-only root (the component markers, no snapshot
 * or render tag). A component without a static form fails closed with
 * `component_static.missing_fallback`; a denied initial render with
 * `component_static.initial_denied`; any other failure of a static form (a
 * throwing `authorize`, `initialState`, `render` or `staticFallback`, a bound
 * form that could navigate, a nested chain past its depth) with
 * `component_static.render_failed`, its cause holding the failure. A refusal
 * raised by a nested child passes through unchanged, so it names the
 * innermost component. `renderRoute` lets every refusal past a page's error
 * boundary, so the export fails naming the route.
 */

import { Fragment, h } from 'preact';

import type { Awaitable } from '../../contracts/awaitable.js';
import type { RenderChild } from '../../contracts/component.js';
import type { JsonValue, RequestContext } from '../../contracts/http.js';
import {
  bindAttrs,
  confirmAttrs,
  intersectAttrs,
  loadingTargetAttrs,
  pollAttrs,
  refAttrs,
  showAttrs,
  sortAttrs,
  textAttrs,
} from '../../client/action-attrs.js';
import { renderToString } from '../../jsx/render-to-string.js';
import { Encoding } from '../../support/encoding.js';
import type {
  ServerComponentBindOptions,
  ServerComponentCallAttrs,
  ServerComponentDefinition,
  ServerComponentModelAttrs,
  ServerComponentPollAttrs,
  ServerComponentPollOptions,
  ServerComponentRenderTools,
  ServerComponentState,
  ServerComponentSubmitAttrs,
} from '../component.js';
import { runInComponentFrame } from '../nested-frame.js';
import { COMPONENT_ATTRIBUTE, COMPONENT_NAME_ATTRIBUTE } from '../protocol.js';
import { ComponentAuthorizeErrors, evaluateAuthorize } from './authorize.js';
import { assertInertForms } from './inert-forms.js';
import { withRenderSignal } from './mount.js';
import { boundValueAttrs, computedOf, fieldRulesOf, serializeActionArgs } from './render-root.js';
import { ComponentStaticErrors } from './static-errors.js';
import { ServerComponentRuntimeError } from './value-errors.js';

/**
 * The attribute the inert `submit` marks its form with for the inert-form
 * check. Its value is a random per-render nonce, and the render strips
 * exactly that attribute afterwards, so it never reaches the page.
 */
const STATIC_SUBMIT_ATTRIBUTE = 'data-jsails-static-submit';

/** The marker-only root a static form renders inside, around its rendered HTML. */
function staticRoot(component: ServerComponentDefinition<any>, inner: string): string {
  return renderToString(
    h('div', {
      [COMPONENT_ATTRIBUTE]: component.name,
      [COMPONENT_NAME_ATTRIBUTE]: component.name,
      dangerouslySetInnerHTML: { __html: inner },
    }),
  );
}

/**
 * Render a static form's children inside a static nesting frame, so a nested
 * chain below it keeps the depth bound and renders static.
 */
async function renderInStaticFrame(render: () => Awaitable<RenderChild>): Promise<string> {
  const { result } = runInComponentFrame({ static: true }, render);
  return renderToString(h(Fragment, null, await result));
}

/** No marker: what an inert tool spreads. */
const NONE: Readonly<Record<string, string>> = Object.freeze({});

/** A marker tool that validates its argument as the live tool does, then marks nothing. */
function inert<A extends unknown[]>(
  tool: (...args: A) => Record<string, string>,
): (...args: A) => Record<string, string> {
  return (...args) => {
    tool(...args);
    return NONE;
  };
}

/**
 * The tools of an initial static render. Each validates what the live tool
 * validates, then returns only what a page without the runtime can use;
 * `submit` also spreads `nonce` as the inert-form check's marker.
 */
function inertTools(
  component: ServerComponentDefinition<any>,
  state: ServerComponentState,
  context: RequestContext,
  nonce: string,
): ServerComponentRenderTools<any> {
  const rulesFor = fieldRulesOf(component);
  return {
    bind(name: string, options?: ServerComponentBindOptions): ServerComponentModelAttrs {
      bindAttrs(name, options);
      return boundValueAttrs(state[name], rulesFor(name)) as unknown as ServerComponentModelAttrs;
    },
    call(action: string, args?: JsonValue): ServerComponentCallAttrs {
      serializeActionArgs(component, action, args);
      return NONE as unknown as ServerComponentCallAttrs;
    },
    submit(action: string, args?: JsonValue): ServerComponentSubmitAttrs {
      serializeActionArgs(component, action, args);
      return {
        method: 'dialog',
        [STATIC_SUBMIT_ATTRIBUTE]: nonce,
      } as unknown as ServerComponentSubmitAttrs;
    },
    poll(options: ServerComponentPollOptions): ServerComponentPollAttrs {
      pollAttrs(options);
      return NONE as unknown as ServerComponentPollAttrs;
    },
    confirm: inert(confirmAttrs),
    loadingTarget: inert(loadingTargetAttrs),
    show: inert(showAttrs),
    text: inert(textAttrs),
    sort: inert(sortAttrs),
    intersect: inert(intersectAttrs),
    ref: inert(refAttrs),
    ignore: () => NONE,
    computed: computedOf(component, state, context),
    errors: Object.freeze({}),
    values: Object.freeze({}),
    context,
  };
}

/** The initial render of a `staticRender: 'initial'` component, or a refusal. */
async function renderInitial(
  id: string,
  component: ServerComponentDefinition<any>,
  requestContext: RequestContext,
): Promise<string> {
  const context = withRenderSignal(requestContext);
  const outcome = await evaluateAuthorize(() => component.authorize(context));
  if (outcome.kind === 'fault') {
    throw new ComponentAuthorizeErrors.Error(
      'component_failed',
      { component: id },
      { cause: outcome.error },
    );
  }
  if (outcome.kind !== 'allow') {
    throw new ComponentStaticErrors.Error('initial_denied', { component: id });
  }
  let state: ServerComponentState;
  try {
    state = component.stateSchema.parse(await component.initialState(context));
  } catch {
    throw new ServerComponentRuntimeError(
      'invalid_state',
      'component produced an invalid initial state',
    );
  }
  const nonce = Encoding.base64url(Encoding.randomBytes(12));
  const tools = inertTools(component, state, context, nonce);
  const inner = await renderInStaticFrame(() => component.render(state, tools));
  // Checked with the nested children in place, as the live render checks it.
  assertInertForms(inner, STATIC_SUBMIT_ATTRIBUTE);
  return inner.replaceAll(` ${STATIC_SUBMIT_ATTRIBUTE}="${nonce}"`, '');
}

/** The rendered static form of `component`, or a refusal (see the module comment). */
async function renderStaticForm(
  id: string,
  component: ServerComponentDefinition<any>,
  context: RequestContext,
): Promise<string> {
  const fallback = component.staticFallback;
  if (fallback !== undefined) {
    return renderInStaticFrame(() => fallback.call(component, context));
  }
  if (component.staticRender === 'initial') {
    return renderInitial(id, component, context);
  }
  throw new ComponentStaticErrors.Error('missing_fallback', { component: id });
}

/**
 * Render the static form of the component registered as `id` (see the module
 * comment), or fail closed with a {@link ComponentStaticErrors} refusal.
 */
export async function renderStaticHtml(
  id: string,
  component: ServerComponentDefinition<any>,
  context: RequestContext,
): Promise<string> {
  let inner: string;
  try {
    inner = await renderStaticForm(id, component, context);
  } catch (error) {
    if (ComponentStaticErrors.is(error)) {
      throw error;
    }
    throw new ComponentStaticErrors.Error('render_failed', { component: id }, { cause: error });
  }
  return staticRoot(component, inner);
}
