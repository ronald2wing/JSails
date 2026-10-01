/**
 * Server component definition: the author-facing contract for a stateful,
 * server-rendered component with server actions.
 *
 * A server component is a plain definition object, not a class or decorator:
 * `defineServerComponent` validates it and `defineAction` preserves per-action
 * input typing. Nothing here opens a connection, mutates the author's object in
 * place, or executes any component callback — validation is structural, and
 * `initialState` / `authorize` / `run` / `render` / `staticFallback` are all
 * deferred to the runtime that consumes the definition.
 *
 * State is declared with `stateSchema` (a Zod object schema), which is the
 * single source of truth for what a component may persist; it is forced
 * `.strict()` so no undeclared field survives a client round-trip (an app
 * secret is never auto-serialized beyond the declared schema). `writableKeys`
 * names the top-level fields a CLIENT update may set — defaulting to none — and
 * each must be a real top-level schema field. This restricts client edits only:
 * actions run server-side and may change any schema-valid field regardless of
 * `writableKeys`.
 *
 * Action input is a separate args object from state, never an assumed
 * `FormData` mapping: `defineAction` declares the args schema and the runtime
 * hands `run(state, args, context)` exactly those parsed args.
 *
 * This module is foundation only. It carries no transport, no renderer, and no
 * persistence: the `bind` / `call` / `submit` helpers it threads into `render`
 * are typed contracts whose implementations the runtime provides, and it holds
 * no store, token, or HMAC logic.
 */

import { z } from 'zod';
import { RedirectErrors, sameOriginLocation } from '../url/redirect-target.js';

import type { RenderChild } from '../contracts/component.js';
import type { JsonObject, JsonValue, RequestContext } from '../contracts/http.js';
import type { ServerComponentDownload } from './downloads.js';
import type { ComponentPollOptions } from './protocol.js';
import { isRecord } from '../json/shape.js';
import { JsailsError } from '../errors/jsails-error.js';
import type { Awaitable } from '../contracts/awaitable.js';

/** The state a server component operates on: a JSON-compatible plain object. */
export type ServerComponentState = JsonObject;

/**
 * Attributes `bind(name)` returns for spreading onto a model-bound element.
 *
 * `data-jsails-model` names the top-level state field the element binds to; the
 * runtime reads the element's initial value from that field and writes client
 * edits back to it (only when the field is in `writableKeys`).
 */
export interface ServerComponentModelAttrs {
  readonly 'data-jsails-model': string;
  /** Present when `bind(name, { debounceMs })` requests client-side debounce. */
  readonly 'data-jsails-debounce'?: string;
  /** Present when `bind(name, { trim: true })` trims the control's text value. */
  readonly 'data-jsails-trim'?: string;
  /** Present when `bind(name, { number: true })` reads a numeric text as a number. */
  readonly 'data-jsails-number'?: string;
  /** Present when `bind(name, { lazy: true })` takes the value on `change` only. */
  readonly 'data-jsails-lazy'?: string;
  /** Bounded JSON validation rules derived from the field's Zod schema. */
  readonly 'data-jsails-rules'?: string;
}

/**
 * Options accepted by `bind(name, options?)`: how the client reads the
 * control's value into the field. Each is applied in the browser only; the
 * server validates the field against `stateSchema` whatever arrives.
 */
export interface ServerComponentBindOptions {
  /** Debounce window, in milliseconds, before the client flushes the edit. */
  readonly debounceMs?: number;
  /** Trim leading and trailing whitespace from a text value. */
  readonly trim?: boolean;
  /** Read a text value that is a finite number as that number; any other text stays text. */
  readonly number?: boolean;
  /** Take the value when the control commits it (`change`), not on every `input`. */
  readonly lazy?: boolean;
}

/** Options accepted by `poll(options)` for a root-level poll marker. */
export type ServerComponentPollOptions = ComponentPollOptions;

/** Attributes `poll(options)` returns for spreading onto a component root. */
export interface ServerComponentPollAttrs {
  readonly 'data-jsails-poll': string;
}

/** Attributes `call(action, args?)` returns for spreading onto an action trigger. */
export interface ServerComponentCallAttrs {
  readonly 'data-jsails-call': string;
  readonly 'data-jsails-args'?: string;
}

