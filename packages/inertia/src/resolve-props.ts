/**
 * The props resolution engine (v3 protocol: partial reloads, deferred, merge,
 * once, and scroll props).
 *
 * Resolution has two phases, so lazy props run concurrently and only when
 * selected:
 *
 * 1. Plan. A synchronous walk over the merged shared and page props decides,
 *    from paths and descriptor kinds alone, which props this response carries.
 *    It descends only through plain literal objects; an array, a primitive, a
 *    resolver, or a descriptor is atomic, so a lazy prop selected by a dot path
 *    into it is returned whole (the inertia-laravel rule: children of a
 *    resolved value bypass partial filtering). Props left out of a full visit
 *    (optional, deferred, a once prop the client holds) record their deferred,
 *    merge, and once metadata here, without their resolver being called.
 * 2. Resolve. Every planned resolver runs at once with an
 *    {@link InertiaPropContext}. A failure aborts the context signal so its
 *    siblings can stop, and fails the whole resolution, except for a `defer`
 *    prop with `rescue`, which is left out, listed in `rescuedProps`, and
 *    reported. A failure while the request itself is aborted is never
 *    rescued: the client is gone, so it is rethrown, not reported. A selected
 *    lazy prop that resolves to `undefined` is sent as `null`, so the client
 *    sees the key (`<Deferred>` waits for every named key to be defined).
 *    Metadata of the resolved props (merge, once, scroll) is collected
 *    afterwards in plan order.
 *
 * The walk is transcribed from inertia-laravel `PropsResolver::resolveProps`,
 * with two deliberate differences: lazy props resolve concurrently, and arrays
 * are atomic (the reference recurses into PHP arrays, which turns a selected
 * list element into an object with a numeric key on the wire).
 *
 * `errors` is reserved: it is always present, partial reloads included and
 * whatever `X-Inertia-Partial-Except` says, and a prop or shared prop of that
 * name is rejected. Keys on the path to a resolver or descriptor become
 * metadata and header vocabulary, so they may not contain `.` or `,`; the
 * forbidden prototype keys are rejected anywhere in the walked tree.
 */

import type { InertiaErrorBags, InertiaErrors } from './error-bags.js';
import { InertiaError } from './inertia-error.js';
import type { InertiaOnceMeta, InertiaPropsMetadata, InertiaScrollMeta } from './page.js';
import { selectsMetadata, selectsPath, partialSelection } from './partial-reload.js';
import type { PartialSelection } from './partial-reload.js';
import { FORBIDDEN_KEYS, isPlainObject } from './plain-data.js';
import { isInertiaProp, propSpec } from './props.js';
import type { InertiaPropContext, PropSpec } from './props.js';
import type { InertiaRequestFacts, InertiaVisit } from './visit.js';

/** A props tree: literal values, resolvers, and descriptors, nested in plain objects. */
export type PropsTree = Readonly<Record<string, unknown>>;

/** Called with the failure of a rescued deferred prop. */
export type RescueReporter = (error: unknown, path: string) => void;

/** Input to {@link resolveProps}. */
export interface ResolvePropsInput {
  readonly component: string;
  readonly facts: InertiaRequestFacts;
  readonly visit: InertiaVisit;
  readonly props: PropsTree;
  /** Props shared by every page; page props of the same top-level key win. */
  readonly shared?: PropsTree;
  /** The already-shaped `errors` prop. Defaults to `{}`. */
  readonly errors?: InertiaErrors | InertiaErrorBags;
  /** Reports rescued deferred-prop failures. Defaults to `console.error`. */
  readonly report?: RescueReporter;
  /** The clock for once-prop `ttlMs` expiries, in epoch milliseconds. */
  readonly now?: () => number;
}

/** The resolved props and the metadata the page object reports. */
export interface ResolvedProps {
  readonly props: Readonly<Record<string, unknown>> & {
    readonly errors: InertiaErrors | InertiaErrorBags;
  };
  readonly metadata: InertiaPropsMetadata;
}

/** The reserved prop that carries validation errors. */
export const ERRORS_PROP = 'errors';

interface Task {
  readonly path: string;
  readonly holder: Record<string, unknown>;
  readonly key: string;
  readonly spec: PropSpec | undefined;
  readonly source: unknown;
}

type TaskResult =
  | { readonly rescued: false; readonly value: unknown }
  | { readonly rescued: true; readonly error: unknown };

