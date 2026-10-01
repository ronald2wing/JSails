/**
 * `defineComponent` — the author-facing component API, lowered onto the
 * `defineServerComponent` primitive — and `defineLiveComponent`, its
 * schema-first form.
 *
 * It accepts a flat options object with `actions` split by capability (`local`
 * vs `server`), `derived` computed properties (aliased to `computed`), and a
 * `style` contract — then lowers them all to the runtime's
 * `ServerComponentDefinition` shape exactly once.
 *
 * Both infer the component's actions and derived map, so `render`'s tools take
 * only declared action names (args typed by the action) and `derived(name)`
 * returns the property's type. `defineLiveComponent(name, stateSchema)` fixes
 * the state type before the options are checked: inside one options object a
 * nested generic call such as `serverAction({ run(state) {…} })` is checked
 * before `stateSchema` has been inferred, so only the schema-first form types
 * its `state`. Compiled `.jsails` live components are emitted in that form.
 *
 * All validation is delegated to `defineServerComponent`; this module adds no
 * new validation beyond the lower steps (which reject malformed authoring-layer
 * shapes before they reach the runtime).
 */

import { z } from 'zod';

import type { RenderChild } from '../../contracts/component.js';
import type { RequestContext } from '../../contracts/http.js';
import type {
  ServerComponentComputed,
  ServerComponentComputedValue,
  ServerComponentDefinition,
  ServerComponentRenderTools,
  ServerComponentState,
  ServerComponentStaticRender,
  ServerComponentUploadPolicy,
} from '../component.js';
import { defineServerComponent } from '../component.js';
import { lowerActions, type LocalAction, type ServerAction } from './actions.js';
import type { StyleContract } from './style.js';
import type { Awaitable } from '../../contracts/awaitable.js';

// ---------------------------------------------------------------------------
// Authoring render tools
// ---------------------------------------------------------------------------

/**
 * The actions a component may declare: local or server, keyed by name.
 *
 * @public
 */
export type AuthoringActionMap<State extends ServerComponentState> = Readonly<
  Record<string, LocalAction<State, any> | ServerAction<State, any>>
>;

/**
 * The derived (computed) properties a component may declare, keyed by name.
 *
 * @public
 */
export type AuthoringDerivedMap<State extends ServerComponentState> = Readonly<
  Record<string, ServerComponentComputed<State>>
>;

/**
 * Render tools threaded into a `defineComponent` render function.
 *
 * Extends the runtime's `ServerComponentRenderTools` with `derived(name)`, a
 * convenience alias for `tools.computed(name)` so the author surface uses the
 * same `derived` term as the options block.
 */
export type AuthoringRenderTools<
  State extends ServerComponentState,
  Actions = Readonly<Record<string, unknown>>,
  Derived = AuthoringDerivedMap<State>,
> = ServerComponentRenderTools<State, Actions, Derived> & {
  readonly derived: <K extends keyof Derived & string>(
    name: K,
  ) => ServerComponentComputedValue<Derived[K]>;
};

// ---------------------------------------------------------------------------
// DefineComponent options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link defineComponent}. `Actions` and `Derived` are
 * inferred from `actions` and `derived`; each is intersected with its map
 * type over `NoInfer<State>`, which is what types a `run(state)` and a
 * derived `(state) => …` from `stateSchema`.
 */
export interface DefineComponentOptions<
  State extends ServerComponentState,
  Actions = AuthoringActionMap<State>,
  Derived = AuthoringDerivedMap<State>,
> extends LiveComponentOptions<State, Actions, Derived> {
  readonly name: string;
  readonly stateSchema: z.ZodType<State>;
}

/**
 * The options of a {@link defineLiveComponent} component: everything
 * {@link DefineComponentOptions} takes except the name and the state schema,
 * which come first.
 *
 * @public
 */
export interface LiveComponentOptions<
  State extends ServerComponentState,
  Actions = AuthoringActionMap<State>,
  Derived = AuthoringDerivedMap<State>,
