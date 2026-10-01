/**
 * Extension runner: a dependency-ordered, declared setup phase over the service
 * registry plus the HTTP contributions and serve hooks it collects.
 *
 * Extensions are plain objects, not classes and not registered globally. The
 * runner prevalidates them, topologically sorts by `requires`/`provides` contract
 * dependencies (with `priority` then declaration order as tiebreaks within each
 * layer), checks each extension's requirements against services registered
 * before it runs (waiting, when no instance declares one, for the later setup
 * that registers it), collects each entry's HTTP registrations (its own
 * registrar: routes, mounts, guards, transforms) and serve hooks, wires a
 * per-application interceptor/observer registry into the setup context, performs
 * a provider-count-plus-override check for every contract before any setup, seals
 * both registries, and hands back a runtime whose `close()` runs cleanups in
 * reverse and wipes the service registry.
 *
 * Contract-based ordering: when an extension declares a contract in `provides`
 * and another declares it in `requires`, the provider is guaranteed to run
 * before the consumer regardless of their declaration order. Contracts with
 * zero providers, or two non-override providers, fail value-free at load time.
 *
 * Plugin instances (the `definePlugin` contract of `jsails/kernel`) run beside
 * extensions. An instance declares the service tokens it provides, so the
 * runner orders it before every entry that requires or optionally reads one;
 * a service token an extension requires and no instance declares is still
 * checked inline, against what earlier entries registered. A legacy extension
 * declares no service it provides, so an entry that requires such a service
 * and reaches its turn before it is registered waits, together with every
 * entry ordered after it, until a later setup has registered it (an app's
 * `extensions` run after `plugins.use`, so a signals plugin there still serves
 * a `plugins.use` consumer); one still waiting once every other entry ran
 * fails with its `missing_service` error. An optional service is never
 * waited for, and an entry whose services are all registered at its turn
 * runs exactly where the sort put it. The steps of one
 * instance (its environment, its substrate resources, its setup with a
 * declared-only service view) live in `plugins/contract/host.ts`, shared with
 * the testing harness. An instance gets its own HTTP registrar, granted as an
 * extension's is (a managed plugin never mounts), and the process's mode, read
 * from the same environment as its variables. Lifecycle units are never
 * started here: by default a unit registered for a role this runner runs
 * fails its setup, and the kernel's services stage asks the runner to collect
 * the registrations instead (`units: 'collect'`) for its start stage.
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
 * No entry receives the router: HTTP reaches an extension only as its
 * registrar, so every route it adds states its access and runs inside the
 * route boundary. Importing this module never pulls HTTP or ORM code into the
 * runtime.
 */

import type { Server as NodeHttpServer } from 'node:http';

import type { ResolvedAppConfig } from '../app/config/index.js';
import {
  createHttpRoutes,
  type HttpContributions,
  type HttpRoutes,
  type HttpRoutesRegistrar,
} from '../server/http-routes.js';
import type { ReadinessProbe } from '../server/readiness.js';
import type { Guard } from '../server/request-frame.js';
import type { RequestScopeSpec } from '../server/request-scope.js';
import type { RouteOrigin } from '../server/route-meta.js';
import { isManagedPlugin } from '../plugins/plugin-origin.js';
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
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import { ContractErrors } from './contracts.js';
import type { LazyResource } from './lazy-resource.js';
import { PluginErrors } from '../plugins/contract/errors.js';
import { readPluginMode } from '../plugins/contract/env-variables.js';
import type { PluginMode } from '../plugins/contract/instance.js';
import {
  declareSubstrate,
  openSubstrate,
  readPluginEnv,
  runPluginSetup,
  type PluginHost,
} from '../plugins/contract/host.js';
import {
  isPluginInstance,
  type PluginInstance,
  type SubstrateResource,
} from '../plugins/contract/instance.js';
import {
  checkLifecycleRegistration,
  isPluginRole,
  type LifecycleRegistration,
  type PluginLifecycle,
  type PluginRole,
} from '../plugins/contract/lifecycle.js';

/**
 * What a serve hook receives besides the server: the resolved config and the
 * sealed service registry.
 *
 * @public
 */
export interface ServeContext {
  readonly config: ResolvedAppConfig;
  readonly services: ServiceRegistry;
}

