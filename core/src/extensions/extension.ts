/**
 * Extension runner: a dependency-ordered, declared setup phase over the service
 * registry plus a collected set of HTTP hooks.
 *
 * Extensions are plain objects, not classes and not registered globally. The
 * runner prevalidates them, topologically sorts by `requires`/`provides` contract
 * dependencies (with `priority` then declaration order as tiebreaks within each
 * layer), checks each extension's requirements against services that earlier
 * extensions actually registered, collects HTTP hooks and serve hooks, wires a
 * per-application interceptor/observer registry into the setup context, performs
 * a provider-count-plus-override check for every contract before any setup, seals
 * both registries, and hands back a runtime whose `close()` runs cleanups in
 * reverse and wipes the service registry.
 *
 * Contract-based ordering: when an extension declares a contract in `provides`
 * and another declares it in `requires`, the provider is guaranteed to run
 * before the consumer regardless of their declaration order. Service tokens
 * in `requires` are still checked inline as before — they do not affect ordering.
 * Contracts with zero providers, or two non-override providers, fail value-free
 * at load time.
 *
 * Disabled extensions are filtered out before setup: their `setup` never runs
 * and their `requires`/`provides` are never considered. When `enabledNames` is
 * supplied, an extension whose `name` is absent from that list is skipped the
 * same way (its name is reported in the runtime's `skipped` field). An extension
 * (or module) may register interceptors/observers during setup; that surface is
 * sealed afterwards.
 *
 * Declared readiness probes are collected from the extensions that ran and
 * bound to the sealed service registry; the runner never invokes them.
 *
 * Hono is referenced through `import type` only: the router itself is the
 * maintained library, not a bespoke middleware engine, and importing this
 * module never pulls HTTP or ORM code into the runtime.
 */

import type { Context, Hono } from 'hono';
import type { Server as NodeHttpServer } from 'node:http';

import type { ResolvedAppConfig } from '../app/config/index.js';
import type { CliCommand } from '../cli/command-registry.js';
import type { AppEnv, AppMiddlewareHandler } from '../server/env.js';
import type { ReadinessProbe } from '../server/readiness.js';
import { isContractToken, type ContractToken, type ContractTokenProvider } from './contracts.js';
import {
  createInterceptorRegistry,
  type AfterInterceptor,
  type BeforeInterceptor,
  type EventToken,
  type InterceptorRegistry,
  type Observer,
  type OperationToken,
} from './interceptors.js';
import {
  createServiceRegistry,
  type ServiceRegistrar,
  type ServiceRegistry,
  type ServiceToken,
} from './services.js';
import { validateExtensionEntries, type ExtensionEntryError } from './validation.js';
import type { Awaitable } from '../contracts/awaitable.js';
import { JsailsError } from '../errors/jsails-error.js';

/**
 * A hook that augments the maintained Hono router. It is a plain callback, not
 * a custom middleware engine: the runner collects hooks during setup and the
 * server integration invokes them against the app.
 */
export type HttpExtensionHook = (app: Hono<AppEnv>) => Awaitable<void>;

/**
 * A wrapper the server runs around every framework-served route: filesystem
 * pages and API routes, the server-components transport (update, upload,
 * download), and the routes an {@link HttpExtensionHook} registers. It runs
 * once per request, after the session is settled on `c.var.session` and
 * before CSRF, `authorize`, route middleware, and the handler, so whatever it
 * makes ambient (an `AsyncLocalStorage` value) reaches all of them.
 *
 * A scope must call `next()` exactly once and await it; it cannot answer the
 * request itself. A scope that returns without calling `next()` fails the
 * request with the generic 500, and a second call throws. Scopes nest in
 * registration order: the first registered is the outermost.
 */
export type RequestScope = (c: Context<AppEnv>, next: () => Promise<void>) => Awaitable<void>;

/**
 * A hook that runs when the application starts serving, after the HTTP server
 * is created (and its connections are tracked) but before it listens. It
 * receives the bound `node:http.Server` plus a context carrying the resolved
 * config and the (sealed) service registry. Hooks run in registration order and
 * are awaited; a throwing/rejecting hook aborts the serve and triggers the
 * existing startup cleanup.
 */
export type ServeHook = (
  server: NodeHttpServer,
  context: { readonly config: ResolvedAppConfig; readonly services: ServiceRegistry },
) => Awaitable<void>;

