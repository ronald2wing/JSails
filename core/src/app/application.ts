/**
 * Application runtime assembly, on the kernel stages.
 *
 * `createApplication` turns a loaded app (or a bare {@link ResolvedAppConfig})
 * into a runnable {@link Application}: the kernel resolves its plugin graph
 * for the roles the process runs (`resolvePlugins`), opens its services
 * (`openServices`: every plugin's setup, connection-free, and the lifecycle
 * plan validated), and {@link assembleApplication} reads the route manifest,
 * the default page renderer and the static-site generator from them. It is
 * deliberately inert about infrastructure: it never initializes a database or
 * a Valkey connection itself, and nothing listens.
 *
 * {@link Application.start} starts the kernel (`start`): the lifecycle units
 * of the process's roles (`jsails work` runs nothing else).
 * {@link Application.build} renders the static
 * site through the resolved generator and never listens on a port.
 * {@link Application.standby} starts the kernel, assembles the HTTP pipeline
 * (`http-pipeline.ts`: `createApp` over the routes and the asset index) and
 * opens one HTTP server through `openServer` (`serve.ts`),
 * which runs each collected serve hook (e.g. the broadcast plugin's, which
 * attaches its transport to that same server and returns it as a drain
 * participant). The server joins the kernel as an `http` unit, which drains
 * before every unit started earlier. It is then ready and accepts nothing
 * until {@link StandbyServer.accept}: a supervisor's candidate process reports
 * ready while connections wait in the backlog of the listening handle it was
 * passed. {@link Application.serve} is standby and accept in one call.
 *
 * Assembling an application and serving it are separate on purpose: the
 * pipeline and the server modules are imported on the first `fetch` or
 * `serve`, never by `build`, so a static build loads neither the request
 * stack nor `@hono/node-server`.
 *
 * {@link Application.fetch} routes a single {@link Request} through the same
 * assembled Hono pipeline without constructing an HTTP server, listening,
 * starting a unit or running a serve hook. The pipeline (`createApp` over the
 * registrars' contributions and the asset index) is assembled lazily and memoized once, so `fetch` and `serve` share one app and it is
 * compiled exactly once per successful assembly. A failed assembly is
 * forgotten so a later request retries it from scratch. `fetch` calls are independent: they
 * run concurrently like a real server rather than behind the build/serve
 * lock.
 *
 * The asset index of `config.publicDir` (`createAssetIndex`; a watching one
 * when the application's mode is development, otherwise a snapshot hashed
 * once) is built on the first `build`, `fetch` or `serve` and shared by all
 * three, so a command that only inspects an application never reads
 * `public/`. A failed build of it is forgotten, like a failed assembly; a
 * development index stops watching on `close()`, after the services closed.
 *
 * `close()` waits for any in-flight `fetch` handler to return its `Response`
 * (only handler completion: a streamed body is the caller's to consume), then
 * shuts the kernel down under one `config.shutdownTimeoutMs` deadline: the
 * HTTP servers drain first, concurrently, with their drain participants (see
 * `serve.ts`), then the units in reverse dependency order; whatever is not
 * idle at the deadline, or when the close's `signal` aborts (a second
 * shutdown signal), is aborted. The services close last: the app's own
 * cleanup, then every plugin cleanup in reverse. Every step is attempted even
 * when earlier ones fail, and `close()` is idempotent and safe for concurrent
 * callers. An application that never started closes its services alone.
 */

import type { Server as NodeHttpServer } from 'node:http';

import type { Hono } from 'hono';

import { createAssetIndex, type AssetIndex } from '../assets/asset-index.js';
import { JsailsError } from '../errors/jsails-error.js';
import type { ServiceRegistry } from '../extensions/services.js';
import { withAppScope } from '../facades/app-scope.js';
import { KernelStageErrors } from '../kernel/errors.js';
import { dedicatedUnits } from '../kernel/lifecycle-plan.js';
import { isLoadedApp, type LoadedApp } from '../kernel/load-app.js';
import { openServices, type ServicesPurpose } from '../kernel/open-services.js';
import { resolvePlugins } from '../kernel/resolve-plugins.js';
import { start, type AdoptedUnit, type Kernel, type ShutdownReport } from '../kernel/start.js';
import type { GenerateStaticSiteResult } from '../pages/static-site/index.js';
import { readPluginMode } from '../plugins/contract/env-variables.js';
import type { LifecycleUnit, PluginRole } from '../plugins/contract/lifecycle.js';
import type { RouteManifest } from '../routing/routes.js';
import type { AppEnv } from '../server/env.js';
import type { ReadinessProbe } from '../server/readiness.js';
import { assembleApplication } from './assemble.js';
import type { ResolvedAppConfig } from './config/index.js';
import type { HttpListener, ListenHandle, ServeAddress } from './serve.js';

