/**
 * `defineComponent` — the author-facing component API, lowered onto the
 * `defineServerComponent` primitive.
 *
 * It accepts a flat options object with `actions` split by capability (`local`
 * vs `server`), `derived` computed properties (aliased to `computed`), and a
 * `style` contract — then lowers them all to the runtime's
 * `ServerComponentDefinition` shape exactly once.
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
  ServerComponentDefinition,
  ServerComponentRenderTools,
  ServerComponentState,
} from '../component.js';
import { defineServerComponent } from '../component.js';
import { lowerActions, type LocalAction, type ServerAction } from './actions.js';
import type { StyleContract } from './style.js';
import type { Awaitable } from '../../contracts/awaitable.js';

// ---------------------------------------------------------------------------
// Authoring render tools
// ---------------------------------------------------------------------------

/**
 * Render tools threaded into a `defineComponent` render function.
 *
 * Extends the runtime's `ServerComponentRenderTools` with `derived(name)`, a
 * convenience alias for `tools.computed(name)` so the author surface uses the
 * same `derived` term as the options block.
 */
export type AuthoringRenderTools<State extends ServerComponentState> =
  ServerComponentRenderTools<State> & {
    readonly derived: (name: string) => unknown;
  };

// ---------------------------------------------------------------------------
// DefineComponent options
// ---------------------------------------------------------------------------

/** Options accepted by {@link defineComponent}. */
export interface DefineComponentOptions<State extends ServerComponentState> {
  readonly name: string;
  readonly stateSchema: z.ZodType<State>;
  readonly writableKeys?: readonly (keyof State & string)[];
  readonly actions?: Readonly<
    Record<string, LocalAction<NoInfer<State>, any> | ServerAction<NoInfer<State>, any>>
  >;
  readonly derived?: Readonly<Record<string, ServerComponentComputed<NoInfer<State>>>>;
  readonly style?: StyleContract;
  readonly urlBinding?: readonly string[];
  initialState(context: RequestContext): Awaitable<State>;
  authorize(context: RequestContext): Awaitable<boolean>;
  hydrate?(state: State, context: RequestContext): Awaitable<void>;
  updating?(state: State, context: RequestContext): Awaitable<void>;
  updated?(state: State, context: RequestContext): Awaitable<void>;
  mount?(context: RequestContext): Awaitable<void>;
  render(state: State, tools: AuthoringRenderTools<State>): Awaitable<RenderChild>;
  staticFallback?(context: RequestContext): Awaitable<RenderChild>;
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
export function defineComponent<State extends ServerComponentState>(
  options: DefineComponentOptions<State>,
): ServerComponentDefinition<State> {
  const loweredActions = options.actions !== undefined ? lowerActions(options.actions) : undefined;

  // The runtime's `computed(name)` stays available; `derived(name)` is the alias
  // matching the options block's term. A missing `render` is left for
  // `defineServerComponent` to reject.
  const loweredRender =
    typeof options.render === 'function'
      ? (state: State, tools: ServerComponentRenderTools<State>) =>
          options.render(state, { ...tools, derived: (name) => tools.computed(name) })
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
    ...(options.hydrate !== undefined ? { hydrate: options.hydrate } : {}),
    ...(options.updating !== undefined ? { updating: options.updating } : {}),
    ...(options.updated !== undefined ? { updated: options.updated } : {}),
    ...(options.mount !== undefined ? { mount: options.mount } : {}),
    ...(options.staticFallback !== undefined ? { staticFallback: options.staticFallback } : {}),
    // Not part of `ServerComponentDefinition`; the cast below lets it ride
    // through `defineServerComponent`'s `{ ...definition }` spread.
    ...(options.style !== undefined ? { style: options.style } : {}),
  };

  // `defineServerComponent` validates and normalizes — do not re-implement.
  return defineServerComponent(lowered as unknown as ServerComponentDefinition<State>);
}
