/**
 * Component root rendering for the server-component runtime.
 *
 * `makeRenderTools` builds the `bind`/`call`/`submit`/`poll` helpers (plus the
 * passed-through `errors`/`values`/`context`) handed to a component's `render`.
 * `renderComponentHtml` renders a component's current state inside the owned
 * root element, carrying the snapshot and id markers. Markers and
 * serialized arguments are validated here so a bad tool usage fails the render
 * closed with a value-free {@link ServerComponentRuntimeError}, and so does a
 * bound form that could submit before the client takes it over
 * (`inert-forms.ts`). It also returns the render tag and the nested slots the
 * render filled. `validationFailureResult` renders the 422 re-render; the
 * static-export root is `static-render.ts`'s.
 *
 * The render tag is the opaque identity of one render: a SHA-256 over the
 * component id, the instance id, the canonical state, the root's inner HTML
 * with every nested child elided, and the ordered `(slot, component)` list.
 * The snapshot token is a root attribute, outside the hashed HTML, so
 * two renders of the same state and markup carry the same tag while a state
 * change with identical HTML, or a structural change, does not. The client
 * echoes it as `have.render`; the update pipeline answers `unchanged` on a
 * match when every child was kept (a child mounted fresh is content the
 * client lacks, which the elided tag cannot show).
 */

import { createHash } from 'node:crypto';

import { Fragment, h } from 'preact';
import { z } from 'zod';

import type { JsonValue, RequestContext } from '../../contracts/http.js';
import { renderToString } from '../../jsx/render-to-string.js';
import { isPlainObject } from '../../json/shape.js';
import {
  bindAttrs,
  callAttrs,
  confirmAttrs,
  ignoreAttrs,
  intersectAttrs,
  loadingTargetAttrs,
  pollAttrs,
  refAttrs,
  showAttrs,
  sortAttrs,
  submitAttrs,
  textAttrs,
} from '../../client/action-attrs.js';
import type {
  ServerComponentAction,
  ServerComponentBindOptions,
  ServerComponentCallAttrs,
  ServerComponentDefinition,
  ServerComponentModelAttrs,
  ServerComponentRenderTools,
  ServerComponentState,
  ServerComponentSubmitAttrs,
} from '../component.js';
import {
  COMPONENT_ATTRIBUTE,
  COMPONENT_NAME_ATTRIBUTE,
  COMPONENT_ROOT_ID_PREFIX,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  COMPONENT_RENDER_ATTRIBUTE,
  RULES_ATTRIBUTE,
  TURBO_ATTRIBUTE,
} from '../protocol.js';
import { finishFrame, runInComponentFrame, type RenderedSlot } from '../nested-frame.js';
import type { ComponentHeldSlot } from '../../wire/protocol.js';
import { canonicalJson } from '../../wire/json-scan.js';
import {
  extractFieldRules,
  serializeFieldRules,
  type FieldValidationRules,
} from '../validation-meta.js';
import type { SnapshotPayload } from '../snapshot.js';
import { assertInertForms } from './inert-forms.js';
import { ServerComponentRuntimeError, type ServerComponentUpdateResult } from './value-errors.js';

/** Wrapper options for rendering a live component root to HTML. */
interface RenderHtmlOptions {
  /** The registry id the component is signed under. */
  readonly componentId: string;
  /** The component instance id. */
  readonly id: string;
  readonly token: string;
  readonly errors: Readonly<Record<string, string | undefined>>;
  readonly values: Readonly<Record<string, string>>;
  readonly context: RequestContext;
  /** The nested children the client holds for this root (`have.slots`). */
  readonly held?: readonly ComponentHeldSlot[];
}

/** One live root render: its HTML, its render tag, and the nested slots it filled. */
export interface RenderedRoot {
  readonly html: string;
  readonly tag: string;
  readonly slots: readonly RenderedSlot[];
}

/** Look up an action by name without tripping over inherited properties. */
export function lookupAction(
  component: ServerComponentDefinition<any>,
  name: string,
): ServerComponentAction<any, any> | undefined {
  const actions = component.actions;
  if (actions === undefined || !Object.hasOwn(actions, name)) {
    return undefined;
  }
  return actions[name];
}