/**
 * Attributes `submit(action, args?)` returns for spreading onto a `<form>`.
 * `method` is `dialog`, so the form cannot navigate before the client runtime
 * loads (a dialog-method form outside a `<dialog>` submits nowhere), and
 * `data-turbo` is `false`, so Turbo never claims it; the runtime dispatches the
 * action instead.
 */
export interface ServerComponentSubmitAttrs {
  readonly 'data-jsails-submit': string;
  readonly 'data-jsails-args'?: string;
  readonly method: 'dialog';
  readonly 'data-turbo': false;
}

/**
 * A computed property: a derived, read-only view value resolved at render time.
 *
 * Computed values are never part of persisted state and never client-writable:
 * they are derived from the current state (and request context) each render and
 * exposed to `render` through `tools.computed(name)`. The result may be any
 * renderable value, including a Promise for async derivation; it is memoized per
 * render so multiple accesses evaluate the function once.
 *
 * @public
 */
export type ServerComponentComputed<State extends ServerComponentState = ServerComponentState> = (
  state: State,
  context: RequestContext,
) => unknown;

/**
 * The args an action declares: the second parameter of its `run`, or any JSON
 * value when the action's type does not say (an untyped actions map).
 *
 * @public
 */
export type ServerComponentActionArgs<A> = A extends {
  run(state: never, args: infer I, ...rest: never[]): unknown;
}
  ? unknown extends I
    ? JsonValue
    : I
  : JsonValue;

/**
 * The value a computed property resolves to: its function's result, or
 * `unknown` when the computed map's type does not say.
 *
 * @public
 */
export type ServerComponentComputedValue<C> = C extends (...args: never[]) => infer R ? R : unknown;

/**
 * Render tools threaded into `render` alongside the current state.
 *
 * `bind`, `call`, and `submit` are the runtime's serialization helpers: they
 * return attribute maps to spread onto elements rather than rendering the
 * transport themselves. `errors` maps form field names to validation messages
 * (empty when the render is not the result of a rejected submission); `values`
 * holds the raw submitted string values for repopulation; `context` is the live
 * request context. `computed(name)` resolves a declared {@link ServerComponentComputed}
 * to its current value (read-only, never persisted).
 *
 * `Actions` and `Computed` are the component's actions and computed maps:
 * when they are known (`defineLiveComponent`, or `defineComponent` inferring
 * them), `call`, `submit` and `intersect` take only declared action names,
 * `call` and `submit` type their args by the action, and `computed` returns
 * the property's own type. Their defaults accept any name, as an untyped
 * definition does.
 */
export interface ServerComponentRenderTools<
  State extends ServerComponentState = ServerComponentState,
  Actions = Readonly<Record<string, unknown>>,
  Computed = Readonly<Record<string, ServerComponentComputed<State>>>,
> {
  readonly bind: (
    name: keyof State & string,
    options?: ServerComponentBindOptions,
  ) => ServerComponentModelAttrs;
  readonly call: <K extends keyof Actions & string>(
    action: K,
    args?: ServerComponentActionArgs<Actions[K]>,
  ) => ServerComponentCallAttrs;
  readonly submit: <K extends keyof Actions & string>(
    action: K,
    args?: ServerComponentActionArgs<Actions[K]>,
  ) => ServerComponentSubmitAttrs;
  readonly poll: (options: ServerComponentPollOptions) => ServerComponentPollAttrs;
  readonly confirm: (message: string) => Record<string, string>;
  /**
   * Mark a loading indicator: the element the selector names inside this
   * component, or, without a selector, the element the attributes are spread on.
   */
  readonly loadingTarget: (target?: string) => Record<string, string>;
  readonly show: (field: string) => Record<string, string>;
  readonly text: (field: string) => Record<string, string>;
  readonly sort: (field: string) => Record<string, string>;
  readonly intersect: (action: keyof Actions & string) => Record<string, string>;
  readonly ref: (name: string) => Record<string, string>;
  readonly ignore: () => Record<string, string>;
  readonly computed: <K extends keyof Computed & string>(
    name: K,
  ) => ServerComponentComputedValue<Computed[K]>;
  readonly errors: Readonly<Record<string, string | undefined>>;
  readonly values: Readonly<Record<string, string>>;
  readonly context: RequestContext;
}