/** Resolve a page's props for one request. */
export async function resolveProps(input: ResolvePropsInput): Promise<ResolvedProps> {
  const shared = input.shared ?? {};
  for (const tree of [shared, input.props]) {
    if (!isPlainObject(tree)) throw new InertiaError('invalid_props');
    if (Object.hasOwn(tree, ERRORS_PROP)) {
      throw new InertiaError('invalid_prop_key', { path: ERRORS_PROP });
    }
  }
  const metadata = new MetadataCollector(
    input.visit,
    partialSelection(input.visit, input.component),
    input.now ?? Date.now,
  );
  const planner = new Planner(input.visit, metadata);
  const props: Record<string, unknown> & { errors: InertiaErrors | InertiaErrorBags } = {
    errors: input.errors ?? {},
  };
  planner.walk({ ...shared, ...input.props }, '', props, false);

  const controller = new AbortController();
  const context: InertiaPropContext = Object.freeze({
    component: input.component,
    method: input.facts.method,
    url: input.facts.url,
    headers: input.facts.headers,
    signal: AbortSignal.any([input.facts.signal, controller.signal]),
  });
  const results = await Promise.all(
    planner.tasks.map((task) => runTask(task, context, controller, input.facts.signal)),
  );

  const report = input.report ?? reportToConsole;
  const rescued: string[] = [];
  planner.tasks.forEach((task, index) => {
    const result = results[index];
    if (result === undefined) return;
    if (result.rescued) {
      Reflect.deleteProperty(task.holder, task.key);
      rescued.push(task.path);
      report(result.error, task.path);
      return;
    }
    if (isInertiaProp(result.value)) {
      throw new InertiaError('unserializable_prop', { path: task.path });
    }
    const value = result.value === undefined ? null : result.value;
    task.holder[task.key] =
      task.spec === undefined ? value : metadata.included(task.spec, task.path, value);
  });

  return Object.freeze({
    props,
    metadata: metadata.build(Object.keys(shared), rescued),
  });
}

async function runTask(
  task: Task,
  context: InertiaPropContext,
  controller: AbortController,
  requestSignal: AbortSignal,
): Promise<TaskResult> {
  try {
    const value: unknown =
      typeof task.source === 'function'
        ? await (task.source as (context: InertiaPropContext) => unknown)(context)
        : task.source;
    return { rescued: false, value };
  } catch (error) {
    if (task.spec?.rescue === true && !requestSignal.aborted) return { rescued: true, error };
    controller.abort();
    throw error;
  }
}

function reportToConsole(error: unknown, path: string): void {
  console.error(`[jsails/inertia] rescued deferred prop "${path}" failed`, error);
}

/** Phase 1: decide which props the response carries and queue their resolvers. */
class Planner {
  readonly tasks: Task[] = [];

  constructor(
    private readonly visit: InertiaVisit,
    private readonly metadata: MetadataCollector,
  ) {}

  walk(node: PropsTree, prefix: string, out: Record<string, unknown>, unsafePath: boolean): void {
    for (const key of Object.keys(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (FORBIDDEN_KEYS.has(key)) throw new InertiaError('invalid_prop_key', { path });
      const value = node[key];
      const spec = propSpec(value);
      const lazy = spec !== undefined || typeof value === 'function';
      const unsafe = unsafePath || key.includes('.') || key.includes(',');
      if (lazy && unsafe) throw new InertiaError('invalid_prop_key', { path });

      const selection = this.metadata.selection;
      if (selection !== null) {
        if (spec?.kind !== 'always' && !selectsPath(selection, path)) continue;
      } else if (spec !== undefined && this.excludedFromFullVisit(spec, path)) {
        continue;
      }

      if (lazy) {
        out[key] = undefined;
        this.tasks.push({ path, holder: out, key, spec, source: spec?.source ?? value });
      } else if (isPlainObject(value)) {
        const child: Record<string, unknown> = {};
        out[key] = child;
        this.walk(value, path, child, unsafe);
      } else {
        out[key] = value;
      }
    }
  }

  /**
   * Whether a full visit leaves the prop out, recording the metadata the
   * client needs to fetch or keep it.
   */
  private excludedFromFullVisit(spec: PropSpec, path: string): boolean {
    if (spec.kind === 'optional' || spec.kind === 'defer') {
      if (spec.kind === 'defer' && spec.group !== null && !this.clientHolds(spec, path)) {
        this.metadata.deferred(spec.group, path);
      }
      this.metadata.merge(spec, path);
      this.metadata.once(spec, path);
      return true;
    }
    if (spec.kind === 'scroll' && spec.group !== null) {
      this.metadata.deferred(spec.group, path);
      this.metadata.merge(spec, path);
      return true;
    }
    if (this.visit.isInertia && this.clientHolds(spec, path)) {
      this.metadata.once(spec, path);
      return true;
    }
    return false;
  }

  /** Whether the client reported holding this once prop and it is not forced fresh. */
  private clientHolds(spec: PropSpec, path: string): boolean {
    return (
      spec.once !== null &&
      !spec.once.fresh &&
      this.visit.exceptOnce.includes(spec.once.key ?? path)
    );
  }
}

/** Collects the page metadata in the order the props are planned and resolved. */
class MetadataCollector {
  private readonly mergeProps: string[] = [];
  private readonly prependProps: string[] = [];
  private readonly deepMergeProps: string[] = [];
  private readonly matchPropsOn: string[] = [];
  private readonly deferredProps = new Map<string, string[]>();
  private readonly scrollProps = new Map<string, InertiaScrollMeta>();
  private readonly onceProps = new Map<string, InertiaOnceMeta>();