/** The failures an {@link Application} raises itself. */
export type ApplicationErrorCode = 'closed';

/** Raised by `build`, `serve`, and `fetch` once the application is closed. */
export class ApplicationError extends JsailsError {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A runnable application assembled from a {@link ResolvedAppConfig}. */
export interface Application {
  /** The resolved config this application is assembled from. */
  readonly config: ResolvedAppConfig;
  /** The discovered route manifest (pages and API routes). */
  readonly manifest: RouteManifest;
  /** Read-only services provided by the applied extensions. */
  readonly services: ServiceRegistry;
  /** The roles the application runs (see {@link CreateApplicationOptions.roles}). */
  readonly roles: readonly PluginRole[];
  /** The names of the lifecycle units the application runs, in start order. */
  readonly units: readonly string[];
  /**
   * The names of the units among {@link units} registered for no role the
   * application leaves out, in start order: what a process of exactly these
   * roles runs that no other process of the app does. A connection unit
   * every role registers is not one of them. `jsails work` refuses a worker
   * without one (`kernel.no_units`).
   */
  readonly dedicatedUnits: readonly string[];
  /**
   * Start the lifecycle units of the application's roles without listening;
   * once, later calls share the first. `serve` and `standby` start them
   * first.
   */
  start(): Promise<void>;
  /** Render the static site into `config.outDir`; never opens a port. */
  build(): Promise<GenerateStaticSiteResult>;
  /** Assemble the HTTP server, run every serve hook, and accept connections. */
  serve(options?: ServeOptions): Promise<ServeHandle>;
  /**
   * Assemble the HTTP server and run every serve hook, then stand by: the
   * server is ready and accepts no connection until
   * {@link StandbyServer.accept}.
   */
  standby(options?: ServeOptions): Promise<StandbyServer>;
  /**
   * Route one request through the shared Hono pipeline. No HTTP server is
   * constructed, nothing listens, and no serve hook runs. Requests
   * are independent and may run concurrently. The returned `Response`'s body
   * is the caller's to consume; `close` does not drain streamed bodies.
   */
  fetch(request: Request): Promise<Response>;
  /**
   * Drain the HTTP servers and the units under one deadline, abort what is
   * not idle, then run the app cleanup and the plugin cleanups in reverse.
   */
  close(options?: CloseOptions): Promise<void>;
}

/**
 * Options for {@link Application.close}.
 *
 * @public
 */
export interface CloseOptions {
  /**
   * Aborting it cuts the drain short: every server and unit not idle is
   * aborted at once (the second SIGINT/SIGTERM).
   */
  readonly signal?: AbortSignal;
}

/**
 * Options for {@link Application.serve} and {@link Application.standby}.
 *
 * @public
 */
export interface ServeOptions {
  /**
   * Listen on this handle, bound and passed by another process (a
   * supervisor), instead of `config.host` and `config.port`. Connections
   * wait in its backlog until the server accepts (see `ListenHandle`).
   */
  readonly handle?: ListenHandle;
}

/**
 * An HTTP server whose serve hooks ran and which accepts no connection yet.
 *
 * @public
 */
export interface StandbyServer {
  /** The bound `node:http.Server`, not yet listening. */
  readonly server: NodeHttpServer;
  /**
   * Start accepting connections. A failure releases the server (the
   * application can serve again); after `close()` it is refused with an
   * {@link ApplicationError} `closed`.
   */
  accept(): Promise<ServeHandle>;
  /** Shut the whole application down; delegates to {@link Application.close}. */
  close(options?: CloseOptions): Promise<void>;
}

/** A listening HTTP server owned by {@link Application.serve}. */
export interface ServeHandle {
  /** The bound `node:http.Server`; serve hooks (e.g. broadcast) share it. */
  readonly server: NodeHttpServer;
  /** The actual bound port (resolved when `config.port` is `0`). */
  readonly port: number;
  /** The server's origin URL, e.g. `http://127.0.0.1:3000/`. */
  readonly url: string;
  /** Shut the whole application down; delegates to {@link Application.close}. */
  close(options?: CloseOptions): Promise<void>;
}

/**
 * Options for {@link createApplication}.
 *
 * @public
 */
export interface CreateApplicationOptions {
  /**
   * Run only the plugins the config declares, whatever the activation mode
   * (see `resolvePlugins`). A static build passes it.
   */
  readonly safeMode?: boolean;
  /**
   * The roles the application runs. Defaults to `web` and `worker` (one
   * process doing everything), or `export` for the legacy `static` shape;
   * `jsails serve` passes `web`, `jsails work` `worker`.
   */
  readonly roles?: readonly PluginRole[];
  /** Why the application is opened, a logging label (`serve` by default). */
  readonly purpose?: ServicesPurpose;
  /**
   * The environment plugin variables and the mode are read from. Defaults to
   * the process environment.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Assemble an {@link Application} from a loaded app (`loadApp`,
 * `createLoadedApp`) or a bare resolved config, which runs locked. The
 * kernel resolves the plugin graph and opens its services first; route
 * discovery and plugin setup then run before any port is opened. The
 * returned application owns no connection until `start()` or `serve()` (or a
 * plugin's own `setup`) creates one.
 */
export async function createApplication(
  source: LoadedApp | ResolvedAppConfig,
  options: CreateApplicationOptions = {},
): Promise<Application> {
  if (source === null || typeof source !== 'object') {
    throw new TypeError('createApplication requires a loaded app');
  }
  const graph = await resolvePlugins(source, {
    ...(options.safeMode === undefined ? {} : { safeMode: options.safeMode }),
    ...(options.roles === undefined ? {} : { roles: options.roles }),
  });
  const config = isLoadedApp(source) ? source.config : source;
  const services = await openServices(graph, {
    rootDir: config.rootDir,
    purpose: options.purpose ?? 'serve',
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  const { manifest, pageRenderer, generateStaticSite } = await assembleApplication(
    config,
    services,
  );
  const { runtime } = services;

  /** The servers opened so far, each with its kernel unit. */
  const served: ServedListener[] = [];
  let kernel: Promise<Kernel> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let opTail: Promise<void> = Promise.resolve();

  // The shared Hono pipeline (createApp over the routes and assets), assembled lazily
  // on the first fetch/serve and memoized for both. A failed assembly is
  // forgotten so a later request retries it from scratch.
  let assembledApp: Hono<AppEnv> | undefined;
  let assemblingApp: Promise<Hono<AppEnv>> | undefined;
  let pipeline: (() => Promise<Hono<AppEnv>>) | undefined;

  // The asset index, built on first use and shared by build, fetch and serve.
  let assetIndex: AssetIndex | undefined;
  let buildingAssets: Promise<AssetIndex> | undefined;

  // In-flight `fetch` requests. `close` waits for these to return their
  // `Response` before tearing down extensions. Only handler completion is
  // drained: a streamed body is the caller's to consume and is never waited on.
  let inflightFetches = 0;
  let fetchesDrained: Promise<void> = Promise.resolve();
  let resolveFetchesDrained: (() => void) | undefined;

  /** Serialize build/serve/close so they never interleave shared state. */
  const withLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = opTail.then(operation);
    opTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const closedError = (): ApplicationError =>
    new ApplicationError('closed', 'application is closed');

  const assertOpen = (): void => {
    if (closed) throw closedError();
  };

  /**
   * Start the kernel once. A failed start aborted the units it had started;
   * the application stays closable, and every later start reports the same
   * failure.
   */
  const startKernel = (): Promise<Kernel> => {
    kernel ??= start(services, {
      deadlineMs: config.shutdownTimeoutMs,
    });
    return kernel;
  };

  /** Build (and memoize) the asset index of `config.publicDir`; a failed build is forgotten. */
  const loadAssets = (): Promise<AssetIndex> => {
    if (assetIndex !== undefined) return Promise.resolve(assetIndex);
    buildingAssets ??= createAssetIndex({
      roots: [{ dir: config.publicDir }],
      // A dev server follows the files; anything else serves what it started with.
      mode: readPluginMode(options.env) === 'development' ? 'watch' : 'snapshot',
    }).then(
      (index) => {
        assetIndex = index;
        buildingAssets = undefined;
        return index;
      },
      (error: unknown) => {
        buildingAssets = undefined;
        throw error;
      },
    );
    return buildingAssets;
  };

  /** Assemble (and memoize) the shared Hono pipeline once per application. */
  const assembleApp = (): Promise<Hono<AppEnv>> => {
    if (assembledApp !== undefined) return Promise.resolve(assembledApp);
    if (assemblingApp === undefined) {
      assemblingApp = buildApp().then(
        (app) => {
          assembledApp = app;
          assemblingApp = undefined;
          return app;
        },
        (error: unknown) => {
          // A failed assembly produced nothing reusable: forget it so the next
          // request re-runs createApp from scratch.
          assemblingApp = undefined;
          throw error;
        },
      );
    }
    return assemblingApp;
  };

  /**
   * Run the HTTP pipeline assembler, importing it on first use: the pipeline
   * module loads the request stack, which `build` never touches. The assembler
   * is kept across a failed assembly, so its introspection config is computed
   * once per application.
   */
  async function buildApp(): Promise<Hono<AppEnv>> {
    if (pipeline === undefined) {
      const assets = await loadAssets();
      const { createHttpPipeline } = await import('./http-pipeline.js');
      pipeline ??= createHttpPipeline({
        config,
        manifest,
        runtime,
        pageRenderer,
        assets,
        // A managed plugin's route is served only by an app that manages
        // plugins; any other app fails assembly on one.
        pluginOrigins: graph.mode === 'managed' ? 'allow-managed' : 'code-only',
        plugins: graph.nodes,
        unitProbes: unitProbes(services.units.map(({ registration }) => registration.unit)),
      });
    }
    return pipeline();
  }

  const build = (): Promise<GenerateStaticSiteResult> =>
    withLock(async () => {
      assertOpen();
      const assets = await loadAssets();
      // Static export does not traverse the Hono pipeline, so open the scope
      // around the render pass explicitly.
      return withAppScope(runtime.services, () =>
        generateStaticSite({
          manifest,
          outDir: config.outDir,
          root: config.rootDir,
          assets,
          baseUrl: config.server.origin ?? config.seo?.origin,
          renderer: config.renderer ?? pageRenderer,
          services: runtime.services,
          storagePath: config.storageDir,
          seo: config.seo,
        }),
      );
    });

  const startApplication = (): Promise<void> =>
    withLock(async () => {
      assertOpen();
      await startKernel();
    });

  /**
   * Start the kernel, open a server and run its serve hooks; the server joins
   * the kernel as a unit and accepts nothing yet.
   */
  const openListener = async (serveOptions: ServeOptions): Promise<ServedListener> => {
    const running = await startKernel();
    const app = await assembleApp();
    const { openServer } = await import('./serve.js');
    const listener = await openServer({
      app,
      config,
      runtime,
      timeouts: config.server.timeouts,
      ...(serveOptions.handle === undefined ? {} : { listen: { handle: serveOptions.handle } }),
    });
    const unit = await running.adopt(httpUnit(listener));
    const entry: ServedListener = { listener, unit };
    served.push(entry);
    return entry;
  };

  /**
   * Start `entry`'s server accepting connections. A failure releases it (its
   * unit drains alone), so a later `serve` starts from scratch; accepting a
   * released server again only fails (`serve.draining`), without reporting
   * its drain a second time.
   */
  const acceptListener = async (entry: ServedListener): Promise<ServeHandle> => {
    let address: ServeAddress;
    try {
      address = await entry.listener.accept();
    } catch (error) {
      const index = served.indexOf(entry);
      if (index === -1) throw error;
      served.splice(index, 1);
      const report = await entry.unit.release({ deadlineMs: config.shutdownTimeoutMs });
      if (report.errors.length > 0) {
        throw new AggregateError([error, ...report.errors], 'serve failed', { cause: error });
      }
      throw error;
    }
    return {
      server: entry.listener.server,
      port: address.port,
      url: address.url,
      close: (closeOptions) => close(closeOptions),
    };
  };

  const serve = (serveOptions: ServeOptions = {}): Promise<ServeHandle> =>
    withLock(async () => {
      assertOpen();
      return acceptListener(await openListener(serveOptions));
    });

  const standby = (serveOptions: ServeOptions = {}): Promise<StandbyServer> =>
    withLock(async () => {
      assertOpen();
      const entry = await openListener(serveOptions);
      return {
        server: entry.listener.server,
        accept: () =>
          withLock(async () => {
            assertOpen();
            return acceptListener(entry);
          }),
        close: (closeOptions) => close(closeOptions),
      };
    });

  const fetchRequest = (request: Request): Promise<Response> => {
    if (request === null || typeof request !== 'object') {
      return Promise.reject(new TypeError('fetch requires a Request'));
    }
    if (closed) {
      return Promise.reject(closedError());
    }
    enterFetch();
    return (async () => {
      try {
        const app = await assembleApp();
        if (closed) {
          throw closedError();
        }
        return await app.fetch(request);
      } finally {
        exitFetch();
      }
    })();
  };

  /** Track a `fetch` handler as in-flight so `close` can drain it. */
  const enterFetch = (): void => {
    if (inflightFetches === 0) {
      fetchesDrained = new Promise<void>((resolve) => {
        resolveFetchesDrained = resolve;
      });
    }
    inflightFetches += 1;
  };

  /** Release one in-flight `fetch`; resolve the drain gate when none remain. */
  const exitFetch = (): void => {
    inflightFetches -= 1;
    if (inflightFetches === 0 && resolveFetchesDrained !== undefined) {
      resolveFetchesDrained();
      resolveFetchesDrained = undefined;
    }
  };

  const close = (closeOptions: CloseOptions = {}): Promise<void> => {
    if (closing !== undefined) return closing;
    // Reject future build/serve/fetch immediately; teardown runs behind any
    // in-flight op and waits for in-flight fetch handlers to settle first.
    closed = true;
    closing = withLock(async () => {
      await fetchesDrained;
      await teardown(closeOptions.signal);
    });
    return closing;
  };

  /**
   * Shut the kernel down when it started (it closes the services), or close
   * the services alone. A failure is reported once even when a participant's
   * drain and its plugin's cleanup surface it twice (a memoized close).
   */
  async function teardown(signal: AbortSignal | undefined): Promise<void> {
    let report: ShutdownReport;
    const running = await settled(kernel);
    if (running !== undefined) {
      report = await running.shutdown({
        deadlineMs: config.shutdownTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
    } else {
      const errors: unknown[] = [];
      try {
        await services.close();
      } catch (error) {
        errors.push(error);
      }
      report = { outcome: 'drained', errors };
    }
    const errors = [...report.errors];
    // A development index stops watching. Every operation that builds it has
    // settled by now: teardown runs behind them and the drained fetches.
    try {
      assetIndex?.close();
    } catch (error) {
      errors.push(error);
    }
    const distinct = [...new Set(errors)];
    if (distinct.length === 1) throw distinct[0];
    if (distinct.length > 1) throw new AggregateError(distinct, 'application close failed');
    if (report.outcome === 'aborted') {
      throw new KernelStageErrors.Error(
        'shutdown_timeout',
        { count: report.units.length },
        { payload: { units: report.units } },
      );
    }
  }

  const application: Application = {
    config,
    manifest,
    services: runtime.services,
    roles: services.roles,
    units: Object.freeze(services.units.map(({ registration }) => registration.unit.name)),
    dedicatedUnits: dedicatedUnits(services.units, new Set(services.roles)),
    start: startApplication,
    build,
    serve,
    standby,
    fetch: fetchRequest,
    close,
  };
  pipelines.set(application, () => (closed ? Promise.reject(closedError()) : assembleApp()));
  return application;
}

/** How each application assembles its HTTP pipeline (see {@link applicationPipeline}). */
const pipelines = new WeakMap<Application, () => Promise<Hono<AppEnv>>>();

/**
 * The HTTP pipeline `application` serves (assembled now when no request has
 * been), for the testing tools that read its surface registry; `undefined`
 * for an object `createApplication` did not build. Core-internal.
 */
export function applicationPipeline(application: Application): Promise<Hono<AppEnv>> | undefined {
  return pipelines.get(application)?.();
}

/** One opened server and the kernel unit it drains as. */
interface ServedListener {
  readonly listener: HttpListener;
  readonly unit: AdoptedUnit;
}

/**
 * An opened server as a lifecycle unit. Its serve hooks already ran, so
 * starting it does nothing (accepting is the server's own step); its drain is
 * the server's phased drain, which stops whatever is left when the deadline
 * signal aborts, so aborting it waits for nothing more.
 */
function httpUnit(listener: HttpListener): LifecycleUnit {
  return Object.freeze({
    name: 'http',
    start: () => undefined,
    drain: (deadline: AbortSignal) => listener.drain(deadline),
    abort: () => undefined,
  });
}

/** The readiness probes of `units`, named after them. */
function unitProbes(
  units: readonly LifecycleUnit[],
): readonly (readonly [string, ReadinessProbe])[] {
  return units.flatMap((unit) => {
    const ready = unit.ready;
    if (ready === undefined) return [];
    const probe: ReadinessProbe = (signal) => ready.call(unit, signal);
    return [[unit.name, probe] as const];
  });
}

/** The kernel a start produced, or `undefined` when none started or the start failed. */
async function settled(kernel: Promise<Kernel> | undefined): Promise<Kernel | undefined> {
  if (kernel === undefined) return undefined;
  try {
    return await kernel;
  } catch {
    // A failed start aborted what it had started; only the services remain.
    return undefined;
  }
}