/** The validated input type of an action: the schema's inferred type, or `undefined` when no schema. */
export type ServerComponentActionInput<I> =
  I extends z.ZodObject<z.ZodRawShape> ? z.infer<I> : undefined;

/**
 * A single server action.
 *
 * `input` declares the args schema (a Zod object); args are separate from
 * component state and are never derived from an assumed `FormData` shape.
 * `authorize` optionally further restricts the action for this request beyond
 * the component-level policy; when it returns anything but `true` (or when it
 * is absent) the runtime denies. `run` mutates the request-local `state` clone
 * in place; returning a {@link ServerComponentRedirect} signals a client-side
 * navigation after the render is applied, and `undefined`/`void` means no
 * redirect.
 */
export interface ServerComponentAction<State, Input> {
  readonly input?: z.ZodObject<z.ZodRawShape>;
  authorize?(context: RequestContext, state: State, input: Input): Awaitable<boolean>;
  run(
    state: State,
    input: Input,
    context: ServerComponentActionContext,
  ): Awaitable<void | ServerComponentRedirect | ServerComponentDownload>;
}

/**
 * The context an action's `run` receives: the request context plus the calls
 * that ask the client to refresh nested children once this update's render is
 * applied. A parent never re-renders a child it keeps; a child whose data the
 * action changed is refreshed by the client, each with the child's own token.
 * `refreshChild(key)` names a child rendered with that `key`;
 * `refreshChildren()` names every child this render keeps. A name that the
 * render does not keep is dropped (a child mounted by this render is already
 * fresh).
 *
 * @public
 */
export interface ServerComponentActionContext extends RequestContext {
  refreshChild(key: string): void;
  refreshChildren(): void;
}

/**
 * A component's opt-in to file uploads. Without it the upload endpoint refuses
 * every file for the component, even when the plugin configures uploads. The
 * limits can only narrow the plugin-wide ones.
 */
export interface ServerComponentUploadPolicy {
  /** Per-file byte cap for this component; the plugin cap still applies. */
  readonly maxBytes?: number;
  /** Content types this component accepts; intersected with the plugin allowlist. */
  readonly contentTypes?: readonly string[];
  /**
   * Accept uploads from visitors without a session, within this component's
   * own quota. Omitted means an anonymous upload is answered `forbidden`.
   */
  readonly anonymous?: ServerComponentAnonymousUploads;
}

/**
 * The quota a component sets for its anonymous uploads. Every anonymous
 * visitor shares it, so it bounds what all of them together may stage for this
 * component within the one-hour upload reference lifetime; the store's shared
 * anonymous quota still applies on top. It is counted per process.
 */
export interface ServerComponentAnonymousUploads {
  /** Bytes all anonymous uploads to this component may stage within the window. */
  readonly maxBytes: number;
  /** Files all anonymous uploads to this component may stage within the window. */
  readonly maxFiles: number;
  /** Anonymous uploads to this component in progress at once. Defaults to 2. */
  readonly maxConcurrent?: number;
}

/**
 * A validated server component definition.
 *
 * `stateSchema` declares the persisted state shape and is REQUIRED; the runtime
 * derives `State` from it. `writableKeys` restricts which top-level fields a
 * CLIENT update may set (defaulting to none). `authorize` is REQUIRED and is the
 * explicit access policy — there is no implicit-public default. `initialState`
 * produces the schema-valid state (async allowed). `actions` is keyed by action
 * name. `render` renders the state. A static export renders the component's
 * static form instead: `staticFallback`, the no-state render, or, with
 * `staticRender: 'initial'`, `render` itself over `initialState` with inert
 * tools; a component with neither fails the export.
 */
export interface ServerComponentDefinition<
  State extends ServerComponentState = ServerComponentState,