  constructor(
    private readonly visit: InertiaVisit,
    readonly selection: PartialSelection | null,
    private readonly now: () => number,
  ) {}

  deferred(group: string, path: string): void {
    const paths = this.deferredProps.get(group);
    if (paths === undefined) this.deferredProps.set(group, [path]);
    else paths.push(path);
  }

  /** Merge labels of a merge, deferred-merge, or scroll prop. */
  merge(spec: PropSpec, path: string): void {
    if (spec.merge === null && spec.scroll === null) return;
    if (this.visit.reset.includes(path)) return;
    if (this.selection !== null && !selectsMetadata(this.selection, path)) return;
    if (spec.scroll !== null) {
      const target = `${path}.data`;
      (this.visit.mergeIntent === 'prepend' ? this.prependProps : this.mergeProps).push(target);
      for (const field of spec.scroll.matchOn) this.matchPropsOn.push(`${target}.${field}`);
      return;
    }
    if (spec.merge === null) return;
    const list =
      spec.merge.mode === 'deep'
        ? this.deepMergeProps
        : spec.merge.mode === 'prepend'
          ? this.prependProps
          : this.mergeProps;
    list.push(path);
    for (const field of spec.merge.matchOn) this.matchPropsOn.push(`${path}.${field}`);
  }

  once(spec: PropSpec, path: string): void {
    if (spec.once === null) return;
    if (this.selection !== null && !selectsMetadata(this.selection, path)) return;
    const expiresAt =
      spec.once.expiresAt ?? (spec.once.ttlMs === null ? null : this.now() + spec.once.ttlMs);
    this.onceProps.set(spec.once.key ?? path, Object.freeze({ prop: path, expiresAt }));
  }

  /**
   * Record the metadata of a prop that resolved and is sent, and return the
   * value it is sent as: a scroll page goes out as `{ data }`, its page
   * identifiers moving to `scrollProps`.
   */
  included(spec: PropSpec, path: string, value: unknown): unknown {
    this.merge(spec, path);
    this.once(spec, path);
    if (spec.scroll === null) return value;
    if (!isScrollPage(value)) throw new InertiaError('invalid_props', { path });
    this.scrollProps.set(
      path,
      Object.freeze({
        pageName: spec.scroll.pageName,
        previousPage: value.previousPage,
        nextPage: value.nextPage,
        currentPage: value.currentPage,
        reset: this.visit.reset.includes(path),
      }),
    );
    return { data: value.data };
  }

  build(sharedKeys: readonly string[], rescued: readonly string[]): InertiaPropsMetadata {
    return Object.freeze({
      ...list('sharedProps', sharedKeys),
      ...list('mergeProps', this.mergeProps),
      ...list('prependProps', this.prependProps),
      ...list('deepMergeProps', this.deepMergeProps),
      ...list('matchPropsOn', this.matchPropsOn),
      ...record(
        'deferredProps',
        new Map([...this.deferredProps].map(([group, paths]) => [group, Object.freeze(paths)])),
      ),
      ...list('rescuedProps', rescued),
      ...record('scrollProps', this.scrollProps),
      ...record('onceProps', this.onceProps),
    });
  }
}

function list<K extends keyof InertiaPropsMetadata>(
  key: K,
  values: readonly string[],
): Partial<Record<K, readonly string[]>> {
  if (values.length === 0) return {};
  const entry: Partial<Record<K, readonly string[]>> = {};
  entry[key] = Object.freeze([...values]);
  return entry;
}

function record<K extends keyof InertiaPropsMetadata, V>(
  key: K,
  values: ReadonlyMap<string, V>,
): Partial<Record<K, Readonly<Record<string, V>>>> {
  if (values.size === 0) return {};
  const entry: Partial<Record<K, Readonly<Record<string, V>>>> = {};
  entry[key] = Object.freeze(Object.fromEntries(values));
  return entry;
}

function isPageId(value: unknown): value is string | number | null {
  return value === null || typeof value === 'string' || Number.isFinite(value);
}

function isScrollPage(value: unknown): value is {
  readonly data: readonly unknown[];
  readonly currentPage: string | number | null;
  readonly previousPage: string | number | null;
  readonly nextPage: string | number | null;
} {
  return (
    isPlainObject(value) &&
    Array.isArray(value.data) &&
    isPageId(value.currentPage) &&
    isPageId(value.previousPage) &&
    isPageId(value.nextPage)
  );
}
