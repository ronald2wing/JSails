/**
 * Per-render nesting frames for nested server components.
 *
 * Every live component render runs inside a frame that travels with the async
 * render as a key of the execution context (`jsails/context`), never
 * propagated: a frame belongs to one render in this process. A frame records
 * the nesting depth of the render (so a self-nesting chain stops at a bound),
 * assigns each `renderNested` call a stable slot, knows which children the
 * client already holds (`have.slots` of the update being answered), and
 * collects what the render produced for each slot.
 *
 * A slot names a child's place in its parent's render: `k:<key>` for a keyed
 * child, `p:<component>:<n>` for the n-th unkeyed child of that component.
 * With the component id it is the child's identity. A held slot is a hint,
 * never an authority: the child is kept only when the client reported the same
 * component for it and the child's own `authorize` allows, and a kept child is
 * never executed, so nothing the client sent is trusted as child state.
 *
 * A child's content is not placed in the parent's tree directly: its wrapper
 * carries a placeholder comment holding this render's random nonce, and
 * {@link finishFrame} swaps each placeholder for the child's HTML (or the keep
 * marker) afterwards. The same pass yields the parent's HTML with every child
 * elided, which is what the render tag hashes, so a parent whose children were
 * mounted fresh and the same parent whose children were kept hash alike.
 *
 * A static form (what a static export writes in place of a live root) renders
 * inside a static frame: it carries the depth, so the bound holds for a
 * static chain too, but no slots, because a static page holds nothing the
 * client could keep or refresh. Its children render static and inline.
 */

import { Encoding } from '../support/encoding.js';
import { createContextKey, getContext, withContext } from '../context/execution-context.js';
import { NESTED_WRAPPER_ID_PREFIX } from './protocol.js';

/** One slot a render filled. */
export interface RenderedSlot {
  readonly slot: string;
  readonly component: string;
  /** True when the client's child was kept, false when it was mounted fresh. */
  readonly kept: boolean;
}

/** One component render's nesting frame. */
export interface NestedFrame {
  /** Depth of this render in the `renderNested` chain (0 for a top-level component). */
  readonly depth: number;
  /** True for a static form's render: its children render static, without slots. */
  readonly static: boolean;
  /** The children the client holds for this root: slot to component id. */
  readonly held: ReadonlyMap<string, string>;
  /** The root's instance id; wrapper ids derive from it. */
  readonly instanceId: string | undefined;
  /** Random per-render token that makes the child placeholders unforgeable. */
  readonly nonce: string;
  /** Next ordinal per component name for unkeyed children of this render. */
  readonly ordinals: Map<string, number>;
  /** Slots assigned so far, in call order, so a repeated key is caught. */
  readonly assigned: Set<string>;
  /** What each filled slot rendered (a denied child fills none). */
  readonly filled: Map<string, RenderedSlot>;
  /** Child contents, indexed by placeholder. */
  readonly contents: string[];
}

/** The depth a `renderNested` call hands the child render it starts. */
interface PendingChild {
  readonly depth: number;
  claimed: boolean;
}

const frameKey = createContextKey<NestedFrame>('jsails.server-components.nested-frame');
const pendingKey = createContextKey<PendingChild>('jsails.server-components.nested-child');

/** What a render's frame is opened with. */
export interface FrameInit {
  /** The children the client holds (`have.slots`); empty for a fresh render. */
  readonly held?: readonly { readonly slot: string; readonly component: string }[];
  /** The root's instance id, when the render is live. */
  readonly instanceId?: string;
  /** True for a static form's render (see the module comment). */
  readonly static?: boolean;
}

/** The frame of the component render currently running, if any. */
export function currentNestedFrame(): NestedFrame | undefined {
  return getContext(frameKey);
}

/**
 * Run a component's `render` inside its own frame and return the frame with
 * the render's result. A render started by `renderNested` takes the depth that
 * call assigned; any other render opens at the depth of the frame it runs in.
 */