> {
  readonly name: string;
  readonly stateSchema: z.ZodType<State>;
  readonly writableKeys?: readonly (keyof State & string)[];
  /**
   * Top-level state field names seeded from the request URL's query string on
   * the first (mount) render only. Each entry names a field whose value is
   * read from `?<name>=<value>`, coerced to the field's declared Zod type, and
   * overlaid onto initialState before the schema parse. Subsequent updates
   * reconstruct state only from the signed snapshot — the URL is never re-read
   * after mount. Declare this for read-only URL seeding (Livewire `$queryString`
   * equivalent, scoped down); never for write-back URL manipulation.
   */
  readonly urlBinding?: readonly string[];
  /**
   * Accept file uploads for this component (see
   * {@link ServerComponentUploadPolicy}). Omitted means the upload endpoint
   * answers `forbidden` for this component.
   */
  readonly uploads?: ServerComponentUploadPolicy;
  initialState(context: RequestContext): Awaitable<State>;
  authorize(context: RequestContext): Awaitable<boolean>;
  // NoInfer stops the actions record from widening `State` back to `JsonObject`
  // during inference, so `State` is derived from `stateSchema` alone.
  readonly actions?: Readonly<Record<string, ServerComponentAction<NoInfer<State>, any>>>;
  /**
   * Lifecycle hooks, all optional and awaited in order. `hydrate` runs after a
   * snapshot is verified and before any client edit (server-side rehydration of
   * the reconstructed state); `updating` runs before client edits are applied
   * and may throw a value-free error to reject the update; `updated` runs after
   * a successful update or action, before the re-render; `mount` runs once on
   * the first (live) server render. Hooks receive the mutable server-side state
   * (except `mount`, which receives only the context) and may mutate it in place.
   */
  hydrate?(state: State, context: RequestContext): Awaitable<void>;
  updating?(state: State, context: RequestContext): Awaitable<void>;
  updated?(state: State, context: RequestContext): Awaitable<void>;
  mount?(context: RequestContext): Awaitable<void>;
  /**
   * Computed properties keyed by name. Each function derives a read-only view
   * value from the current state and request context at render time; names must
   * not collide with a top-level state field (rejected at definition time).
   * `NoInfer` keeps `State` derived from `stateSchema` alone, matching `actions`.
   */
  readonly computed?: Readonly<Record<string, ServerComponentComputed<NoInfer<State>>>>;
  render(state: State, tools: ServerComponentRenderTools<State>): Awaitable<RenderChild>;
  staticFallback?(context: RequestContext): Awaitable<RenderChild>;
  /**
   * `'initial'` lets a static export render this component's own `render`
   * from `initialState(context)`, with inert tools (no snapshot, signing,
   * instance id, `mount` hook or action markers), when `authorize(context)`
   * returns exactly `true` for the static context. Exclusive with
   * `staticFallback`; omitted, a component without a fallback fails the export.
   */
  readonly staticRender?: ServerComponentStaticRender;
}

/**
 * How a static export may render a component without a `staticFallback`.
 *
 * @public
 */
export type ServerComponentStaticRender = 'initial';

/** Stable codes carried by a {@link ServerComponentDefinitionError}. */
export type ServerComponentDefinitionErrorCode =
  'invalid_definition' | 'invalid_action' | 'invalid_computed' | 'invalid_writable';