> {
  readonly writableKeys?: readonly (keyof State & string)[];
  readonly actions?: Actions & AuthoringActionMap<NoInfer<State>>;
  readonly derived?: Derived & AuthoringDerivedMap<NoInfer<State>>;
  readonly style?: StyleContract;
  readonly urlBinding?: readonly string[];
  readonly uploads?: ServerComponentUploadPolicy;
  initialState(context: RequestContext): Awaitable<State>;
  authorize(context: RequestContext): Awaitable<boolean>;
  hydrate?(state: State, context: RequestContext): Awaitable<void>;
  updating?(state: State, context: RequestContext): Awaitable<void>;
  updated?(state: State, context: RequestContext): Awaitable<void>;
  mount?(context: RequestContext): Awaitable<void>;
  render(
    state: State,
    tools: AuthoringRenderTools<State, Actions, Derived>,
  ): Awaitable<RenderChild>;
  staticFallback?(context: RequestContext): Awaitable<RenderChild>;
  /** See `ServerComponentDefinition.staticRender`. */
  readonly staticRender?: ServerComponentStaticRender;
}

// ---------------------------------------------------------------------------
// defineComponent
// ---------------------------------------------------------------------------

/**
 * Define a server component from the friendly authoring surface, lowering
 * `actions` (split by capability), `derived` (→ `computed`), and `style`
 * onto `defineServerComponent`.
 *
 * The returned definition carries `style` as an own key outside the
 * `ServerComponentDefinition` interface so the contract stays reachable from
 * the definition; it survives the `{ ...definition }` spread in
 * `defineServerComponent`, and the runtime never reads it.
 */
export function defineComponent<
  State extends ServerComponentState,
  Actions = AuthoringActionMap<State>,
  Derived = AuthoringDerivedMap<State>,
>(options: DefineComponentOptions<State, Actions, Derived>): ServerComponentDefinition<State> {
  const loweredActions =
    options.actions !== undefined
      ? lowerActions(options.actions as AuthoringActionMap<State>)
      : undefined;

  // The runtime's `computed(name)` stays available; `derived(name)` is the alias
  // matching the options block's term. A missing `render` is left for
  // `defineServerComponent` to reject.
  const render = options.render as
    ((state: State, tools: AuthoringRenderTools<State>) => Awaitable<RenderChild>) | undefined;
  const loweredRender =
    typeof render === 'function'
      ? (state: State, tools: ServerComponentRenderTools<State>) =>
          render(state, { ...tools, derived: (name) => tools.computed(name) })
      : undefined;

  const lowered: Record<string, unknown> = {
    name: options.name,
    stateSchema: options.stateSchema,
    initialState: options.initialState,
    authorize: options.authorize,
    render: loweredRender,
    ...(options.writableKeys !== undefined ? { writableKeys: options.writableKeys } : {}),
    ...(loweredActions !== undefined ? { actions: loweredActions } : {}),
    // `derived` is the runtime's `computed` under the author-facing name.
    ...(options.derived !== undefined ? { computed: options.derived } : {}),
    ...(options.urlBinding !== undefined ? { urlBinding: options.urlBinding } : {}),
    ...(options.uploads !== undefined ? { uploads: options.uploads } : {}),
    ...(options.hydrate !== undefined ? { hydrate: options.hydrate } : {}),
    ...(options.updating !== undefined ? { updating: options.updating } : {}),
    ...(options.updated !== undefined ? { updated: options.updated } : {}),
    ...(options.mount !== undefined ? { mount: options.mount } : {}),
    ...(options.staticFallback !== undefined ? { staticFallback: options.staticFallback } : {}),
    ...(options.staticRender !== undefined ? { staticRender: options.staticRender } : {}),
    // Not part of `ServerComponentDefinition`; the cast below lets it ride
    // through `defineServerComponent`'s `{ ...definition }` spread.
    ...(options.style !== undefined ? { style: options.style } : {}),
  };

  // `defineServerComponent` validates and normalizes — do not re-implement.
  return defineServerComponent(lowered as unknown as ServerComponentDefinition<State>);
}

/**
 * Define a server component whose name and state schema come first:
 * `defineLiveComponent('task-list', stateSchema)({ initialState, authorize,
 * actions, derived, render })`. The state type is fixed by the schema before
 * the options are checked, so `serverAction({ run(state, args) {…} })`,
 * derived functions and `render` are all typed from it, and `render`'s tools
 * know the declared actions and derived properties.
 *
 * Compiled `.jsails` live components are emitted in this form, with the
 * component's path-derived id as `name`.
 *
 * @public
 */
export function defineLiveComponent<State extends ServerComponentState>(
  name: string,
  stateSchema: z.ZodType<State>,
): <Actions = Record<never, never>, Derived = Record<never, never>>(
  options: LiveComponentOptions<State, Actions, Derived>,
) => ServerComponentDefinition<State> {
  return (options) => defineComponent({ ...options, name, stateSchema });
}