export function runInComponentFrame<T>(
  init: FrameInit,
  render: () => T,
): { readonly frame: NestedFrame; readonly result: T } {
  const pending = getContext(pendingKey);
  let depth: number;
  if (pending !== undefined && !pending.claimed) {
    pending.claimed = true;
    depth = pending.depth;
  } else {
    depth = getContext(frameKey)?.depth ?? 0;
  }
  const held = new Map<string, string>();
  for (const entry of init.held ?? []) {
    if (!held.has(entry.slot)) {
      held.set(entry.slot, entry.component);
    }
  }
  const frame: NestedFrame = {
    depth,
    static: init.static === true,
    held,
    instanceId: init.instanceId,
    nonce: Encoding.base64url(Encoding.randomBytes(12)),
    ordinals: new Map(),
    assigned: new Set(),
    filled: new Map(),
    contents: [],
  };
  const result = withContext(frameKey, frame, render);
  return { frame, result };
}

/** Run a nested child's render at `depth`; the child's own frame claims it. */
export function runInChildRender<T>(depth: number, render: () => T): T {
  return withContext(pendingKey, { depth, claimed: false }, render);
}

/**
 * Assign the slot for the next `renderNested` call in `frame`, or `undefined`
 * when the slot was already assigned in this render (a repeated key). Must run
 * synchronously at the start of the call so that concurrent children get
 * ordinals in call order.
 */
export function assignSlot(
  frame: NestedFrame,
  component: string,
  key: string | undefined,
): string | undefined {
  let slot: string;
  if (key !== undefined) {
    slot = `k:${key}`;
  } else {
    const ordinal = frame.ordinals.get(component) ?? 0;
    frame.ordinals.set(component, ordinal + 1);
    slot = `p:${component}:${ordinal}`;
  }
  if (frame.assigned.has(slot)) {
    return undefined;
  }
  frame.assigned.add(slot);
  return slot;
}

/** The component the client holds in `slot`, if it reported one. */
export function heldComponent(frame: NestedFrame, slot: string): string | undefined {
  return frame.held.get(slot);
}

/**
 * The element id of the wrapper for `slot`: the same on every render of this
 * root instance, so a morph pairs the old and new wrapper of a slot exactly.
 */
export function wrapperId(frame: NestedFrame, slot: string): string | undefined {
  if (frame.instanceId === undefined) {
    return undefined;
  }
  return `${NESTED_WRAPPER_ID_PREFIX}${frame.instanceId}-${Encoding.base64url(new TextEncoder().encode(slot))}`;
}

/**
 * Record what `slot` rendered and return the placeholder its wrapper carries in
 * place of `content` until {@link finishFrame} swaps it in.
 */
export function fillSlot(frame: NestedFrame, slot: RenderedSlot, content: string): string {
  frame.filled.set(slot.slot, slot);
  const index = frame.contents.push(content) - 1;
  return `<!--jsails-child:${frame.nonce}:${index}-->`;
}

/** A finished render: its HTML, the same HTML with every child elided, and its filled slots. */
export interface FinishedFrame {
  readonly html: string;
  readonly elided: string;
  /** The filled slots in `renderNested` call order, whatever order the children finished in. */
  readonly slots: readonly RenderedSlot[];
}

/**
 * Swap every placeholder in a render's HTML for its child's content (`html`)
 * and for nothing (`elided`). A placeholder can only come from this render: its
 * nonce is random per render, so author content cannot forge one.
 */
export function finishFrame(frame: NestedFrame, html: string): FinishedFrame {
  const slots: RenderedSlot[] = [];
  for (const slot of frame.assigned) {
    const rendered = frame.filled.get(slot);
    if (rendered !== undefined) {
      slots.push(rendered);
    }
  }
  if (frame.contents.length === 0) {
    return { html, elided: html, slots };
  }
  const placeholder = new RegExp(`<!--jsails-child:${frame.nonce}:(\\d+)-->`, 'g');
  return {
    html: html.replace(placeholder, (_match, index: string) => frame.contents[Number(index)] ?? ''),
    elided: html.replace(placeholder, ''),
    slots,
  };
}