/** Raised when a definition fails structural validation. Messages are value-free. */
export class ServerComponentDefinitionError extends JsailsError {
  constructor(
    readonly code: ServerComponentDefinitionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------------
// Action redirect
// ---------------------------------------------------------------------------

/**
 * The value a server-component action returns to signal a client-side
 * navigation. The runtime carries the target URL in the update response; the
 * client applies the render, then navigates (via Turbo soft-navigation when
 * available, or `location.assign` as a fallback).
 *
 * A structural discriminator (`__jsailsRedirect: true`) matches the other
 * reserved-key payload guards in this framework (`isChainDescriptor`,
 * `isBatchDescriptor`, `isOverlapDescriptor`). A Symbol brand is unnecessary:
 * the runtime reads only the direct return value of the trusted `run` function
 * (producer code, not client input), so the discriminator is a type-level
 * narrowing aid, never a security boundary.
 */
export interface ServerComponentRedirect {
  readonly __jsailsRedirect: true;
  /** The navigation target URL, validated server-side. */
  readonly url: string;
}

/**
 * Structural guard: the value is a {@link ServerComponentRedirect} produced by
 * {@link redirect}. Read-only detection, never a spoofing boundary — the
 * runtime's input is the action's own return value (trusted producer code).
 */
export function isRedirect(value: unknown): value is ServerComponentRedirect {
  if (!isRecord(value)) {
    return false;
  }
  return (value as { __jsailsRedirect?: unknown }).__jsailsRedirect === true;
}

/**
 * Signal a client-side navigation from a server-component action.
 *
 * The target is a same-origin path (`/dashboard`), with characters outside
 * visible ASCII percent-encoded: the rule `Respond.redirect` applies.
 * Anything else (an absolute URL, a `javascript:` or `data:` URL, a
 * protocol-relative `//host`, a backslash, a control character) is a
 * value-free `redirect.invalid_target` error, raised eagerly, so an action
 * cannot be turned into an open redirect by state a client sent. A target
 * that came with the request goes through `safeRedirectPath` first. The
 * returned value is a signal to the runtime; it carries no transport logic.
 */
export function redirect(url: string): ServerComponentRedirect {
  const target = sameOriginLocation(url);
  if (target === undefined) throw new RedirectErrors.Error('invalid_target');
  return { __jsailsRedirect: true, url: target };
}

/**
 * Define one action, preserving the input schema's inferred type for `run` and
 * `authorize`.
 *
 * This helper exists for inference: writing the action inline would type the
 * `input` parameter as `any`. `State` is inferred from the component when the
 * definition is given an explicit state type (either `defineServerComponent<S>`
 * or a concretely-typed `stateSchema`); otherwise it widens to the component's
 * state type through the definition's own inference.
 */
export function defineAction<
  State extends ServerComponentState,
  const I extends z.ZodObject<z.ZodRawShape> | undefined = undefined,
>(definition: {
  input?: I;
  authorize?(
    context: RequestContext,
    state: State,
    input: ServerComponentActionInput<I>,
  ): Awaitable<boolean>;
  run(
    state: State,
    input: ServerComponentActionInput<I>,
    context: ServerComponentActionContext,
  ): Awaitable<void | ServerComponentRedirect | ServerComponentDownload>;
}): ServerComponentAction<State, ServerComponentActionInput<I>> {
  return Object.freeze(definition);
}

/** Validate and normalize a definition, forcing strict state and input schemas. */
export function defineServerComponent<State extends ServerComponentState>(
  definition: ServerComponentDefinition<State>,
): ServerComponentDefinition<State> {
  validateDefinition(definition);
  const stateSchema = normalizeStateSchema(definition.stateSchema);
  const writableKeys = normalizeWritableKeys(definition.stateSchema, definition.writableKeys);
  const actions = definition.actions;
  const computed = normalizeComputed(definition.stateSchema, definition.computed);
  return Object.freeze({
    ...definition,
    stateSchema,
    writableKeys,
    ...(actions === undefined ? {} : { actions: normalizeActions(actions) }),
    ...(computed === undefined ? {} : { computed }),
  });
}

function validateDefinition(definition: ServerComponentDefinition<any>): void {
  if (!isRecord(definition)) {
    throw new ServerComponentDefinitionError(
      'invalid_definition',
      'server component definition must be an object',
    );
  }
  if (typeof definition.name !== 'string' || definition.name.trim() === '') {
    throw new ServerComponentDefinitionError(
      'invalid_definition',
      'component name must be a non-empty string',
    );
  }
  if (!(definition.stateSchema instanceof z.ZodObject)) {
    throw new ServerComponentDefinitionError(
      'invalid_definition',
      'component must define a stateSchema as a Zod object schema',
    );
  }
  if (typeof definition.initialState !== 'function') {
    throw new ServerComponentDefinitionError(
      'invalid_definition',
      'component must define an initialState function',
    );
  }
  if (typeof definition.authorize !== 'function') {
    throw new ServerComponentDefinitionError(
      'invalid_definition',
      'component must define an authorize function',
    );
  }
  if (typeof definition.render !== 'function') {
    throw new ServerComponentDefinitionError(
      'invalid_definition',
      'component must define a render function',
    );
  }
  if (definition.staticFallback !== undefined && typeof definition.staticFallback !== 'function') {
    throw new ServerComponentDefinitionError(
      'invalid_definition',
      'staticFallback must be a function when present',
    );
  }
  if (definition.staticRender !== undefined) {
    if (definition.staticRender !== 'initial') {
      throw new ServerComponentDefinitionError(
        'invalid_definition',
        "staticRender must be 'initial' when present",
      );
    }
    if (definition.staticFallback !== undefined) {
      throw new ServerComponentDefinitionError(
        'invalid_definition',
        'staticRender and staticFallback are exclusive static forms',
      );
    }
  }
  // urlBinding, when declared, must be a non-empty array of non-empty strings.
  // Duplicate field names are tolerated (Set semantics dedupe in the runtime).
  if (definition.urlBinding !== undefined) {
    if (!Array.isArray(definition.urlBinding) || definition.urlBinding.length === 0) {
      throw new ServerComponentDefinitionError(
        'invalid_definition',
        'urlBinding must be a non-empty array of field names',
      );
    }
    for (let i = 0; i < definition.urlBinding.length; i++) {
      const field = definition.urlBinding[i];
      if (typeof field !== 'string' || field.trim() === '') {
        throw new ServerComponentDefinitionError(
          'invalid_definition',
          'urlBinding must contain only non-empty string field names',
        );
      }
    }
  }
  if (definition.uploads !== undefined) {
    validateUploadPolicy(definition.uploads);
  }
  // Lifecycle hooks are optional; when declared they must be callable.
  for (const hook of ['hydrate', 'updating', 'updated', 'mount'] as const) {
    if (definition[hook] !== undefined && typeof definition[hook] !== 'function') {
      throw new ServerComponentDefinitionError(
        'invalid_definition',
        `${hook} must be a function when present`,
      );
    }
  }
}

function validateUploadPolicy(policy: unknown): void {
  if (!isRecord(policy)) {
    throw new ServerComponentDefinitionError(
      'invalid_definition',
      'uploads must be an object when present',
    );
  }
  const { maxBytes, contentTypes, anonymous } = policy;
  if (anonymous !== undefined) {
    validateAnonymousUploads(anonymous);
  }
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || (maxBytes as number) <= 0)) {
    throw new ServerComponentDefinitionError(
      'invalid_definition',
      'uploads.maxBytes must be a positive integer',
    );
  }
  if (
    contentTypes !== undefined &&
    (!Array.isArray(contentTypes) ||
      contentTypes.length === 0 ||
      contentTypes.some((type) => typeof type !== 'string' || type.trim() === ''))
  ) {
    throw new ServerComponentDefinitionError(
      'invalid_definition',
      'uploads.contentTypes must be a non-empty array of media types',
    );
  }
}