/** Stringify a bound state value for an element's `value` attribute. */
function serializeStateValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Validate args for a `call`/`submit` marker against the action's input schema. */
export function serializeActionArgs(
  component: ServerComponentDefinition<any>,
  action: string,
  args: JsonValue | undefined,
): JsonValue | undefined {
  const definition = lookupAction(component, action);
  if (definition === undefined) {
    throw new ServerComponentRuntimeError('not_found', 'unknown component action');
  }
  if (args === undefined) {
    return undefined;
  }
  if (definition.input === undefined) {
    if (isPlainObject(args) && Object.keys(args).length > 0) {
      throw new ServerComponentRuntimeError('invalid_input', 'action does not accept arguments');
    }
    return undefined;
  }
  const parsed = definition.input.safeParse(args);
  if (!parsed.success) {
    throw new ServerComponentRuntimeError('invalid_input', 'invalid action arguments');
  }
  return parsed.data as JsonValue;
}

/**
 * The validation rules of one top-level state field, extracted lazily (once
 * per field) from the state schema's shape. An oversized schema constraint
 * throws a value-free `ValidationMetaError` here, failing the render closed
 * rather than emitting truncated metadata.
 */
export function fieldRulesOf(
  component: ServerComponentDefinition<any>,
): (name: string) => FieldValidationRules {
  const rulesByField = new Map<string, FieldValidationRules>();
  return (name) => {
    const cached = rulesByField.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const shape = (component.stateSchema as z.ZodObject<any>).shape;
    const fieldSchema = shape[name] as z.ZodType | undefined;
    const rules =
      fieldSchema === undefined
        ? ({ required: false } satisfies FieldValidationRules)
        : extractFieldRules(fieldSchema);
    rulesByField.set(name, rules);
    return rules;
  };
}

/**
 * The value attributes of a bound control: `checked` for a boolean field,
 * otherwise `value`, and the input `type` the field's rules imply.
 */
export function boundValueAttrs(
  value: unknown,
  rules: FieldValidationRules,
): Record<string, unknown> {
  const attrs: Record<string, unknown> =
    typeof value === 'boolean' ? { checked: value } : { value: serializeStateValue(value) };
  if (rules.type === 'email' || rules.type === 'number' || rules.type === 'date') {
    attrs.type = rules.type;
  }
  return attrs;
}

/**
 * The memoized `computed(name)` of one render: each declared computed property
 * is evaluated at most once, and an undeclared name fails the render.
 */
export function computedOf(
  component: ServerComponentDefinition<any>,
  state: ServerComponentState,
  context: RequestContext,
): (name: string) => unknown {
  const computedCache = new Map<string, unknown>();
  return (name) => {
    const definitions = component.computed;
    if (definitions === undefined || !Object.hasOwn(definitions, name)) {
      throw new ServerComponentRuntimeError('not_found', 'unknown computed property');
    }
    if (computedCache.has(name)) {
      return computedCache.get(name);
    }
    const fn = definitions[name];
    if (fn === undefined) {
      throw new ServerComponentRuntimeError('not_found', 'unknown computed property');
    }
    const result = fn(state, context);
    computedCache.set(name, result);
    return result;
  };
}

/** Build the `bind`/`call`/`submit` tools handed to a component's `render`. */
function makeRenderTools(
  component: ServerComponentDefinition<any>,
  state: ServerComponentState,
  errors: Readonly<Record<string, string | undefined>>,
  values: Readonly<Record<string, string>>,
  context: RequestContext,
): ServerComponentRenderTools<any> {
  const rulesFor = fieldRulesOf(component);

  const bind = (
    name: keyof ServerComponentState & string,
    options?: ServerComponentBindOptions,
  ): ServerComponentModelAttrs => {
    const rules = rulesFor(name);
    const attrs: Record<string, unknown> = {
      ...bindAttrs(name, options),
      ...boundValueAttrs(state[name], rules),
    };
    const serializedRules = serializeFieldRules(rules);
    if (serializedRules !== undefined) {
      attrs[RULES_ATTRIBUTE] = serializedRules;
    }
    return attrs as unknown as ServerComponentModelAttrs;
  };

  const call = (action: string, args?: JsonValue): ServerComponentCallAttrs => {
    const serialized = serializeActionArgs(component, action, args);
    return callAttrs(action, serialized);
  };

  const submit = (action: string, args?: JsonValue): ServerComponentSubmitAttrs => {
    const serialized = serializeActionArgs(component, action, args);
    return { ...submitAttrs(action, serialized), [TURBO_ATTRIBUTE]: false };
  };

  const poll = pollAttrs;

  // Computed properties are resolved lazily and memoized per render: a repeated
  // access returns the same value (or the same Promise) without re-evaluating.
  const computed = computedOf(component, state, context);

  return {
    bind,
    call,
    submit,
    poll,
    computed,
    errors,
    values,
    context,
    confirm: confirmAttrs,
    loadingTarget: loadingTargetAttrs,
    show: showAttrs,
    text: textAttrs,
    sort: sortAttrs,
    intersect: intersectAttrs,
    ref: refAttrs,
    ignore: ignoreAttrs,
  };
}