/**
 * A participant in the server's drain: whatever a serve hook attached to the
 * server that does not finish by itself (a WebSocket server, a long-poll
 * transport). When the application closes, `drain` runs once, concurrently
 * with every other participant and the in-flight requests, after the server
 * stopped accepting connections: it disconnects its clients and resolves once
 * they are gone. `deadline` aborts at the shutdown deadline; whatever is still
 * open then is destroyed, and the close names this participant.
 *
 * @public
 */
export interface ServeAttachment {
  /** An identifier naming the participant in a shutdown report (`broadcast`). */
  readonly name: string;
  drain(deadline: AbortSignal): Promise<void>;
}

/**
 * A hook that runs when the application starts serving, after the HTTP server
 * is created (and its connections are tracked) but before it accepts a
 * connection. Hooks run in registration order and are awaited; a throwing or
 * rejecting hook aborts the serve and releases what earlier hooks attached.
 *
 * A hook that attaches something the server's drain cannot see returns it as
 * a {@link ServeAttachment}. A hook that adds an `upgrade` listener and
 * returns no attachment fails the serve (`serve.missing_attachment`): an
 * upgraded socket never finishes by itself, so nothing would close it before
 * the shutdown deadline.
 *
 * @public
 */
export type ServeHook = (
  server: NodeHttpServer,
  context: ServeContext,
) => Awaitable<ServeAttachment | void>;

/**
 * A serve hook and the extension that registered it, which a serve failure
 * names.
 *
 * @public
 */
export interface ServeHookRegistration {
  readonly hook: ServeHook;
  readonly owner: string;
}

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

const EXTENSION_ERRORS = {
  invalid_entry: {
    kind: 'internal',
    message: 'extension entry {index} is rejected: {problem}',
    context: { index: 'count', problem: ['not_object', 'invalid_name'] },
    suggestion: 'an extension is an object with an identifier name and a setup function',
  },
  invalid_extension: {
    kind: 'internal',
    message: 'extension {extension} is rejected: {problem}',
    context: {
      extension: 'identifier',
      problem: [
        'invalid_priority',
        'invalid_disabled',
        'duplicate_name',
        'missing_setup',
        'requires_not_array',
        'invalid_token',
        'provides_not_array',
        'invalid_provides_entry',
        'invalid_provides_override',
        'invalid_requires_union',
        'invalid_readiness',
        'duplicate_readiness_probe',
      ],
    },
  },
  missing_service: {
    kind: 'internal',
    message: 'extension {extension} requires service {token}, which is not registered',
    context: { extension: 'identifier', token: 'identifier' },
    suggestion: 'add the extension that provides the service, or remove the requirement',
  },
  dependency_cycle: {
    kind: 'internal',
    message: 'extension {extension} is in a dependency cycle among {count} extensions',
    context: { extension: 'identifier', count: 'count' },
  },
  invalid_hook: {
    kind: 'internal',
    message: 'an extension {hook} hook is not of its contract shape',
    context: { hook: ['serve', 'request_scope', 'guard'] },
    suggestion:
      'a request scope is a { name, cache, resolve } object; every other hook is a function',
  },
  sealed: {
    kind: 'internal',
    message: 'extension {hook} hooks can only be configured during setup',
    context: { hook: ['http', 'serve', 'request_scope', 'guard'] },
  },
  invalid_root: {
    kind: 'internal',
    message: 'the extension runner needs an absolute application root: {problem}',
    context: { problem: ['missing', 'not_absolute'] },
    suggestion: 'pass rootDir, the absolute directory of the app config',
  },
  invalid_roles: {
    kind: 'internal',
    message: 'the extension runner roles must be a list of web, worker and export',
  },
  invalid_units: {
    kind: 'internal',
    message: 'the extension runner units option must be refuse or collect',
  },
  duplicate_provider: {
    kind: 'internal',
    message: 'service {token} is declared by two plugins, {first} and {second}',
    context: { token: 'identifier', first: 'identifier', second: 'identifier' },
    suggestion:
      'configure each service once; a plugin configured once per key provides a keyed token (token.named(key)) for each instance',
  },
} as const;

/**
 * The extension runner's codes, `extension.*`: malformed entries, unmet
 * requirements, dependency cycles, hooks registered outside setup, and a
 * missing or relative application root.
 *
 * @public
 */
export const ExtensionErrors: ErrorRegistry<'extension', typeof EXTENSION_ERRORS> = defineErrors(
  'extension',
  EXTENSION_ERRORS,
);