function validateAnonymousUploads(anonymous: unknown): void {
  const isPositive = (value: unknown): boolean =>
    Number.isSafeInteger(value) && (value as number) > 0;
  if (
    !isRecord(anonymous) ||
    !isPositive(anonymous.maxBytes) ||
    !isPositive(anonymous.maxFiles) ||
    (anonymous.maxConcurrent !== undefined && !isPositive(anonymous.maxConcurrent))
  ) {
    throw new ServerComponentDefinitionError(
      'invalid_definition',
      'uploads.anonymous needs positive integer maxBytes and maxFiles (and maxConcurrent when set)',
    );
  }
}

/**
 * Force the state schema `.strict()`. `.strict()` is idempotent and preserves
 * the output type, so re-typing the normalized object as `z.ZodType<State>`
 * keeps `State` unchanged; the caller has already validated it is a ZodObject.
 */
function normalizeStateSchema<State extends ServerComponentState>(
  schema: z.ZodType<State>,
): z.ZodType<State> {
  return (schema as z.ZodObject<z.ZodRawShape>).strict() as z.ZodType<State>;
}

/**
 * Validate `writableKeys` against the schema's top-level shape and return a
 * frozen copy (an empty frozen array when omitted, so the no-write default is
 * locked in place).
 */
function normalizeWritableKeys<State extends ServerComponentState>(
  schema: z.ZodType<State>,
  keys: readonly (keyof State & string)[] | undefined,
): readonly (keyof State & string)[] {
  if (keys === undefined) {
    return Object.freeze([]);
  }
  const known = Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape);
  for (const key of keys) {
    validateWritableKey(key, known);
  }
  return Object.freeze([...keys]);
}

