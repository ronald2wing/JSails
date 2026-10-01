/**
 * Nested (child) server components for JSails.
 *
 * A parent component may render an independently authorized, stateful child
 * component inside its own render output. Each child carries its own signed
 * snapshot token and component id — its state is fully
 * independent and the child re-verifies its own snapshot on every update,
 * re-runs its own `authorize`, and enforces its own `writableKeys`. A parent
 * never inherits, proxies, or weakens a child's security boundary.
 *
 * Security posture and protocol:
 * - Nested state is independent: each child is mounted and updated through
 *   its own `mount` → `sign` → `verify` lifecycle, bound to the child's own
 *   component id and the request's origin and subject, never the parent's.
 * - Parents never re-derive children. Each wrapper carries the child's slot
 *   (`data-jsails-nested-slot`) and component (`data-jsails-nested-component`);
 *   on a parent update the client reports the children it holds by that pair
 *   (`have.slots`), and a reported child whose component still matches and
 *   whose `authorize` returns exactly `true` is kept by reference: its wrapper
 *   carries a keep marker instead of HTML, the child is not executed, and the
 *   client leaves its DOM, controller, typed values, and errors untouched.
 *   Anything else is mounted fresh. A parent action that changed a child's
 *   data asks the client to refresh that child (`context.refreshChild(key)`).
 * - A child whose `authorize` returns anything but exactly `true` renders as
 *   nothing (`renderNested` returns `null`), so a child the viewer may no
 *   longer see disappears from the parent; a throwing `authorize` is a fault.
 * - Nesting depth is bounded by {@link MAX_NESTING_DEPTH}: the depth of the
 *   current `renderNested` chain travels with the async render in its nesting
 *   frame (`nested-frame.ts`), so a component that (directly or through
 *   others) renders itself fails with a value-free `too_deep` error instead of
 *   recursing until the process runs out of memory.
 */

import { h } from 'preact';
import type { VNode } from 'preact';

import type { RequestContext } from '../contracts/http.js';
import { ServerComponentError, serverComponentsToken } from './extension.js';
import {
  assignSlot,
  currentNestedFrame,
  fillSlot,
  heldComponent,
  runInChildRender,
  wrapperId,
} from './nested-frame.js';
import {
  NESTED_COMPONENT_ATTRIBUTE,
  NESTED_KEEP_ATTRIBUTE,
  NESTED_SLOT_ATTRIBUTE,
} from './protocol.js';
import { ServerComponentRuntimeError, type ServerComponentChildRender } from './runtime/index.js';
import { JsailsError } from '../errors/jsails-error.js';
import { MAX_SLOT_COMPONENT_LENGTH, MAX_SLOT_LENGTH } from '../wire/protocol.js';

/**
 * Configuration for a nested (child) component, returned by
 * {@link defineNestedComponent}.
 *
 * The config is a frozen plain object carrying only display metadata — the
 * component name is the registered server-component the child renders, `tag`
 * names the wrapper element, and `key` is an optional stable identifier that
 * names the child's slot, so it keeps its identity across a parent update even
 * when the children around it are reordered.
 */
export interface NestedComponentConfig {
  /** The tag name the child renders its root element as. */
  readonly tag: string;
  /** The registered server-component name. */
  readonly component: string;
  /** An optional stable key for the child wrapper. */
  readonly key?: string;
}

/** Maximum number of `renderNested` calls on one render chain. */
export const MAX_NESTING_DEPTH = 8;

/** Stable codes carried by a {@link NestedComponentError}. */
export type NestedComponentErrorCode =
  | 'invalid_config'
  | 'missing_runtime'
  | 'unavailable'
  | 'render_failed'
  | 'too_deep'
  | 'duplicate_slot';

