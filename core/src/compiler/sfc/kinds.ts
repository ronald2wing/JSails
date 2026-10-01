/**
 * The kind table of the `.jsails` compiler (sfc-plan §2.2–§2.3): for each
 * kind `sfcKind` derives from a path, what its compiled module exports and
 * which parts of the format its file may use.
 *
 * The function kinds (page, layout, error, not-found, view, island) compile
 * to one function component (`compile-page.ts`), an island's named as an
 * island (`defineIsland`); a live component compiles to a server component
 * definition (`compile-live.ts`). Mails compile to another shape, through a
 * lowering of its own; until it lands the table marks the kind, and
 * `lowerSfc` reports a mail as `sfc.not_lowered` instead of emitting a wrong
 * module.
 */

import type { SfcKind } from '../conventions.js';

/** Where a function kind's props come from. */
export type SfcPropsSource =
  /** `PageProps<typeof load>`: the awaited result of the `load` export. */
  | 'load'
  /** The type argument of `defineProps<T>()` in `<script setup>`, or none. */
  | 'macro'
  /** The error boundary's `{ error: { status, message } }`. */
  | 'error';

/** A macro: a compile-time call that is never imported. */
export type SfcMacro = 'defineProps' | 'defineSlots' | 'defineEmits' | 'defineLive';

/** Every macro name. */
export const SFC_MACROS: readonly SfcMacro[] = Object.freeze([
  'defineProps',
  'defineSlots',
  'defineEmits',
  'defineLive',
]);

/** What the block rules and the template lowering need to know of a lowered kind. */
export interface SfcLoweredSpec {
  readonly kind: SfcKind;
  /** Where the template's free names come from: a function kind's props, or a live component's state. */
  readonly props: SfcPropsSource | 'state';
  /**
   * Whether `<script setup>` may `await`: the page renderer awaits page-tree
   * functions and the component runtime awaits `render`, while a view renders
   * synchronously inside another tree.
   */
  readonly mayAwait: boolean;
  /** Whether the template may render `<slot>`s (it receives children). */
  readonly slots: boolean;
  /** The macros `<script setup>` may call. */
  readonly macros: readonly SfcMacro[];
  /** Whether `export const serverOnly = true` marks the page `SERVER_ONLY`. */
  readonly serverOnly: boolean;
  /**
   * Whether the template may render a live component's tag, which the
   * lowering hoists into an awaited mount (sfc-plan §2.6): a page, a layout
   * or the not-found page, never an error boundary (a failure must not mount
   * state) or a view (which renders synchronously).
   */
  readonly mountsLive: boolean;
  /** Whether `<script setup>` may call hooks: only an island runs in the browser. */
  readonly hooks: boolean;
  /**
   * What an island's tag becomes in the template: a hydrated mount
   * (`<Island>`) where the file renders on the server only, a plain component
   * inside another island (which hydrates it already), or an error in a live
   * component.
   */
  readonly islands: 'mount' | 'component' | 'refuse';
}

/** How one function kind compiles. */
export interface SfcKindSpec extends SfcLoweredSpec {
  /**
   * The local name of the default-exported function, or `null` for a view or
   * an island, whose name is the PascalCase of its file's basename. A page-tree function
   * is never referred to by name, so its name is reserved (`__` prefix) and
   * cannot collide with an import in `<script>`.
   */
  readonly functionName: string | null;
  readonly props: SfcPropsSource;
  /** Whether the props always include `children` (a layout wraps the page). */
  readonly children: boolean;
  /**
   * Whether the function takes the request context as its second parameter,
   * bound in the template as `context`. Page-tree functions are called with
   * it (`pages/page.ts`); a view is an ordinary component.
   */
  readonly context: boolean;
}

/**
 * How a live component compiles: `defineLive({ … })` in `<script>` is its
 * definition, `<script setup>` and `<template>` its `render`, whose free
 * names are state fields, and `<template static>` its `staticFallback`.
 */
export interface LiveKindSpec extends SfcLoweredSpec {
  readonly kind: 'live';
  readonly props: 'state';
}

/** A kind compiled by a lowering that has not landed yet. */
export interface SfcPendingKind {
  readonly kind: SfcKind;
  /** What the kind compiles to, for the `sfc.not_lowered` message. */
  readonly compilesTo: string;
}

const PAGE_TREE = {
  context: true,
  mayAwait: true,
  macros: [] as const,
  children: false,
  mountsLive: true,
  hooks: false,
  islands: 'mount' as const,
};

const FUNCTION_KINDS: Readonly<Partial<Record<SfcKind, SfcKindSpec>>> = Object.freeze({
  page: Object.freeze({
    ...PAGE_TREE,
    kind: 'page',
    functionName: '__Page',
    props: 'load',
    slots: false,
    serverOnly: true,
  }),
  'not-found': Object.freeze({
    ...PAGE_TREE,
    kind: 'not-found',
    functionName: '__NotFoundPage',
    props: 'load',
    slots: false,
    serverOnly: true,
  }),
  error: Object.freeze({
    ...PAGE_TREE,
    kind: 'error',
    functionName: '__ErrorPage',
    props: 'error',
    slots: false,
    serverOnly: false,
    mountsLive: false,
  }),
  layout: Object.freeze({
    ...PAGE_TREE,
    kind: 'layout',
    functionName: '__Layout',
    props: 'macro',
    children: true,
    slots: true,
    macros: Object.freeze(['defineProps', 'defineSlots'] as const),
    serverOnly: false,
  }),
  view: Object.freeze({
    kind: 'view',
    functionName: null,
    props: 'macro',
    children: false,
    context: false,
    mayAwait: false,
    slots: true,
    macros: Object.freeze(['defineProps', 'defineSlots'] as const),
    serverOnly: false,
    mountsLive: false,
    hooks: false,
    islands: 'mount',
  }),
  island: Object.freeze({
    kind: 'island',
    functionName: null,
    props: 'macro',
    children: false,
    context: false,
    mayAwait: false,
    slots: true,
    macros: Object.freeze(['defineProps', 'defineSlots', 'defineEmits'] as const),
    serverOnly: false,
    mountsLive: false,
    hooks: true,
    islands: 'component',
  }),
});

/** The live kind's spec. */
export const LIVE_KIND: LiveKindSpec = Object.freeze({
  kind: 'live',
  props: 'state',
  mayAwait: true,
  slots: false,
  macros: Object.freeze([] as const),
  serverOnly: false,
  mountsLive: false,
  hooks: false,
  islands: 'refuse',
});

const PENDING_KINDS: Readonly<Partial<Record<SfcKind, SfcPendingKind>>> = Object.freeze({
  mail: Object.freeze({ kind: 'mail', compilesTo: 'a mail' }),
});

/** The spec of a lowered kind, or the pending entry of any other kind. */
export function kindSpec(kind: SfcKind): SfcKindSpec | LiveKindSpec | SfcPendingKind {
  if (kind === 'live') return LIVE_KIND;
  return (FUNCTION_KINDS[kind] ?? PENDING_KINDS[kind]) as SfcKindSpec | SfcPendingKind;
}

/** Whether a spec is a function kind's. */
export function isFunctionKind(
  spec: SfcKindSpec | LiveKindSpec | SfcPendingKind,
): spec is SfcKindSpec {
  return 'functionName' in spec;
}
