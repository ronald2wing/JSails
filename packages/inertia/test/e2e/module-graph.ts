/**
 * Fresh module graphs of the real Inertia React client, on `preact/compat`
 * or on React 19.
 *
 * A synchronous `module.registerHooks` resolve hook gives every scenario its
 * own instance of @inertiajs/react, @inertiajs/core, and the renderer: a
 * graph is entered through a URL carrying `?inertia-e2e-graph=<flavor>-<n>`,
 * and the hook copies that query onto every file a module of the graph
 * imports, so the router singleton and the adapter's module state never leak
 * from one scenario into the next. In a `preact` graph the hook first maps
 * `react`, `react-dom`, `react-dom/client`, `react-dom/server`, and the JSX
 * runtimes to their `preact/compat` and `preact` counterparts, the aliasing
 * `@preact/preset-vite` applies in an app build. A `react` graph resolves
 * them to the real React 19 packages. React's CommonJS internals load through
 * `require`, keyed by file name, so one React instance serves every `react`
 * graph; that is harmless because each scenario mounts its own root.
 * Packages in {@link SHARED_PACKAGES} stay outside every graph and load once:
 * they hold no module state and read no DOM global when they evaluate, so a
 * per-graph copy would isolate nothing, while `es-toolkit`'s 540 modules
 * would dominate the time each scenario spends loading its graph.
 *
 * {@link registerCompatAliases} is the graph-less variant for the SSR worker:
 * every import in that thread resolves through the aliases, so the app, the
 * adapter, and preact-render-to-string share one Preact.
 *
 * The client modules have no type declarations here (`@types/react` is not
 * installed), so {@link loadClient} checks the exports it uses at run time
 * and describes them structurally.
 */

import { registerHooks } from 'node:module';
import type { ResolveFnOutput, ResolveHookContext } from 'node:module';

/** Which renderer a graph runs on. */
export type ClientFlavor = 'preact' | 'react';

/** The pinned upstream client this suite certifies; a bump is an explicit edit. */
export const CERTIFIED_CLIENT = Object.freeze({
  '@inertiajs/core': '3.11.0',
  '@inertiajs/react': '3.11.0',
  react: '19.3.1',
  'react-dom': '19.3.1',
});

/**
 * Every React API the certified `@inertiajs/react` imports, per module; for
 * `react`, members read off the default import count too. `preact/compat`
 * must provide each one. `use` matters most: `usePage()` reads its context
 * with it, and Preact's `use` subscribes differently from React's.
 */
export const CERTIFIED_REACT_API: Readonly<Record<string, readonly string[]>> = Object.freeze({
  react: Object.freeze([
    'Children',
    'Fragment',
    'StrictMode',
    'cloneElement',
    'createContext',
    'createElement',
    'forwardRef',
    'isValidElement',
    'startTransition',
    'use',
    'useCallback',
    'useEffect',
    'useImperativeHandle',
    'useMemo',
    'useRef',
    'useState',
    'useSyncExternalStore',
  ]),
  'react-dom': Object.freeze(['flushSync']),
  'react-dom/client': Object.freeze(['createRoot', 'hydrateRoot']),
});

const GRAPH_PARAM = 'inertia-e2e-graph';

const COMPAT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  react: 'preact/compat',
  'react-dom': 'preact/compat',
  'react-dom/client': 'preact/compat/client',
  'react-dom/server': 'preact/compat/server',
  'react/jsx-runtime': 'preact/jsx-runtime',
  'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
});

/**
 * Stateless dependencies of the client, shared by every graph. `es-toolkit`
 * is pure functions (`cloneDeep`, `isEqual`, `get`, `set`, `toPath` are what
 * @inertiajs/core imports); its only evaluation-time global read is Node's
 * own `globalThis`/`DOMException`, which the browser never replaces.
 */
const SHARED_PACKAGES: readonly string[] = Object.freeze(['es-toolkit']);

function isShared(url: string): boolean {
  return SHARED_PACKAGES.some((name) => url.includes(`/node_modules/${name}/`));
}