function validateWritableKey(key: string, known: readonly string[]): void {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ServerComponentDefinitionError(
      'invalid_writable',
      'writable key must be a non-empty string',
    );
  }
  // `key in Object.prototype` catches `__proto__`, `constructor`, and every
  // other inherited property; a writable key must be an own schema field.
  if (key in Object.prototype) {
    throw new ServerComponentDefinitionError(
      'invalid_writable',
      'writable key must not shadow an inherited object property',
    );
  }
  if (!known.includes(key)) {
    throw new ServerComponentDefinitionError(
      'invalid_writable',
      'writable key must be a top-level state schema field',
    );
  }
}

function normalizeActions(
  actions: Readonly<Record<string, ServerComponentAction<any, any>>>,
): Readonly<Record<string, ServerComponentAction<any, any>>> {
  // A `__proto__` key in an object literal sets the prototype rather than adding
  // an own key, silently dropping the action; reject that shape up front.
  const prototype = Object.getPrototypeOf(actions);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ServerComponentDefinitionError(
      'invalid_action',
      'actions must be a plain object literal',
    );
  }

  const normalized: Record<string, ServerComponentAction<any, any>> = {};
  for (const [name, action] of Object.entries(actions)) {
    validateActionName(name);
    normalized[name] = normalizeAction(action);
  }
  return normalized;
}

function validateActionName(name: string): void {
  if (name.trim() === '') {
    throw new ServerComponentDefinitionError(
      'invalid_action',
      'action name must be a non-empty string',
    );
  }
  if (name in Object.prototype) {
    throw new ServerComponentDefinitionError(
      'invalid_action',
      'action name must not shadow an inherited object property',
    );
  }
}

function normalizeAction(action: ServerComponentAction<any, any>): ServerComponentAction<any, any> {
  if (!isRecord(action)) {
    throw new ServerComponentDefinitionError('invalid_action', 'action must be an object');
  }
  if (typeof action.run !== 'function') {
    throw new ServerComponentDefinitionError('invalid_action', 'action must define a run function');
  }
  if (action.authorize !== undefined && typeof action.authorize !== 'function') {
    throw new ServerComponentDefinitionError(
      'invalid_action',
      'action authorize must be a function when present',
    );
  }
  if (action.input === undefined) {
    return action;
  }
  if (!(action.input instanceof z.ZodObject)) {
    throw new ServerComponentDefinitionError(
      'invalid_action',
      'action input must be a Zod object schema',
    );
  }
  // Force strict: unknown keys are rejected regardless of the author's schema
  // mode, so attacker-supplied fields never slip through a strip/passthrough
  // schema. `.strict()` is idempotent and preserves the output type.
  return { ...action, input: action.input.strict() };
}

/**
 * Validate and normalize the `computed` map. Each name must be a non-empty,
 * non-inherited key that does not collide with a top-level state field, and each
 * entry must be a function. Returns `undefined` when omitted (so a definition
 * without computed properties stays absent, matching the pre-computed shape).
 */
function normalizeComputed(
  schema: z.ZodTypeAny,
  computed: Readonly<Record<string, ServerComponentComputed<any>>> | undefined,
): Readonly<Record<string, ServerComponentComputed<any>>> | undefined {
  if (computed === undefined) {
    return undefined;
  }
  // A `__proto__` key in an object literal sets the prototype rather than adding
  // an own key, silently dropping the entry; reject that shape up front.
  const prototype = Object.getPrototypeOf(computed);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ServerComponentDefinitionError(
      'invalid_computed',
      'computed must be a plain object literal',
    );
  }

  const known = Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape);
  const normalized: Record<string, ServerComponentComputed<any>> = {};
  for (const [name, fn] of Object.entries(computed)) {
    validateComputedName(name, known);
    if (typeof fn !== 'function') {
      throw new ServerComponentDefinitionError(
        'invalid_computed',
        'computed property must be a function',
      );
    }
    normalized[name] = fn;
  }
  return normalized;
}

function validateComputedName(name: string, known: readonly string[]): void {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ServerComponentDefinitionError(
      'invalid_computed',
      'computed property name must be a non-empty string',
    );
  }
  if (name in Object.prototype) {
    throw new ServerComponentDefinitionError(
      'invalid_computed',
      'computed property name must not shadow an inherited object property',
    );
  }
  if (known.includes(name)) {
    throw new ServerComponentDefinitionError(
      'invalid_computed',
      'computed property name must not collide with a top-level state field',
    );
  }
}