/** The write-side surface handed to an extension during `setup`. */
export interface ExtensionContext {
  /** Registrar for services this extension provides. */
  readonly services: ServiceRegistrar;
  /**
   * Absolute path of the application root: the directory of the app config
   * the application was assembled from. Project files an extension reads
   * (generated registries, conventional directories) resolve against it,
   * never against the process working directory, so `--config` pointing at a
   * project from elsewhere still finds them.
   */
  readonly rootDir: string;
  /**
   * The mode the process runs in, as a plugin instance's setup sees it: its
   * `NODE_ENV` when that is `development` or `test`, else `production`.
   */
  readonly mode: PluginMode;
  /**
   * The extension's HTTP registrar (owner: its name), the only way it serves
   * HTTP: routes with a required `access`, mounted fetch handlers, guards
   * (walls in front of every route) and response transforms (rewrites of an
   * answer). Only valid while `setup` is running.
   */
  readonly routes: HttpRoutes;
  /** Register a serve hook; only valid while `setup` is running. */
  onServe(hook: ServeHook): void;
  /**
   * Register a {@link RequestScopeSpec}, resolved once per request when any
   * route claims it (pages, API routes, registrar routes and mounts, the
   * server-components transport); every one of them runs inside its binding.
   * Only valid while `setup` is running.
   */
  configureRequestScope(scope: RequestScopeSpec): void;
  /**
   * Register a {@link Guard}, run for every request before the body limit,
   * health probes, routes, and public files, after the app config's
   * `http.guards` (the same as `routes.guard`). Only valid while `setup` is
   * running.
   */
  configureGuard(guard: Guard): void;
  /**
   * Register a lifecycle unit for some roles, as a plugin instance does: the
   * kernel's start stage starts it in a process running one of them and
   * drains it on shutdown. Only valid while `setup` is running.
   */
  readonly lifecycle: PluginLifecycle;
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
   * already be registered by an earlier entry (a plugin instance that declares
   * it is ordered first); each {@link ContractToken} must be declared in
   * `provides` by an earlier extension (the topological sort guarantees this).
   * The run fails before `setup` when a requirement is unmet.
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

/**
 * What the runner runs: an extension (and so a `JsailsPlugin`), or an instance
 * of a plugin on the `definePlugin` contract (`jsails/kernel`).
 */
export type ExtensionEntry = JsailsExtension | PluginInstance;

/** The live result of a successful {@link runExtensions} call. */
export interface ExtensionRuntime {
  /** Read-only services, sealed after setup and closed after `close()`. */
  readonly services: ServiceRegistry;
  /**
   * Registrar routes and mounts, stamped with owner and origin: grouped by
   * owner in setup order, each owner's in call order (a call on an owner's
   * `routes` made during a later extension's setup counts as the owner's).
   */
  readonly routes: HttpContributions['routes'];
  /** Registrar response transforms, ordered like {@link routes}. */
  readonly transforms: HttpContributions['transforms'];
  /** Serve hooks with their owners, in setup registration order; never invoked by the runner. */
  readonly serveHooks: readonly ServeHookRegistration[];
  /**
   * Request scopes in setup registration order (so the extension order decides
   * their nesting); frozen after setup and never resolved by the runner.
   */
  readonly requestScopes: readonly RequestScopeSpec[];
  /**
   * Guards (`configureGuard` and `routes.guard`), ordered like
   * {@link routes}; frozen after setup and never invoked by the runner.
   */
  readonly guards: readonly Guard[];
  /**
   * Readiness probes of the extensions that ran, in setup order, each bound to
   * the sealed service registry. Never invoked by the runner.
   */
  readonly readinessProbes: readonly (readonly [string, ReadinessProbe])[];
  /** Sealed interceptor/observer registry; invocation still works after seal. */
  readonly interceptors: InterceptorRegistry;
  /**
   * The lifecycle units plugin instances registered, in registration order,
   * for every role. Empty unless the runner was asked to collect them
   * (`units: 'collect'`); never started by the runner.
   */
  readonly units: readonly LifecycleRegistration[];
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
  /**
   * The application root handed to every `setup` as
   * {@link ExtensionContext.rootDir}: an absolute path, which application
   * assembly and the CLI take from the app config's directory. It is required
   * because there is no safe default: the process working directory is not
   * the application root whenever `--config` names a project elsewhere, and an
   * extension that resolved project files against it would read another
   * directory's files. A missing or relative value fails with
   * `extension.invalid_root` before any setup runs.
   */
  readonly rootDir: string;
  /**
   * The roles the process runs, handed to every plugin instance's setup:
   * `web` and `worker` for an application that serves, `export` for a
   * static export, none for a command. Defaults to none.
   */
  readonly roles?: readonly PluginRole[];
  /**
   * What the runner does with a lifecycle unit a plugin registers. It never
   * starts one. `refuse` (the default): a unit registered for one of
   * {@link roles} fails its setup with `plugin.lifecycle_unavailable`, since
   * nothing would start it, and one registered only for other roles is left
   * alone. `collect`: every registration is kept, for every role, in the
   * runtime's `units`, for the kernel's start stage.
   */
  readonly units?: 'refuse' | 'collect';
  /**
   * The environment every plugin instance's declared variables, and the
   * process's mode (its `NODE_ENV`), are read from. Defaults to the process
   * environment; an instance only ever sees the variables it declares.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface CompletedExtension {
  readonly cleanup: ExtensionCleanup | undefined;
}

/** The units option, checked before any setup runs. */
function validateUnitsPolicy(units: unknown): 'refuse' | 'collect' {
  if (units === undefined || units === 'refuse') return 'refuse';
  if (units === 'collect') return 'collect';
  throw new ExtensionErrors.Error('invalid_units');
}

/** The roles option, checked before any setup runs. */
function validateRoles(roles: unknown): ReadonlySet<PluginRole> {
  if (roles === undefined) return new Set();
  if (!Array.isArray(roles) || !roles.every(isPluginRole)) {
    throw new ExtensionErrors.Error('invalid_roles');
  }
  return new Set(roles);
}

/**
 * A fully qualified path on the platform the runner runs on: `/…` on POSIX; a
 * drive root (`C:\…`, `C:/…`) or a UNC share (`\\server\share…`) on
 * Windows. Stricter than `node:path`'s `isAbsolute` on Windows, which also
 * accepts a rooted path with no drive (`\app`): that one still depends on the
 * process's current drive, the same working-directory dependence the
 * required root exists to remove. Written without `node:path` because this
 * module is part of the browser-tier `jsails/extensions` closure.
 */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/**
 * Check the application root before any registry exists or any setup runs.
 * The value itself is never echoed: it is a filesystem path.
 */
function validateRootDir(rootDir: unknown): string {
  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new ExtensionErrors.Error('invalid_root', { problem: 'missing' });
  }
  const absolute =
    process.platform === 'win32' ? WINDOWS_ABSOLUTE.test(rootDir) : rootDir.startsWith('/');
  if (!absolute) {
    throw new ExtensionErrors.Error('invalid_root', { problem: 'not_absolute' });
  }
  return rootDir;
}

/**
 * Validate names, uniqueness, priorities, disabled flags, setup functions, and
 * requirement shapes before any registry is created or any setup runs, so
 * malformed input has no side effects. The shared structural check lives in
 * `validation.ts`; this function raises its finding as an `extension.*` code.
 */
function validateExtensions(extensions: readonly ExtensionEntry[]): void {
  const error = validateExtensionEntries(extensions);
  if (error === undefined) return;
  throw describeExtensionEntryError(error);
}

function describeExtensionEntryError(error: ExtensionEntryError): Error {
  const { code, index, name } = error;
  if (code === 'not_object' || code === 'invalid_name' || name === undefined) {
    return new ExtensionErrors.Error('invalid_entry', {
      index,
      problem: code === 'not_object' ? 'not_object' : 'invalid_name',
    });
  }
  return new ExtensionErrors.Error('invalid_extension', { extension: name, problem: code });
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

/** Close every opened substrate resource in reverse, collecting failures. */
async function closeSubstrate(resources: readonly LazyResource<unknown>[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const resource of [...resources].reverse()) {
    try {
      await resource.close();
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

/** An active entry with its ordering keys. */
interface RankedEntry {
  readonly entry: ExtensionEntry;
  readonly priority: number;
  readonly index: number;
}

/** An entry with its ordering keys: `priority` (0 for a plugin instance) and its position. */
function rankEntry(entry: ExtensionEntry, index: number): RankedEntry {
  return { entry, priority: isPluginInstance(entry) ? 0 : (entry.priority ?? 0), index };
}

/**
 * The setup order the declarations alone fix: `entries` sorted as
 * {@link runExtensions} sorts them (the contract edges and the service tokens
 * plugin instances provide, then `priority`, then the given order), before
 * any environment is read. A token an instance declares only through its
 * substrate comes from the environment, so the runner, which reads it, may
 * order further by it; sorting this order again changes nothing else.
 */
export function orderExtensionEntries(
  entries: readonly ExtensionEntry[],
): readonly ExtensionEntry[] {
  const providers = new Map<ServiceToken<unknown>, PluginInstance>();
  for (const entry of entries) {
    if (!isPluginInstance(entry)) continue;
    for (const token of entry.provides) if (!providers.has(token)) providers.set(token, entry);
  }
  return orderEntries(entries.map(rankEntry), providers).ordered.map(({ entry }) => entry);
}

/** The topological order of the active entries and each entry's direct predecessors in it. */
interface OrderedEntries {
  readonly ordered: readonly RankedEntry[];
  readonly dependsOn: ReadonlyMap<ExtensionEntry, readonly ExtensionEntry[]>;
}

/** The service tokens an entry depends on: the edges that order it after their providers. */
function serviceDependencies(entry: ExtensionEntry): readonly ServiceToken<unknown>[] {
  if (isPluginInstance(entry)) return [...entry.requires, ...entry.optional];
  return (entry.requires ?? []).filter(
    (token): token is ServiceToken<unknown> => !isContractToken(token),
  );
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
      throw new ContractErrors.Error('missing_provider', { contract: contract.name });
    }
    if (info.count > 1 && info.overrideCount !== 1) {
      if (info.overrideCount === 0) {
        throw new ContractErrors.Error('ambiguous_provider', {
          contract: contract.name,
          providers: info.count,
        });
      }
      throw new ContractErrors.Error('too_many_overrides', {
        contract: contract.name,
        overrides: info.overrideCount,
      });
    }
  }
}

/**
 * The plugin instance that declares each service token (as provided, or as
 * a substrate resource). Two instances declaring one token fail here, before
 * any setup.
 */
function declaredProviders(
  instances: readonly PluginInstance[],
  substrate: ReadonlyMap<PluginInstance, readonly SubstrateResource<unknown>[]>,
): ReadonlyMap<ServiceToken<unknown>, PluginInstance> {
  const providers = new Map<ServiceToken<unknown>, PluginInstance>();
  for (const instance of instances) {
    const tokens = [
      ...instance.provides,
      ...(substrate.get(instance) ?? []).map((resource) => resource.token),
    ];
    for (const token of tokens) {
      const first = providers.get(token);
      if (first !== undefined) {
        throw new ExtensionErrors.Error('duplicate_provider', {
          token: token.name,
          first: first.name,
          second: instance.name,
        });
      }
      providers.set(token, instance);
    }
  }
  return providers;
}

/**
 * Topologically order the active entries (Kahn's algorithm, `priority` then
 * declaration order within each ready layer). Edges run from each contract
 * provider to every consumer that requires the contract; from a contract's
 * default provider to its override provider (the default registers with a
 * plain `provide`, so it must run first or it would collide with the
 * override's value instead of being replaced by it); and from the plugin
 * instance that declares a service token to every entry that requires or
 * optionally reads it.
 */
function orderEntries(
  active: readonly RankedEntry[],
  serviceProviders: ReadonlyMap<ServiceToken<unknown>, PluginInstance>,
): OrderedEntries {
  const position = new Map<ExtensionEntry, number>(active.map((ranked, i) => [ranked.entry, i]));
  const contractsOf = (i: number): readonly ContractTokenProvider[] => {
    const entry = active[i]!.entry;
    return isPluginInstance(entry) ? [] : (entry.provides ?? []);
  };
  const contractProviders = new Map<ContractToken<unknown>, number[]>();
  for (let i = 0; i < active.length; i += 1) {
    for (const p of contractsOf(i)) {
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
    if (from === to || edges.has(key)) return;
    edges.add(key);
    adjacency[from]!.push(to);
    indegree[to]! += 1;
  };

  for (let i = 0; i < active.length; i += 1) {
    const entry = active[i]!.entry;
    if (!isPluginInstance(entry)) {
      for (const req of entry.requires ?? []) {
        if (!isContractToken(req)) continue;
        for (const pid of contractProviders.get(req) ?? []) addEdge(pid, i);
      }
    }
    for (const token of serviceDependencies(entry)) {
      const provider = serviceProviders.get(token);
      const from = provider === undefined ? undefined : position.get(provider);
      if (from !== undefined) addEdge(from, i);
    }
  }

  for (const [contract, indices] of contractProviders) {
    const isOverride = (i: number): boolean =>
      contractsOf(i).some((p) => p.contract === contract && p.override === true);
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
  const ordered: RankedEntry[] = [];
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
    // Only the entries left unprocessed participate in (or wait on) a cycle.
    const stuck = active.filter((_, i) => !visited.has(i));
    throw new ExtensionErrors.Error('dependency_cycle', {
      extension: stuck[0]?.entry.name ?? '_',
      count: stuck.length,
    });
  }
  const dependsOn = new Map<ExtensionEntry, ExtensionEntry[]>();
  adjacency.forEach((targets, from) => {
    for (const to of targets) {
      const entry = active[to]!.entry;
      dependsOn.set(entry, [...(dependsOn.get(entry) ?? []), active[from]!.entry]);
    }
  });
  return { ordered, dependsOn };
}

/**
 * The order setups run in: `ordered`, except that an entry whose required
 * service is neither declared by an instance nor registered yet waits, with
 * every entry that depends on it, and is yielded as soon as an earlier setup
 * has registered it. A required service no instance declares can only come
 * from a legacy extension's setup, which declares nothing the sort could
 * order by. Entries still waiting at the end are yielded last, so the first
 * of them fails with its own `missing_service` error. The generator resumes
 * only after the caller ran the setup it yielded, so `registry` reflects it.
 */
function* scheduleEntries(
  { ordered, dependsOn }: OrderedEntries,
  serviceProviders: ReadonlyMap<ServiceToken<unknown>, PluginInstance>,
  registry: ServiceRegistry,
): Generator<RankedEntry> {
  const waiting: RankedEntry[] = [];
  const isWaiting = (entry: ExtensionEntry): boolean =>
    waiting.some((ranked) => ranked.entry === entry);
  const required = (entry: ExtensionEntry): readonly ServiceToken<unknown>[] =>
    isPluginInstance(entry)
      ? entry.requires
      : (entry.requires ?? []).filter(
          (token): token is ServiceToken<unknown> => !isContractToken(token),
        );
  const ready = ({ entry }: RankedEntry): boolean =>
    !(dependsOn.get(entry) ?? []).some(isWaiting) &&
    required(entry).every((token) => serviceProviders.has(token) || registry.has(token));
  for (const ranked of ordered) {
    if (!ready(ranked)) {
      waiting.push(ranked);
      continue;
    }
    yield ranked;
    for (let i = waiting.findIndex(ready); i !== -1; i = waiting.findIndex(ready)) {
      yield waiting.splice(i, 1)[0]!;
    }
  }
  yield* waiting.splice(0);
}

/**
 * Run extensions and plugin instances in dependency order (topological sort
 * over contract edges and declared service tokens, then `priority`
 * lowest-first, then declaration order) and return their runtime. An entry
 * that requires a service no instance declares, and that no earlier setup has
 * registered, waits with its dependents until a later legacy extension's
 * setup registers it.
 *
 * `options.rootDir` is the absolute application root every `setup` receives;
 * it is required and checked first, so a runner never falls back to the
 * process working directory. Disabled extensions are filtered out before
 * setup, and when `options.enabledNames` is supplied, entries whose `name` is
 * absent from it are skipped the same way and reported in the result's
 * `skipped` field. Before any setup runs, the runner verifies that every
 * required contract has exactly one non-override provider (plus at most one
 * override), validates every plugin instance's environment variables
 * (`config.invalid_env`), collects its substrate declaration, and refuses a
 * service token two instances declare, so a misdeclared graph fails with no
 * side effects. Substrate resources are registered as lazy handles before the
 * first setup and closed after the last cleanup. Setup writes to a fresh
 * service registry and may register interceptors and observers; both are
 * sealed after setup. On a setup failure the already-completed entries are
 * cleaned up in reverse, the registries are sealed/cleared whatever the
 * cleanups do, and the primary error is thrown (aggregated with any cleanup
 * errors).
 */
export async function runExtensions(
  extensions: readonly ExtensionEntry[],
  options: RunExtensionsOptions,
): Promise<ExtensionRuntime> {
  validateExtensions(extensions);
  const rootDir = validateRootDir(options?.rootDir);
  const roles = validateRoles(options.roles);
  const collectUnits = validateUnitsPolicy(options.units) === 'collect';
  const units: LifecycleRegistration[] = [];

  const enabled = options.enabledNames === undefined ? undefined : new Set(options.enabledNames);
  const skipped: string[] = [];

  const active: RankedEntry[] = extensions.map(rankEntry).filter(({ entry }) => {
    if (!isPluginInstance(entry) && entry.disabled === true) return false;
    if (enabled !== undefined && !enabled.has(entry.name)) {
      skipped.push(entry.name);
      return false;
    }
    return true;
  });

  // Every check below depends only on declarations, environment variables and
  // the connection-free substrate declarations, so a misdeclared graph fails
  // here, before any `setup` opens a pool, a worker, or a timer whose cleanup
  // the runner would never receive.
  const legacy = active.flatMap(({ entry }) => (isPluginInstance(entry) ? [] : [entry]));
  const instances = active.flatMap(({ entry }) => (isPluginInstance(entry) ? [entry] : []));
  assertContractProviders(legacy);
  const envs = new Map(
    instances.map((instance) => [instance, readPluginEnv(instance, options.env)] as const),
  );
  const substrate = new Map(
    instances.map(
      (instance) => [instance, declareSubstrate(instance, envs.get(instance)!, rootDir)] as const,
    ),
  );
  const serviceProviders = declaredProviders(instances, substrate);
  const order = orderEntries(active, serviceProviders);

  // The ambient scope module reaches `node:async_hooks`, so it is imported
  // lazily here to keep this barrel's static graph browser-bundleable. A browser
  // never calls `runExtensions`, so the reach is deferred to a call site that
  // only ever runs server-side.
  const { withAppScope } = await import('../facades/app-scope.js');

  const controller = createServiceRegistry();
  const interceptors = createInterceptorRegistry();
  const serveHooks: ServeHookRegistration[] = [];
  const requestScopes: RequestScopeSpec[] = [];
  // Every extension's registrar, in setup order. Their contributions are read
  // once setup is over, not when the owner's own setup returns: a provider may
  // hand its `routes` to a later extension, whose calls land in the
  // provider's registrar while setup is still open.
  const registrars: HttpRoutesRegistrar[] = [];
  let acceptingHooks = true;

  const mode = readPluginMode(options.env);
  const host: PluginHost = {
    registry: controller.registrar,
    roles,
    mode,
    rootDir,
    routes(instance) {
      const origin: RouteOrigin = isManagedPlugin(instance) ? 'managed-plugin' : 'code-plugin';
      const registrar = createHttpRoutes({
        owner: instance.name,
        origin,
        allow: { mount: origin !== 'managed-plugin', guard: true, transform: true },
      });
      registrars.push(registrar);
      return registrar.routes;
    },
    registerUnit(registration) {
      if (collectUnits) {
        units.push(registration);
        return;
      }
      // This runner starts nothing, so a unit for a role it runs would be
      // accepted and never started.
      if (registration.roles.some((role) => roles.has(role))) {
        throw new PluginErrors.Error('lifecycle_unavailable', {
          plugin: registration.owner,
          unit: registration.unit.name,
        });
      }
    },
    run: (call) => withAppScope(controller.services, call),
  };

  // --- setup pass ---
  const completed: CompletedExtension[] = [];
  const opened: LazyResource<unknown>[] = [];

  try {
    for (const instance of instances) {
      opened.push(...openSubstrate(controller.registrar, substrate.get(instance) ?? []));
    }
    for (const { entry, priority } of scheduleEntries(
      order,
      serviceProviders,
      controller.services,
    )) {
      if (isPluginInstance(entry)) {
        const cleanup = await runPluginSetup(
          entry,
          envs.get(entry)!,
          substrate.get(entry) ?? [],
          host,
        );
        completed.push({ cleanup });
        continue;
      }
      const extension = entry;
      // Check service tokens: they must already be registered.
      // Contract tokens: the topological sort guarantees the provider ran first,
      // so resolve through contract.token for the internal service-token check.
      for (const token of extension.requires ?? []) {
        // Contract tokens were checked by the provider-count pass before setup,
        // not inline here. Only service tokens are checked here.
        if (isContractToken(token)) continue;
        if (!controller.services.has(token)) {
          throw new ExtensionErrors.Error('missing_service', {
            extension: extension.name,
            token: token.name,
          });
        }
      }

      const origin: RouteOrigin = isManagedPlugin(extension) ? 'managed-plugin' : 'code-plugin';
      const registrar = createHttpRoutes({
        owner: extension.name,
        origin,
        // A managed plugin never mounts a fetch handler: its routes stay
        // inside the boundary's per-route access and cross-site checks.
        allow: { mount: origin !== 'managed-plugin', guard: true, transform: true },
      });
      registrars.push(registrar);
      const context: SetupContext = {
        services: controller.registrar,
        rootDir,
        mode,
        routes: sealedRoutes(registrar.routes, () => acceptingHooks),
        onServe(hook: ServeHook): void {
          if (!acceptingHooks) {
            throw new ExtensionErrors.Error('sealed', { hook: 'serve' });
          }
          if (typeof hook !== 'function') {
            throw new ExtensionErrors.Error('invalid_hook', { hook: 'serve' });
          }
          serveHooks.push(Object.freeze({ hook, owner: extension.name }));
        },
        configureRequestScope(scope: RequestScopeSpec): void {
          if (!acceptingHooks) {
            throw new ExtensionErrors.Error('sealed', { hook: 'request_scope' });
          }
          // The structure is checked here so a misbuilt scope fails its own
          // setup; createApp validates its name and cache class.
          if (
            scope === null ||
            typeof scope !== 'object' ||
            typeof (scope as { resolve?: unknown }).resolve !== 'function'
          ) {
            throw new ExtensionErrors.Error('invalid_hook', { hook: 'request_scope' });
          }
          requestScopes.push(scope);
        },
        configureGuard(guard: Guard): void {
          if (!acceptingHooks) {
            throw new ExtensionErrors.Error('sealed', { hook: 'guard' });
          }
          if (typeof guard !== 'function') {
            throw new ExtensionErrors.Error('invalid_hook', { hook: 'guard' });
          }
          registrar.routes.guard(guard);
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
        lifecycle: Object.freeze({
          register(roles: readonly PluginRole[], unit: unknown, unitOptions?: unknown): void {
            if (!acceptingHooks) {
              throw new PluginErrors.Error('invalid_lifecycle_unit', {
                plugin: extension.name,
                problem: 'after_setup',
              });
            }
            host.registerUnit(checkLifecycleRegistration(extension.name, roles, unit, unitOptions));
          },
        }),
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
    const cleanupErrors = [...(await runCleanups(completed)), ...(await closeSubstrate(opened))];
    controller.clear();
    throw combine(error, cleanupErrors);
  }

  acceptingHooks = false;
  interceptors.seal();
  controller.seal();

  const serveHookList: readonly ServeHookRegistration[] = Object.freeze(serveHooks.slice());
  const requestScopeList: readonly RequestScopeSpec[] = Object.freeze(requestScopes.slice());
  const http = collectHttp(registrars);
  const services = controller.services;
  const readinessProbes = Object.freeze(
    order.ordered.flatMap(({ entry }) =>
      isPluginInstance(entry)
        ? []
        : Object.entries(entry.readiness ?? {}).map(
            ([name, probe]) => [name, (signal: AbortSignal) => probe(signal, services)] as const,
          ),
    ),
  );

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const cleanupErrors = [...(await runCleanups(completed)), ...(await closeSubstrate(opened))];
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
    routes: http.routes,
    transforms: http.transforms,
    serveHooks: serveHookList,
    requestScopes: requestScopeList,
    guards: http.guards,
    readinessProbes,
    interceptors,
    units: Object.freeze(units.slice()),
    skipped,
    close,
  };
}

/**
 * `routes` refusing every call once setup is over, like the context's other
 * registration methods.
 */
function sealedRoutes(routes: HttpRoutes, open: () => boolean): HttpRoutes {
  const check = (): void => {
    if (!open()) throw new ExtensionErrors.Error('sealed', { hook: 'http' });
  };
  return Object.freeze({
    add(spec) {
      check();
      routes.add(spec);
    },
    mount(prefix, handler, options) {
      check();
      routes.mount(prefix, handler, options);
    },
    guard(guard) {
      check();
      routes.guard(guard);
    },
    transform(kinds, transform) {
      check();
      routes.transform(kinds, transform);
    },
  } satisfies HttpRoutes);
}

/**
 * What every registrar collected, grouped by owner in setup order and, within
 * an owner, in call order. Read after setup, so a call made on an owner's
 * registrar during a later extension's setup is kept.
 */
function collectHttp(registrars: readonly HttpRoutesRegistrar[]): HttpContributions {
  const routes: HttpContributions['routes'][number][] = [];
  const transforms: HttpContributions['transforms'][number][] = [];
  const guards: Guard[] = [];
  for (const registrar of registrars) {
    const collected = registrar.contributions();
    routes.push(...collected.routes);
    transforms.push(...collected.transforms);
    guards.push(...collected.guards);
  }
  return Object.freeze({
    routes: Object.freeze(routes),
    transforms: Object.freeze(transforms),
    guards: Object.freeze(guards),
  });
}