type NextResolve = (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput;

let graphHooks = false;
let graphCount = 0;

function graphOf(parentURL: string | undefined): string | null {
  if (parentURL === undefined || !parentURL.startsWith('file:')) return null;
  return new URL(parentURL).searchParams.get(GRAPH_PARAM);
}

function resolveInGraph(
  specifier: string,
  context: ResolveHookContext,
  next: NextResolve,
): ResolveFnOutput {
  const graph = graphOf(context.parentURL);
  if (graph === null) return next(specifier, context);
  const aliased = graph.startsWith('preact-')
    ? (COMPAT_ALIASES[specifier] ?? specifier)
    : specifier;
  const resolved = next(aliased, context);
  if (!resolved.url.startsWith('file:') || isShared(resolved.url)) return resolved;
  const url = new URL(resolved.url);
  url.searchParams.set(GRAPH_PARAM, graph);
  return { ...resolved, url: url.href };
}

function ensureGraphHooks(): void {
  if (graphHooks) return;
  registerHooks({ resolve: resolveInGraph });
  graphHooks = true;
}

/** Alias React to `preact/compat` for every import in this thread (the SSR worker). */
export function registerCompatAliases(): void {
  registerHooks({
    resolve: (specifier, context, next) => next(COMPAT_ALIASES[specifier] ?? specifier, context),
  });
}

/** A rendered element; opaque to the tests. */
export interface ClientElement {
  readonly type: unknown;
  readonly props: unknown;
}

/** Anything a component may render, or a render-function child (`<Deferred>`). */
export type ClientChild =
  | ClientElement
  | ((...slot: never[]) => unknown)
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ClientChild[];

/** A function component. */
export type ClientComponent<P = Readonly<Record<string, unknown>>> = (
  props: P,
) => ClientElement | null;

/** `createElement`, as React and `preact/compat` both export it. */
export type CreateElement = (
  type: unknown,
  props?: Readonly<Record<string, unknown>> | null,
  ...children: ClientChild[]
) => ClientElement;

/** The React API the demo components use. */
export interface ReactApi {
  readonly createElement: CreateElement;
  readonly Fragment: unknown;
  readonly memo: <P>(component: ClientComponent<P>) => unknown;
  readonly useState: <T>(initial: T) => [T, (next: T) => void];
}

/** The page object as the client holds it. */
export interface ClientPage {
  readonly component: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly url: string;
  readonly version: string | null;
  readonly flash: Readonly<Record<string, unknown>>;
}

/** A client event's payload. */
export interface ClientEvent {
  readonly detail: Readonly<Record<string, unknown>>;
}

/** The router methods the scenarios drive. */
export interface ClientRouter {
  reload(options?: Readonly<Record<string, unknown>>): void;
  visit(url: string, options?: Readonly<Record<string, unknown>>): void;
  post(url: string, data?: object, options?: Readonly<Record<string, unknown>>): void;
  put(url: string, data?: object, options?: Readonly<Record<string, unknown>>): void;
  on(event: string, callback: (event: ClientEvent) => void): () => void;
}

/** The `useForm` surface the scenarios use. */
export interface ClientForm {
  readonly data: Readonly<Record<string, unknown>>;
  readonly errors: Readonly<Record<string, string | undefined>>;
  readonly processing: boolean;
  setData(key: string, value: unknown): void;
  post(url: string, options?: Readonly<Record<string, unknown>>): void;
  submit(options?: Readonly<Record<string, unknown>>): void;
  validate(field?: string): unknown;
  valid(field: string): boolean;
  setValidationTimeout(milliseconds: number): unknown;
}

/** The @inertiajs/react exports the scenarios use. */
export interface InertiaReactApi {
  readonly createInertiaApp: (options: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly Link: unknown;
  readonly Head: unknown;
  readonly Deferred: unknown;
  readonly InfiniteScroll: unknown;
  readonly router: ClientRouter;
  readonly usePage: () => ClientPage;
  readonly useForm: (...args: unknown[]) => ClientForm;
}

/** One loaded client graph. */
export interface ClientModules {
  readonly flavor: ClientFlavor;
  readonly react: ReactApi;
  readonly inertia: InertiaReactApi;
}

function hasMembers(value: unknown, names: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return names.every((name) => {
    const member: unknown = Reflect.get(value, name);
    return member !== undefined;
  });
}

function isReactApi(value: unknown): value is ReactApi {
  return hasMembers(value, ['createElement', 'Fragment', 'memo', 'useState']);
}

function isInertiaReactApi(value: unknown): value is InertiaReactApi {
  return hasMembers(value, [
    'createInertiaApp',
    'Link',
    'Head',
    'Deferred',
    'InfiniteScroll',
    'router',
    'usePage',
    'useForm',
  ]);
}

/** Import a specifier inside a graph, or plainly when `graph` is `null`. */
async function importIn(specifier: string, graph: string | null): Promise<unknown> {
  const url = new URL(import.meta.resolve(specifier));
  if (graph !== null) url.searchParams.set(GRAPH_PARAM, graph);
  const loaded: unknown = await import(url.href);
  return loaded;
}

/**
 * Load a fresh client graph. Call it after the DOM globals are installed:
 * the client reads `window` when its modules evaluate.
 */
export async function loadClient(flavor: ClientFlavor): Promise<ClientModules> {
  ensureGraphHooks();
  graphCount += 1;
  const graph = `${flavor}-${graphCount}`;
  return loadModules(flavor, graph);
}

/** Load the client modules of this thread's single graph (the SSR worker). */
export function loadAliasedClient(): Promise<ClientModules> {
  return loadModules('preact', null);
}

async function loadModules(flavor: ClientFlavor, graph: string | null): Promise<ClientModules> {
  const inertia = await importIn('@inertiajs/react', graph);
  const reactSpecifier = flavor === 'preact' && graph !== null ? 'preact/compat' : 'react';
  const react = await importIn(reactSpecifier, graph);
  if (!isInertiaReactApi(inertia) || !isReactApi(react)) {
    throw new Error('the client modules do not export the expected API');
  }
  return { flavor, react, inertia };
}