/** Raised for nested-component wiring failures. Value-free. */
export class NestedComponentError extends JsailsError {
  constructor(
    readonly code: NestedComponentErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The content of a kept child's wrapper: the client keeps the child it holds. */
const KEEP_MARKER = `<template ${NESTED_KEEP_ATTRIBUTE}></template>`;

/**
 * Define a nested component configuration.
 *
 * `tag` is the HTML wrapper element (e.g. `"section"`, `"div"`). `component`
 * must name a registered server component. `key` is an optional stable
 * identifier that names the child's slot (`k:<key>`); it must be unique among
 * the children one parent render produces.
 *
 * The returned config is frozen; pass it to {@link renderNested} to render
 * the child inside a parent's output, or pass just the component name as a
 * string for the default `div` wrapper.
 */
export function defineNestedComponent(config: {
  readonly name: string;
  readonly component: string;
  readonly key?: string;
}): NestedComponentConfig {
  if (config === null || typeof config !== 'object') {
    throw new NestedComponentError(
      'invalid_config',
      'defineNestedComponent requires a config object',
    );
  }
  if (typeof config.component !== 'string' || config.component.trim() === '') {
    throw new NestedComponentError('invalid_config', 'component name must be a non-empty string');
  }
  const tag = config.name;
  if (typeof tag !== 'string' || tag.trim() === '') {
    throw new NestedComponentError('invalid_config', 'tag name must be a non-empty string');
  }
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(tag)) {
    throw new NestedComponentError('invalid_config', 'tag name must be a valid HTML tag');
  }
  if (config.key !== undefined && typeof config.key !== 'string') {
    throw new NestedComponentError('invalid_config', 'key must be a string when present');
  }

  return Object.freeze({
    tag,
    component: config.component,
    ...(config.key === undefined ? {} : { key: config.key }),
  });
}

/**
 * Render a registered server component as a nested child inside a parent's
 * render output.
 *
 * `nameOrConfig` is either a plain component name (default `div` wrapper) or
 * the result of {@link defineNestedComponent} (custom tag + optional key).
 * The child is rendered through the server-components runtime bound to the
 * current request context, so it receives its own signed snapshot and
 * component id. Its `authorize` is evaluated for this request
 * independently of the parent. Inside a static form (a static export) the
 * child renders its own static form instead, inline and without a slot.
 *
 * Returns a Preact host element whose `dangerouslySetInnerHTML` carries the
 * child's trusted HTML (or, during a parent update, the keep marker for a
 * child the client already holds), or `null` when the child's `authorize`
 * does not return exactly `true`.
 *
 * Throws a value-free {@link NestedComponentError} when:
 * - The runtime is not available on the context (e.g. a static export where
 *   `context.services` is absent, or a context without the server-components
 *   plugin).
 * - The child component is not registered, or its mount fails.
 * - The same slot (a repeated `key`) is rendered twice in one parent render.
 * - The slot (`k:<key>` or `p:<component>:<n>`) or the component id is longer
 *   than `MAX_SLOT_LENGTH`, so the client could not report it as held.
 * - The chain of nested renders is deeper than {@link MAX_NESTING_DEPTH}.
 *
 * ```tsx
 * // Simple: default div wrapper.
 * const child = await renderNested('task-list', context);
 *
 * // Advanced: custom tag + key.
 * const config = defineNestedComponent({ name: 'section', component: 'card', key: 'main' });
 * const card = await renderNested(config, context);
 * ```
 *
 * A keyed child's slot is its key; an unkeyed child's is its position among
 * the parent's unkeyed children of the same component.
 */
export async function renderNested(
  nameOrConfig: string | NestedComponentConfig,
  context: RequestContext,
): Promise<VNode | null> {
  const config = resolveConfig(nameOrConfig);

  // Resolve the runtime from the request context's service registry. The
  // runtime must already be registered by the server-components plugin;
  // static exports and contexts without services carry none.
  const services = context.services;
  if (services === undefined) {
    throw new NestedComponentError(
      'unavailable',
      'server components are not available in this context',
    );
  }

  let runtime;
  try {
    runtime = services.tryGet(serverComponentsToken);
  } catch {
    runtime = undefined;
  }
  if (runtime === undefined || typeof runtime.renderChild !== 'function') {
    throw new NestedComponentError(
      'missing_runtime',
      'server components runtime is not registered',
    );
  }

  // The slot is assigned before any await, so concurrent children of one
  // render get ordinals in call order. A static form's frame assigns none: a
  // static page holds nothing the client could keep.
  const frame = currentNestedFrame();
  const staticForm = frame?.static === true;
  let slot: string | undefined;
  if (frame !== undefined && !staticForm) {
    slot = assignSlot(frame, config.component, config.key);
    if (slot === undefined) {
      throw new NestedComponentError(
        'duplicate_slot',
        'a nested component slot is rendered twice in one render',
      );
    }
    // A slot the client cannot report back is never kept, so its child would
    // be mounted on every parent update: the bound is an authoring error.
    if (slot.length > MAX_SLOT_LENGTH || config.component.length > MAX_SLOT_COMPONENT_LENGTH) {
      throw new NestedComponentError(
        'invalid_config',
        'a nested component slot exceeds the protocol bound',
      );
    }
  }

  const depth = (frame?.depth ?? 0) + 1;
  if (depth > MAX_NESTING_DEPTH) {
    throw new NestedComponentError('too_deep', 'nested components exceed the maximum depth');
  }

  const held =
    frame !== undefined && slot !== undefined && heldComponent(frame, slot) === config.component;

  let outcome: ServerComponentChildRender;
  try {
    outcome = await runInChildRender(depth, () =>
      runtime.renderChild(config.component, context, {
        staticMode: staticForm || context.renderMode === 'static',
        held,
      }),
    );
  } catch (error) {
    if (error instanceof ServerComponentError || error instanceof ServerComponentRuntimeError) {
      throw new NestedComponentError('render_failed', 'nested component render failed');
    }
    throw error;
  }
  if (outcome.kind === 'denied') {
    return null;
  }

  const content = outcome.kind === 'keep' ? KEEP_MARKER : outcome.html;
  if (frame === undefined || slot === undefined) {
    return h(config.tag, { dangerouslySetInnerHTML: { __html: content } });
  }

  // The child's HTML is trusted producer content (the runtime already owns its
  // escaping and markers); the frame swaps it in for the placeholder once the
  // parent's render is complete.
  const id = wrapperId(frame, slot);
  const placeholder = fillSlot(
    frame,
    { slot, component: config.component, kept: outcome.kind === 'keep' },
    content,
  );
  const props: Record<string, unknown> = {
    [NESTED_SLOT_ATTRIBUTE]: slot,
    [NESTED_COMPONENT_ATTRIBUTE]: config.component,
    dangerouslySetInnerHTML: { __html: placeholder },
  };
  if (id !== undefined) {
    props.id = id;
  }
  return h(config.tag, props);
}

/** Parse a string or config into a normalized config (defaults to `div` tag). */
function resolveConfig(nameOrConfig: string | NestedComponentConfig): NestedComponentConfig {
  if (typeof nameOrConfig === 'string') {
    return { tag: 'div', component: nameOrConfig };
  }
  if (nameOrConfig === null || typeof nameOrConfig !== 'object') {
    throw new NestedComponentError(
      'invalid_config',
      'renderNested requires a component name or nested config',
    );
  }
  return nameOrConfig;
}