/** Escape a value for a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Append one length-prefixed field to a hash, so no two field lists collide. */
function hashField(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(`${value.length}:`);
  hash.update(value);
}

/** The render tag of one live render (see the module comment). */
function renderTagOf(
  componentId: string,
  instanceId: string,
  state: ServerComponentState,
  elidedHtml: string,
  slots: readonly RenderedSlot[],
): string {
  const hash = createHash('sha256');
  hashField(hash, componentId);
  hashField(hash, instanceId);
  hashField(hash, canonicalJson(state));
  hashField(hash, elidedHtml);
  hashField(hash, JSON.stringify(slots.map(({ slot, component }) => [slot, component])));
  return hash.digest('base64url');
}

/** Render a component's current state inside the owned root element. */
export async function renderComponentHtml(
  component: ServerComponentDefinition<any>,
  state: ServerComponentState,
  options: RenderHtmlOptions,
): Promise<RenderedRoot> {
  const tools = makeRenderTools(component, state, options.errors, options.values, options.context);
  // The frame gives this render's `renderNested` calls their depth and slots,
  // and tells them which children the client holds.
  const { frame, result } = runInComponentFrame(
    { ...(options.held === undefined ? {} : { held: options.held }), instanceId: options.id },
    () => component.render(state, tools),
  );
  const children = await result;
  const {
    html: inner,
    elided,
    slots,
  } = finishFrame(frame, renderToString(h(Fragment, null, children)));
  // Checked with the children in place: a child's own render cannot see the
  // bound form of this root it may sit inside, and a submitter there belongs
  // to that form.
  assertInertForms(inner);
  const tag = renderTagOf(options.componentId, options.id, state, elided, slots);

  // The root is assembled here rather than by a second renderToString, so a
  // component render costs one render pass whatever it nests.
  const attrs: readonly (readonly [string, string])[] = [
    [COMPONENT_ATTRIBUTE, component.name],
    [COMPONENT_NAME_ATTRIBUTE, component.name],
    ['id', COMPONENT_ROOT_ID_PREFIX + options.id],
    [COMPONENT_SNAPSHOT_ATTRIBUTE, options.token],
    [COMPONENT_RENDER_ATTRIBUTE, tag],
  ];
  const open = attrs.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
  return { html: `<div${open}>${inner}</div>`, tag, slots };
}

/**
 * Everything a 422 re-render needs: the still-valid verified snapshot and its
 * original token (nothing was re-signed), plus the submitted values to preserve.
 */
export interface ValidationFailureTarget {
  readonly sequence: number;
  readonly token: string;
  readonly snapshot: SnapshotPayload;
  readonly componentId: string;
  readonly component: ServerComponentDefinition<any>;
  readonly context: RequestContext;
  readonly values: Readonly<Record<string, string>>;
  /** The nested children the client holds, kept across the 422 re-render too. */
  readonly held: readonly ComponentHeldSlot[];
}

/** Build a 422 response: re-render the verified state with errors and preserved values. */
export async function validationFailureResult(
  target: ValidationFailureTarget,
  errors: Readonly<Record<string, string>>,
): Promise<ServerComponentUpdateResult> {
  const rendered = await renderComponentHtml(target.component, target.snapshot.state, {
    componentId: target.componentId,
    id: target.snapshot.id,
    token: target.token,
    errors,
    values: target.values,
    context: target.context,
    held: target.held,
  });
  return {
    status: 422,
    body: {
      kind: 'invalid',
      sequence: target.sequence,
      errors,
      html: rendered.html,
      render: rendered.tag,
    },
  };
}
