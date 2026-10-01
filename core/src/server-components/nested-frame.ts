/**
 * Per-render nesting frames for nested server components.
 *
 * Every live component render runs inside a frame that travels with the async
 * render through an `AsyncLocalStorage`. A frame records the nesting depth of
 * the render (so a self-nesting chain stops at a bound), assigns each
 * `renderNested` call in that render a stable slot, and holds the child
 * snapshots the client offered for restore during a parent update.
 *
 * A slot names a child's place in its parent's render: `k:<key>` for a keyed
 * child, `p:<component>:<n>` for the n-th unkeyed child of that component. The
 * slot is emitted on the child's wrapper, so the client can send each child's
 * current snapshot back keyed by slot with the parent's next update. A slot is
 * a matching hint, never an authority: the offered snapshot is verified for
 * the child's own component, subject, origin, lifetime, and page before it is
 * used, and anything that does not verify mounts the child fresh.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { ComponentNestedSnapshot } from './protocol.js';

/** One component render's nesting frame. */
export interface NestedFrame {
  /** Depth of this render in the `renderNested` chain (0 for a top-level component). */
  readonly depth: number;
  /** Child snapshots offered for restore, keyed by slot; each is taken at most once. */
  readonly pool: Map<string, ComponentNestedSnapshot>;
  /** Next ordinal per component name for unkeyed children of this render. */
  readonly ordinals: Map<string, number>;
  /**
   * False while the frame was prepared by `renderNested` for a child that has
   * not started rendering yet; the child's render claims it. A claimed frame
   * belongs to the render that is running, so a component rendered from inside
   * it without `renderNested` opens its own frame instead of sharing slots.
   */
  claimed: boolean;
}

const frames = new AsyncLocalStorage<NestedFrame>();

/** Index offered child snapshots by slot, keeping the first of any duplicate slot. */
function poolFrom(
  children: readonly ComponentNestedSnapshot[] | undefined,
): Map<string, ComponentNestedSnapshot> {
  const pool = new Map<string, ComponentNestedSnapshot>();
  for (const child of children ?? []) {
    if (!pool.has(child.slot)) {
      pool.set(child.slot, child);
    }
  }
  return pool;
}

/** The frame of the component render currently running, if any. */
export function currentNestedFrame(): NestedFrame | undefined {
  return frames.getStore();
}

/**
 * Run a component's `render` inside its own frame. A frame prepared by
 * `renderNested` is claimed (it carries the child's depth) and seeded with
 * `children`; otherwise a new frame opens at the current depth with `children`
 * as its restore pool. Only a render whose own snapshot verified passes
 * `children`, so a child that mounts fresh never restores its subtree from the
 * offer it rejected.
 */
export function runInComponentFrame<T>(
  children: readonly ComponentNestedSnapshot[] | undefined,
  render: () => T,
): T {
  const current = frames.getStore();
  if (current !== undefined && !current.claimed) {
    current.claimed = true;
    for (const [slot, entry] of poolFrom(children)) {
      current.pool.set(slot, entry);
    }
    return render();
  }
  const frame: NestedFrame = {
    depth: current?.depth ?? 0,
    pool: poolFrom(children),
    ordinals: new Map(),
    claimed: true,
  };
  return frames.run(frame, render);
}

/**
 * Run a nested child's render at `depth` in a frame with an empty restore
 * pool. The child's render claims the frame and seeds the pool only when its
 * own offered snapshot verified.
 */
export function runInChildFrame<T>(depth: number, render: () => T): T {
  return frames.run({ depth, pool: new Map(), ordinals: new Map(), claimed: false }, render);
}

/**
 * Assign the slot for the next `renderNested` call in `frame`. Must run
 * synchronously at the start of the call so that concurrent children get
 * ordinals in call order.
 */
export function nextNestedSlot(
  frame: NestedFrame,
  component: string,
  key: string | undefined,
): string {
  if (key !== undefined) {
    return `k:${key}`;
  }
  const ordinal = frame.ordinals.get(component) ?? 0;
  frame.ordinals.set(component, ordinal + 1);
  return `p:${component}:${ordinal}`;
}

/** Take (and remove) the offered snapshot for `slot`, so a duplicate slot mounts fresh. */
export function takeNestedSnapshot(
  frame: NestedFrame,
  slot: string,
): ComponentNestedSnapshot | undefined {
  const entry = frame.pool.get(slot);
  if (entry !== undefined) {
    frame.pool.delete(slot);
  }
  return entry;
}