/**
 * A readiness probe an extension contributes: a bounded check of a resource it
 * owns (a database `SELECT 1`, a Valkey `PING`). It receives the readiness
 * deadline's abort signal and the sealed service registry, so it can reach the
 * resource its `setup` provided. It passes unless it returns `false`, throws,
 * or outlives the deadline.
 */
export type ExtensionReadinessProbe = (
  signal: AbortSignal,
  services: ServiceRegistry,
) => Awaitable<unknown>;

/** Teardown returned from `setup`, invoked in reverse order on shutdown. */
export type ExtensionCleanup = () => Awaitable<void>;

/** Stable failure code carried by {@link ExtensionError}. */
export type ExtensionErrorCode = 'missing_service' | 'sealed';

/** Raised when an extension's requirements are unmet or a hook is registered after setup. */
export class ExtensionError extends JsailsError {
  constructor(
    readonly code: ExtensionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The write-side surface handed to an extension during `setup`. */
export interface ExtensionContext {
  /** Registrar for services this extension provides. */
  readonly services: ServiceRegistrar;
  /** Register an HTTP hook; only valid while `setup` is running. */
  configureHttp(hook: HttpExtensionHook): void;
  /** Register a serve hook; only valid while `setup` is running. */
  onServe(hook: ServeHook): void;
  /**
   * Register a global middleware handler that runs before every filesystem page
   * and API route. Only valid while `setup` is running; calling it after setup
   * throws, matching the same guard used by {@link configureHttp}.
   */
  configureMiddleware(handler: AppMiddlewareHandler): void;
  /**
   * Register a {@link RequestScope} run around every framework-served route
   * kind, including the server-components transport and hook routes that the
   * global middleware never reaches. Only valid while `setup` is running.
   */
  configureRequestScope(scope: RequestScope): void;
}

/**
 * The runtime setup context: the extension context plus interceptor/observer
 * registration. It is structurally the plugin-facing context (`PluginContext`)
 * but is defined here to keep this module free of any dependency on `plugin.ts`.
 */
interface SetupContext extends ExtensionContext {
  /** Register a before/after hook for `operation`; only valid during setup. */
  intercept(
    operation: OperationToken<unknown, unknown>,
    fn: BeforeInterceptor<unknown> | AfterInterceptor<unknown, unknown>,
    options?: { phase?: 'before' | 'after' },
  ): void;
  /** Register an observer for `event`; only valid during setup. */
  observe(event: EventToken<unknown>, fn: Observer<unknown>): void;
  /**
   * Read-only handle to the shared interceptor/observer registry. Exposed so a
   * plugin can wrap the shared registry as a service (e.g. {@code signalBus})
   * rather than creating an isolated local registry. Registration is still
   * guarded by the registry's own {@link InterceptorRegistry.seal} — exposing
   * this handle does not weaken the seal.
   */
  readonly interceptorRegistry: InterceptorRegistry;
}

/** A unit of extensibility. */
export interface JsailsExtension {
  /** Unique, non-empty name; duplicate names are rejected before setup runs. */
  readonly name: string;
  /**
   * Tokens this extension reads during setup. Each {@link ServiceToken} must
   * already be registered by an earlier extension; each {@link ContractToken}
   * must be declared in `provides` by an earlier extension (the topological
   * sort guarantees this). The run fails before `setup` when a requirement is
   * unmet.
   */
  readonly requires?: readonly (ServiceToken<unknown> | ContractToken<unknown>)[];
  /**
   * Contracts this extension fulfills. A contract in `requires` of a later
   * extension creates a topological dependency: the provider always runs
   * before the consumer. When `override` is `true`, this extension replaces an
   * earlier default provider for the same contract (the override's value wins
   * in the registry). At most one non-override plus at most one override per
   * contract is permitted; zero providers or duplicate non-override providers
   * is a load-time error.
   */
  readonly provides?: readonly ContractTokenProvider[];
  /**
   * Ordering key for the setup phase. Within a topological layer, lower
   * priorities run first; ties keep declaration order. Defaults to `0`.
   */
  readonly priority?: number;
  /**
   * When `true`, the extension is filtered out before setup: its `setup` never
   * runs and its `requires` are never checked. Still structurally validated.
   */
  readonly disabled?: boolean;
  /**
   * CLI commands this extension contributes to the application command
   * namespace. They are metadata for the config loader and CLI integration
   * writer: {@link runExtensions} never validates, collects, or invokes them,
   * and the reference is pulled in through `import type`, so this module gains
   * no runtime CLI, queue, or ORM dependency.
   */
  readonly commands?: readonly CliCommand[];
  /**
   * Named readiness probes served by the app's readiness endpoint
   * (`<healthPath>?deep=1` and `readiness.path`). They are declared, not
   * registered in `setup`, so they survive any wrapper that rebuilds the setup
   * context; a disabled or skipped extension contributes none. Names share one
   * namespace across every extension and the app config's `readiness.probes`.
   */
  readonly readiness?: Readonly<Record<string, ExtensionReadinessProbe>>;
  /**
   * Provide services and register hooks. May return a cleanup function (or a
   * promise of one) for resources acquired here.
   *
   * An extension that throws before returning its teardown owns the cleanup of
   * whatever it partially created: the runner cannot dispose of resources whose
   * handles it never received. Return the teardown as soon as the resources
   * exist so the runner can clean them up on a later failure.
   */
  setup(context: ExtensionContext): Awaitable<void | ExtensionCleanup>;
}

/** The live result of a successful {@link runExtensions} call. */
export interface ExtensionRuntime {
  /** Read-only services, sealed after setup and closed after `close()`. */
  readonly services: ServiceRegistry;
  /** HTTP hooks in setup registration order; never invoked by the runner. */
  readonly httpHooks: readonly HttpExtensionHook[];
  /** Serve hooks in setup registration order; never invoked by the runner. */
  readonly serveHooks: readonly ServeHook[];
  /**
   * Global middleware handlers in setup registration order; frozen after setup.
   * The server layer composes these ahead of per-route middleware. Handlers are
   * collected but never invoked by the runner — they are pure metadata until the
   * HTTP layer applies them at request time.
   */
  readonly middleware: readonly AppMiddlewareHandler[];
  /**
   * Request scopes in setup registration order (so the extension order decides
   * their nesting); frozen after setup and never invoked by the runner.
   */
  readonly requestScopes: readonly RequestScope[];
  /**
   * Readiness probes of the extensions that ran, in setup order, each bound to
   * the sealed service registry. Never invoked by the runner.
   */
  readonly readinessProbes: readonly (readonly [string, ReadinessProbe])[];
  /** Sealed interceptor/observer registry; invocation still works after seal. */
  readonly interceptors: InterceptorRegistry;
  /**
   * Names of extensions skipped because they were not in `enabledNames`, in
   * declaration order. Empty when no allowlist was supplied (or nothing was
   * skipped). Disabled extensions are not reported here.
   */
  readonly skipped: readonly string[];
  /** Reverse cleanup then clear; idempotent and safe for concurrent callers. */
  close(): Promise<void>;
}

/** Options for {@link runExtensions}. */
export interface RunExtensionsOptions {
  /**
   * When provided, only extensions whose `name` is in this list are run. An
   * extension whose name is absent is skipped before setup: its `requires` are
   * never checked and its `setup` never runs, and its name is reported in the
   * runtime's `skipped` field. A service a skipped extension would have
   * provided is therefore never registered, so a later consumer of it fails
   * with the missing-requirement error. `undefined` runs every extension.
   */
  readonly enabledNames?: readonly string[];
}

interface CompletedExtension {
  readonly cleanup: ExtensionCleanup | undefined;
}

/**
 * Validate names, uniqueness, priorities, disabled flags, setup functions, and
 * requirement shapes before any registry is created or any setup runs, so
 * malformed input has no side effects. The shared structural check lives in
 * `validation.ts`; this function maps its error codes to name-echoing
 * `TypeError`s.
 */
function validateExtensions(extensions: readonly JsailsExtension[]): void {
  const error = validateExtensionEntries(extensions);
  if (error === undefined) return;
  throw describeExtensionEntryError(error);
}

/** Map a shared validation error to a name-echoing `TypeError`. */
function describeExtensionEntryError(error: ExtensionEntryError): TypeError {
  switch (error.code) {
    case 'not_object':
      return new TypeError('extension must be an object');
    case 'missing_name':
      return new TypeError('extension name must be a non-empty string');
    case 'invalid_priority':
      return new TypeError(`extension "${error.name}" priority must be a finite number`);
    case 'invalid_disabled':
      return new TypeError(`extension "${error.name}" disabled must be a boolean`);
    case 'duplicate_name':
      return new TypeError(`duplicate extension name "${error.name}"`);
    case 'missing_setup':
      return new TypeError(`extension "${error.name}" must define a setup function`);
    case 'requires_not_array':
      return new TypeError(
        `extension "${error.name}" requires must be an array of service or contract tokens`,
      );
    case 'invalid_token':
      return new TypeError(`extension "${error.name}" requires an invalid token`);
    case 'provides_not_array':
      return new TypeError(
        `extension "${error.name}" provides must be an array of contract token providers`,
      );
    case 'invalid_provides_entry':
      return new TypeError(`extension "${error.name}" provides an invalid entry`);
    case 'invalid_provides_override':
      return new TypeError(`extension "${error.name}" provides entry override must be a boolean`);
    case 'invalid_requires_union':
      return new TypeError(`extension "${error.name}" requires an invalid token`);
    case 'invalid_readiness':
      return new TypeError(
        `extension "${error.name}" readiness must be an object of named probe functions`,
      );
    case 'duplicate_readiness_probe':
      return new TypeError(
        `extension "${error.name}" declares a readiness probe name another extension uses`,
      );
  }
}

/** Run every cleanup in reverse, collecting failures instead of aborting. */
async function runCleanups(completed: readonly CompletedExtension[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const entry of [...completed].reverse()) {
    if (entry.cleanup === undefined) continue;
    try {
      await entry.cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

/** Keep the primary failure first, aggregating cleanup failures behind it. */
function combine(primary: unknown, cleanupErrors: readonly unknown[]): unknown {
  if (cleanupErrors.length === 0) return primary;
  return new AggregateError([primary, ...cleanupErrors], 'extension setup failed', {
    cause: primary,
  });
}

/** An active extension with its ordering keys. */
interface RankedExtension {
  readonly extension: JsailsExtension;
  readonly priority: number;
  readonly index: number;
}

/**
 * Verify that every required contract has exactly one non-override provider,
 * plus at most one override. Runs before any setup so a failure has no side
 * effects. Contract names are developer labels, never input values.
 */
function assertContractProviders(extensions: readonly JsailsExtension[]): void {
  const providers = new Map<ContractToken<unknown>, { count: number; overrideCount: number }>();
  for (const extension of extensions) {
    for (const p of extension.provides ?? []) {
      const existing = providers.get(p.contract);
      if (existing !== undefined) {
        existing.count += 1;
        if (p.override === true) existing.overrideCount += 1;
      } else {
        providers.set(p.contract, { count: 1, overrideCount: p.override === true ? 1 : 0 });
      }
    }
  }

  const requiredContracts = new Set<ContractToken<unknown>>();
  for (const extension of extensions) {
    for (const req of extension.requires ?? []) {
      if (isContractToken(req)) requiredContracts.add(req);
    }
  }

  for (const contract of requiredContracts) {
    const info = providers.get(contract);
    if (info === undefined) {
      throw new TypeError(`contract "${contract.name}" is required but no extension provides it`);
    }
    if (info.count > 1 && info.overrideCount !== 1) {
      if (info.overrideCount === 0) {
        throw new TypeError(
          `contract "${contract.name}" has ${info.count} providers and no override`,
        );
      }
      throw new TypeError(
        `contract "${contract.name}" has ${info.count} providers and ${info.overrideCount} overrides (at most one override is allowed)`,
      );
    }
  }
}

/**
 * Topologically order the active extensions (Kahn's algorithm, `priority` then
 * declaration order within each ready layer). Edges run from each contract
 * provider to every consumer that requires the contract, and from a contract's
 * default provider to its override provider: the default registers with a
 * plain `provide`, so it must run first or it would collide with the override's
 * value instead of being replaced by it.
 */
function orderExtensions(active: readonly RankedExtension[]): RankedExtension[] {
  const contractProviders = new Map<ContractToken<unknown>, number[]>();
  for (let i = 0; i < active.length; i += 1) {
    for (const p of active[i]!.extension.provides ?? []) {
      const existing = contractProviders.get(p.contract);
      if (existing !== undefined) {
        if (!existing.includes(i)) existing.push(i);
      } else {
        contractProviders.set(p.contract, [i]);
      }
    }
  }

  const indegree = new Array<number>(active.length).fill(0);
  const adjacency = Array.from<unknown, number[]>({ length: active.length }, () => []);
  const edges = new Set<string>();
  const addEdge = (from: number, to: number): void => {
    const key = `${from}>${to}`;
    if (edges.has(key)) return;
    edges.add(key);
    adjacency[from]!.push(to);
    indegree[to]! += 1;
  };

  for (let i = 0; i < active.length; i += 1) {
    for (const req of active[i]!.extension.requires ?? []) {
      if (!isContractToken(req)) continue;
      for (const pid of contractProviders.get(req) ?? []) addEdge(pid, i);
    }
  }

  for (const [contract, indices] of contractProviders) {
    const isOverride = (i: number): boolean =>
      (active[i]!.extension.provides ?? []).some(
        (p) => p.contract === contract && p.override === true,
      );
    const overrides = indices.filter(isOverride);
    const defaults = indices.filter((i) => !isOverride(i));
    for (const d of defaults) {
      for (const o of overrides) addEdge(d, o);
    }
  }

  const sortLayer = (items: readonly number[]): number[] =>
    [...items].sort((a, b) => {
      const ea = active[a]!;
      const eb = active[b]!;
      return ea.priority - eb.priority || ea.index - eb.index;
    });

  const queue: number[] = sortLayer(
    indegree.reduce<number[]>((acc, deg, i) => (deg === 0 ? [...acc, i] : acc), []),
  );
  const ordered: RankedExtension[] = [];
  const visited = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited.add(current);
    ordered.push(active[current]!);
    const next: number[] = [];
    for (const neighbor of adjacency[current]!) {
      indegree[neighbor]! -= 1;
      if (indegree[neighbor]! === 0) next.push(neighbor);
    }
    queue.push(...sortLayer(next));
  }

  if (ordered.length !== active.length) {
    // Only the extensions left unprocessed participate in (or wait on) a cycle.
    const names = active
      .filter((_, i) => !visited.has(i))
      .map((a) => a.extension.name)
      .join(', ');
    throw new TypeError(`extension dependency cycle detected; extensions: ${names}`);
  }
  return ordered;
}

/**
 * Run extensions in dependency order (topological sort over `requires`/
 * `provides` contract edges, then `priority` lowest-first, then declaration
 * order) and return their runtime.
 *
 * Disabled extensions are filtered out before setup, and when
 * `options.enabledNames` is supplied, extensions whose `name` is absent from
 * it are skipped the same way and reported in the result's `skipped` field.
 * Setup writes to a fresh service registry and may register interceptors and
 * observers; the interceptor registry is sealed after setup. Before any setup
 * runs, the runner verifies that every required contract has exactly one
 * non-override provider (plus at most one override), so a misdeclared graph
 * fails with no side effects. On a setup failure the
 * already-completed extensions are cleaned up in reverse, the registries are
 * sealed/cleared whatever the cleanups do, and the primary error is thrown
 * (aggregated with any cleanup errors).
 */
export async function runExtensions(
  extensions: readonly JsailsExtension[],
  options: RunExtensionsOptions = {},
): Promise<ExtensionRuntime> {
  validateExtensions(extensions);

  // The ambient scope module reaches `node:async_hooks`, so it is imported
  // lazily here to keep this barrel's static graph browser-bundleable. A browser
  // never calls `runExtensions`, so the reach is deferred to a call site that
  // only ever runs server-side.
  const { withAppScope } = await import('../facades/app-scope.js');

  const controller = createServiceRegistry();
  const interceptors = createInterceptorRegistry();
  const hooks: HttpExtensionHook[] = [];
  const serveHooks: ServeHook[] = [];
  const middlewareHandlers: AppMiddlewareHandler[] = [];
  const requestScopes: RequestScope[] = [];
  let acceptingHooks = true;

  const enabled = options.enabledNames === undefined ? undefined : new Set(options.enabledNames);
  const skipped: string[] = [];

  const active = extensions
    .map((extension, index) => ({
      extension,
      priority: extension.priority ?? 0,
      index,
    }))
    .filter(({ extension }) => {
      if (extension.disabled === true) return false;
      if (enabled !== undefined && !enabled.has(extension.name)) {
        skipped.push(extension.name);
        return false;
      }
      return true;
    });

  // Every contract check depends only on the static `provides`/`requires`
  // declarations, so a misdeclared graph fails here, before any `setup` opens a
  // pool, a worker, or a timer whose cleanup the runner would never receive.
  assertContractProviders(active.map(({ extension }) => extension));
  const ordered = orderExtensions(active);

  // --- setup pass ---
  const completed: CompletedExtension[] = [];

  try {
    for (const { extension, priority } of ordered) {
      // Check service tokens: they must already be registered.
      // Contract tokens: the topological sort guarantees the provider ran first,
      // so resolve through contract.token for the internal service-token check.
      for (const token of extension.requires ?? []) {
        // Contract tokens were checked by the provider-count pass before setup,
        // not inline here. Only service tokens are checked here.
        if (isContractToken(token)) continue;
        if (!controller.services.has(token)) {
          throw new ExtensionError(
            'missing_service',
            `extension "${extension.name}" requires service "${token.name}" which is not registered`,
          );
        }
      }

      const context: SetupContext = {
        services: controller.registrar,
        configureHttp(hook: HttpExtensionHook): void {
          if (!acceptingHooks) {
            throw new ExtensionError(
              'sealed',
              'http hooks can only be configured during extension setup',
            );
          }
          if (typeof hook !== 'function') {
            throw new TypeError('http hook must be a function');
          }
          hooks.push(hook);
        },
        onServe(hook: ServeHook): void {
          if (!acceptingHooks) {
            throw new ExtensionError(
              'sealed',
              'serve hooks can only be configured during extension setup',
            );
          }
          if (typeof hook !== 'function') {
            throw new TypeError('serve hook must be a function');
          }
          serveHooks.push(hook);
        },
        configureMiddleware(handler: AppMiddlewareHandler): void {
          if (!acceptingHooks) {
            throw new ExtensionError(
              'sealed',
              'middleware can only be configured during extension setup',
            );
          }
          if (typeof handler !== 'function') {
            throw new TypeError('middleware handler must be a function');
          }
          middlewareHandlers.push(handler);
        },
        configureRequestScope(scope: RequestScope): void {
          if (!acceptingHooks) {
            throw new ExtensionError(
              'sealed',
              'request scopes can only be configured during extension setup',
            );
          }
          if (typeof scope !== 'function') {
            throw new TypeError('request scope must be a function');
          }
          requestScopes.push(scope);
        },
        intercept(operation, fn, options): void {
          interceptors.intercept(operation, fn, {
            ...options,
            priority,
            moduleName: extension.name,
          });
        },
        observe(event, fn): void {
          interceptors.observe(event, fn, {
            priority,
            moduleName: extension.name,
          });
        },
        interceptorRegistry: interceptors,
      };
      // Run setup inside the ambient app scope so a setup body may call
      // facades; the scope holds the live registry, which is being populated
      // during this pass.
      const result = await withAppScope(controller.services, () => extension.setup(context));
      completed.push({
        cleanup: typeof result === 'function' ? result : undefined,
      });
    }
  } catch (error) {
    acceptingHooks = false;
    interceptors.seal();
    const cleanupErrors = await runCleanups(completed);
    controller.clear();
    throw combine(error, cleanupErrors);
  }

  acceptingHooks = false;
  interceptors.seal();
  controller.seal();

  const httpHooks: readonly HttpExtensionHook[] = hooks.slice();
  const serveHookList: readonly ServeHook[] = serveHooks.slice();
  const middlewareList: readonly AppMiddlewareHandler[] = middlewareHandlers.slice();
  const requestScopeList: readonly RequestScope[] = Object.freeze(requestScopes.slice());
  const services = controller.services;
  const readinessProbes = Object.freeze(
    ordered.flatMap(({ extension }) =>
      Object.entries(extension.readiness ?? {}).map(
        ([name, probe]) => [name, (signal: AbortSignal) => probe(signal, services)] as const,
      ),
    ),
  );

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const cleanupErrors = await runCleanups(completed);
      controller.clear();
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, 'extension cleanup failed');
      }
    })();
    return closing;
  };

  return {
    services: controller.services,
    httpHooks,
    serveHooks: serveHookList,
    middleware: middlewareList,
    requestScopes: requestScopeList,
    readinessProbes,
    interceptors,
    skipped,
    close,
  };
}
