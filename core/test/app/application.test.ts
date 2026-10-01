/**
 * Application runtime tests.
 *
 * Fixtures are real compiled ESM modules written to a temp directory and
 * imported through Node's normal module loader; the only import they carry is
 * an absolute file URL to a shared service-token module. Nothing here opens a
 * database or Valkey connection: the extension provides an in-memory service
 * that both the custom renderer (build and serve) and an API handler read, which
 * proves the plumbing is service-agnostic rather than database-specific.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { Server as NodeHttpServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it, type TestContext } from 'node:test';
import { io as createClient } from 'socket.io-client';

import { publicAccess } from '../../src/api/access-ref.js';
import {
  ApplicationError,
  createApplication,
  type Application,
  type CreateApplicationOptions,
} from '../../src/app/application.js';
import { AssetErrors } from '../../src/assets/asset-errors.js';
import {
  AppConfigError,
  validateAppConfig,
  type ResolvedAppConfig,
} from '../../src/app/config/index.js';
import { ServeErrors } from '../../src/app/serve-errors.js';
import { broadcastPlugin } from '../../src/broadcast/plugin.js';
import { BROADCAST_PATH, type BroadcastAdapter } from '../../src/broadcast/server.js';
import type { RequestContext } from '../../src/contracts/http.js';
import type { PageOutcome, PageRenderer, PageRenderOptions } from '../../src/contracts/render.js';
import type { JsailsExtension, ServiceToken } from '../../src/extensions/index.js';
import { StaticSiteError } from '../../src/pages/static-site/index.js';
import type { RouteManifestEntry } from '../../src/routing/routes.js';
import { toPosixId } from '../../src/support/project-paths.server.js';
import { waitFor } from '../../src/testing/index.js';
import { documentOutcome } from '../../src/pages/page.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-app-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

interface GreetingService {
  readonly greeting: string;
}

const GREETING: GreetingService = { greeting: 'hello-from-service' };

// A shared module is the only way an on-disk API module and the in-process test
// can resolve the same service-token identity (the registry keys by identity).
const tokensFile = writeFile(
  join(root, 'tokens.js'),
  'export const GREETER = { name: "greeter" };\n',
);
const tokensUrl = pathToFileURL(tokensFile).href;
const tokens = (await import(tokensUrl)) as { GREETER: ServiceToken<GreetingService> };
const GREETER = tokens.GREETER;

// A second shared module lets an on-disk API module block on a test-controlled
// gate, so the close-vs-in-flight-fetch coordination is deterministic.
const gateFile = writeFile(join(root, 'gate.js'), 'export const GATE = { name: "gate" };\n');
const gateUrl = pathToFileURL(gateFile).href;
const gateTokens = (await import(gateUrl)) as { GATE: ServiceToken<unknown> };
const GATE = gateTokens.GATE;

let sequence = 0;

/** Write a file (creating parent directories) and return its absolute path. */
function writeFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Create an isolated case directory with optional page/api/public fixtures. */
function setupCase(
  assets: {
    pages?: Record<string, string>;
    api?: Record<string, string>;
    public?: Record<string, string>;
  } = {},
): string {
  const dir = mkdtempSync(join(root, `case-${sequence++}-`));
  for (const [subdir, files] of Object.entries(assets)) {
    for (const [rel, content] of Object.entries(files)) {
      writeFile(join(dir, subdir, rel), content);
    }
  }
  return dir;
}

/** A page module that is only ever discovered, never imported (custom renderer). */
const PAGE_SOURCE = 'export default function Page() { return null; };\n';

/** An API module that reads the extension-provided service from the context. */
const API_SOURCE = `import { GREETER } from ${JSON.stringify(tokensUrl)};
export async function GET(request, context) {
  const service = context.services.get(GREETER);
  return new Response(JSON.stringify({ greeting: service.greeting, route: 'api' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
export const authorize = () => true;
`;

/** A mutating API module that echoes the resolved session id. */
const POST_SOURCE = `
export async function POST(request, context) {
  return new Response(JSON.stringify({ session: context.session?.id ?? null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
export const authorize = () => true;
`;

/** An API module that reports the peak concurrency it observed. */
const CONCURRENT_SOURCE = `
let active = 0;
let peak = 0;
export async function GET() {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, 20));
  active -= 1;
  return new Response(JSON.stringify({ peak }), {
    headers: { 'content-type': 'application/json' },
  });
}
export const authorize = () => true;
`;

/** An API module that blocks on a shared test-controlled gate. */
const GATED_SOURCE = `import { GATE } from ${JSON.stringify(gateUrl)};
export async function GET(request, context) {
  const gate = context.services.get(GATE);
  gate.markStarted();
  await gate.wait();
  return new Response('done', { status: 200 });
}
export const authorize = () => true;
`;

/** A renderer that records each render and reads the service from the context. */
class RecordingRenderer implements PageRenderer {
  readonly calls: Array<{ route: string; staticMode: boolean | undefined; greeting: string }> = [];
  render(
    entry: RouteManifestEntry,
    context: RequestContext,
    options?: PageRenderOptions,
  ): PageOutcome {
    const greeting = context.services?.tryGet(GREETER)?.greeting ?? 'missing';
    this.calls.push({ route: entry.route, staticMode: options?.staticMode, greeting });
    return documentOutcome(`<div>${greeting}:${entry.route}</div>`);
  }
}

/** An extension that records setup/teardown order (and optionally provides). */
function orderExtension(name: string, events: string[]): JsailsExtension {
  return {
    name,
    setup() {
      events.push(name);
      return () => {
        events.push(`dispose-${name}`);
      };
    },
  };
}

/** An extension that provides the shared service token. */
const greeterExtension: JsailsExtension = {
  name: 'greeter',
  setup(context) {
    context.services.provide(GREETER, GREETING);
    return () => {};
  },
};

/** An extension that registers one route. */
const routeExtension: JsailsExtension = {
  name: 'router',
  setup(context) {
    context.routes.add({
      methods: ['GET'],
      path: '/plugin-route',
      access: publicAccess('application assembly probe'),
      handler: () => Response.json({ routed: true }),
    });
  },
};

/** The environment of an application opened in development: a watching asset index. */
const DEVELOPMENT: CreateApplicationOptions = { env: { ...process.env, NODE_ENV: 'development' } };

/**
 * Count the assemblies of an application opened in {@link DEVELOPMENT} whose
 * `/about` page shares its path with a public `about` file: each assembly's
 * precedence check warns once that the route keeps the path, and the warning
 * is counted when it is raised, not when it is later delivered.
 */
function countAssemblies(t: TestContext): { readonly value: number } {
  const counter = { value: 0 };
  t.mock.method(process, 'emitWarning', (...args: unknown[]) => {
    const options = args[1];
    if (
      typeof options === 'object' &&
      options !== null &&
      (options as { code?: unknown }).code === 'JSAILS_ASSET_ROUTE_COLLISION'
    ) {
      counter.value += 1;
    }
  });
  return counter;
}

/** A test-controlled gate shared with an on-disk API module. */
function makeGate(): {
  readonly started: () => boolean;
  markStarted(): void;
  wait(): Promise<void>;
  release(): void;
} {
  let started = false;
  let release: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started: () => started,
    markStarted() {
      started = true;
    },
    wait: () => done,
    release: () => release?.(),
  };
}

function makeConfig(dir: string, overrides: Record<string, unknown> = {}) {
  return validateAppConfig({ rootDir: dir, port: 0, ...overrides }, { cwd: dir });
}

/**
 * Create an application that is closed after the test whatever its outcome, so
 * a failed assertion cannot leave a server or an extension holding the test
 * process open. `close` is memoized, so a test may still close it itself.
 */
async function openApplication(
  t: TestContext,
  config: ResolvedAppConfig,
  options?: CreateApplicationOptions,
): Promise<Application> {
  const app = await createApplication(config, options);
  t.after(() => app.close());
  return app;
}

/** Listen on an ephemeral loopback port, closed after the test. */
async function listenBlocker(t: TestContext): Promise<number> {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve());
  });
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  return (blocker.address() as AddressInfo).port;
}

/** State a fake broadcast adapter records for lifecycle assertions. */
interface FakeAdapterState {
  attachCalls: number;
  attachedServer: NodeHttpServer | undefined;
  closeCalls: number;
}

function makeFakeState(): FakeAdapterState {
  return { attachCalls: 0, attachedServer: undefined, closeCalls: 0 };
}

/** A real, in-process custom transport that only records attach/close calls. */
function fakeAdapter(state: FakeAdapterState, opts: { closeError?: Error } = {}): BroadcastAdapter {
  return {
    name: 'fake',
    attach(server) {
      state.attachCalls += 1;
      state.attachedServer = server;
      return {
        closesHttpServer: false,
        broadcast() {},
        close() {
          state.closeCalls += 1;
          return opts.closeError === undefined
            ? Promise.resolve()
            : Promise.reject(opts.closeError);
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('createApplication lifecycle', () => {
  it('runs extensions and app setup in order, and tears down in reverse', async (t) => {
    const dir = setupCase();
    const events: string[] = [];
    const config = makeConfig(dir, {
      setup() {
        events.push('app-setup');
        return () => {
          events.push('app-cleanup');
        };
      },
      extensions: [orderExtension('a', events), orderExtension('b', events)],
    });

    const app = await openApplication(t, config);

    assert.deepEqual(events, ['a', 'b', 'app-setup']);
    await app.close();
    assert.deepEqual(events, ['a', 'b', 'app-setup', 'app-cleanup', 'dispose-b', 'dispose-a']);
  });

  it('closes already-open extensions when the app setup hook fails', async () => {
    const dir = setupCase();
    const events: string[] = [];
    const config = makeConfig(dir, {
      setup() {
        throw new Error('setup boom');
      },
      extensions: [orderExtension('a', events), orderExtension('b', events)],
    });

    await assert.rejects(createApplication(config), /setup boom/);
    assert.deepEqual(events, ['a', 'b', 'dispose-b', 'dispose-a']);
  });

  it('close is idempotent and rejects further build/serve', async (t) => {
    const dir = setupCase();
    const app = await openApplication(t, makeConfig(dir));

    await app.close();
    await app.close();

    await assert.rejects(app.build(), /application is closed/);
    await assert.rejects(app.serve(), /application is closed/);
  });
});

// ---------------------------------------------------------------------------
// Declarative plugins: `plugins.use`
// ---------------------------------------------------------------------------

// Fixture plugin module sources — written to temp files and imported via
// `file://` URL. The `resolvePluginUse` path accepts `file://` URLs, so these
// behave like real package specifiers without needing a `node_modules` tree.
const USE_PLUGIN_OK = `export const TOKEN = { name: "fixture-ok" };
export default function factory() {
  return { name: "fixture-ok", setup(ctx) { ctx.services.provide(TOKEN, { value: "from-use" }); } };
}
`;

const USE_PLUGIN_FACTORY_THROW = `export default function factory() { throw new Error("bang"); }
`;

describe('createApplication: plugins.use', () => {
  it('boots a plugin declared via plugins.use with a file:// specifier', async (t) => {
    const dir = setupCase();
    const fixturePath = writeFile(join(dir, 'ok.mjs'), USE_PLUGIN_OK);
    const fixtureUrl = pathToFileURL(fixturePath).href;

    const config = makeConfig(dir, {
      plugins: { use: [fixtureUrl] },
    });
    const app = await openApplication(t, config);

    // The plugin's setup ran and provided its service.
    const fixtureModule = (await import(fixtureUrl)) as {
      TOKEN: ServiceToken<{ value: string }>;
    };
    const service = app.services.get(fixtureModule.TOKEN);
    assert.equal(service.value, 'from-use');

    // Developer plugins always run; nothing gates them.
    await app.close();
  });

  it('boots both plugins.use and config.extensions, in the correct order', async (t) => {
    const dir = setupCase();
    const fixturePath = writeFile(join(dir, 'ok.mjs'), USE_PLUGIN_OK);
    const fixtureUrl = pathToFileURL(fixturePath).href;

    const events: string[] = [];
    const config = makeConfig(dir, {
      plugins: { use: [fixtureUrl] },
      extensions: [orderExtension('hand-written', events)],
    });
    const app = await openApplication(t, config);

    // The use plugin was provided. The hand-written extension also ran.
    assert.deepEqual(events, ['hand-written']);
    await app.close();
    assert.deepEqual(events, ['hand-written', 'dispose-hand-written']);
  });

  it('boots with neither plugins.use nor extensions (no-op)', async (t) => {
    const dir = setupCase();
    const config = makeConfig(dir);
    const app = await openApplication(t, config);
    // Construction succeeded; no services were registered beyond the framework
    // built-ins. The app is functional: it can build and serve.
    await app.close();
  });

  it('throws a value-free AppConfigError when a plugins.use entry fails to resolve', async () => {
    await assert.rejects(
      createApplication(
        makeConfig(setupCase(), {
          plugins: { use: ['__nonexistent_package_78901__'] },
        }),
      ),
      (error) => {
        assert.ok(error instanceof AppConfigError);
        // Value-free: mentions the specifier (which the developer wrote) but never
        // echoes internal error details or option values.
        assert.match(error.message, /plugin\(s\) failed to load/);
        assert.match(error.message, /__nonexistent_package_78901__/);
        assert.equal(error.message.includes('ERR_MODULE'), false);
        assert.equal(error.message.includes('Cannot find'), false);
        return true;
      },
    );
  });

  it('throws a value-free AppConfigError when a plugins.use factory throws', async () => {
    const dir = setupCase();
    const fixturePath = writeFile(join(dir, 'throw.mjs'), USE_PLUGIN_FACTORY_THROW);
    const fixtureUrl = pathToFileURL(fixturePath).href;

    await assert.rejects(
      createApplication(makeConfig(dir, { plugins: { use: [fixtureUrl] } })),
      (error) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /plugin\(s\) failed to load/);
        // Value-free: never echoes the thrown error.
        assert.equal(error.message.includes('bang'), false);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

describe('Application.build', () => {
  it('renders pages and copies assets through the custom renderer + services without listening', async (t) => {
    const dir = setupCase({
      pages: { 'index.js': PAGE_SOURCE },
      public: { 'robots.txt': 'User-agent: *\n' },
    });
    const renderer = new RecordingRenderer();
    const config = makeConfig(dir, { renderer, extensions: [greeterExtension] });

    const app = await openApplication(t, config);
    const result = await app.build();

    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.written, [join(dir, 'out', 'index.html')]);
    assert.deepEqual(result.copied, [join(dir, 'out', 'robots.txt')]);

    const html = readFileSync(join(dir, 'out', 'index.html'), 'utf8');
    assert.match(html, /hello-from-service:\//);
    assert.equal(readFileSync(join(dir, 'out', 'robots.txt'), 'utf8'), 'User-agent: *\n');

    // The build renders in static mode and reads the service from the context.
    assert.deepEqual(renderer.calls, [
      { route: '/', staticMode: true, greeting: 'hello-from-service' },
    ]);

    await app.close();
  });
  // macOS reaches every temporary directory through /var -> /private/var, and
  // a home or workspace may be a symlink: the project's own ancestry is the
  // operator's layout, while a symlink inside the project is still refused.
  it('builds a project reached through a symlink but refuses a symlinked outDir parent', async (t) => {
    const real = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const linked = `${real}-link`;
    symlinkSync(real, linked);
    const renderer = new RecordingRenderer();

    const app = await openApplication(t, makeConfig(linked, { renderer }));
    const result = await app.build();
    assert.deepEqual(result.written, [join(linked, 'out', 'index.html')]);
    assert.equal(existsSync(join(real, 'out', 'index.html')), true);

    const elsewhere = setupCase();
    symlinkSync(elsewhere, join(real, 'build'));
    const inside = await openApplication(t, makeConfig(linked, { renderer, out: 'build/out' }));
    await assert.rejects(
      inside.build(),
      (error: unknown) =>
        error instanceof StaticSiteError &&
        error.code === 'unsafe_output_dir' &&
        error.message.includes(`"${join(linked, 'build')}" is a symlink`),
    );
    assert.equal(existsSync(join(elsewhere, 'out')), false);
  });
});

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

describe('Application.serve', () => {
  it('serves page and API routes over loopback with extension services', async (t) => {
    const dir = setupCase({
      pages: { 'index.js': PAGE_SOURCE },
      api: { 'hello.js': API_SOURCE },
    });
    const renderer = new RecordingRenderer();
    const config = makeConfig(dir, {
      renderer,
      extensions: [greeterExtension],
    });

    const app = await openApplication(t, config);
    assert.equal(app.services.get(GREETER).greeting, 'hello-from-service');

    const handle = await app.serve();
    try {
      const page = await fetch(new URL('/', handle.url));
      assert.equal(page.status, 200);
      assert.match(await page.text(), /hello-from-service:\//);

      const api = await fetch(new URL('/api/hello', handle.url));
      assert.equal(api.status, 200);
      assert.deepEqual(await api.json(), { greeting: 'hello-from-service', route: 'api' });

      assert.equal(handle.port, (handle.server.address() as AddressInfo).port);
      assert.match(handle.url, new RegExp(`http://127\\.0\\.0\\.1:${handle.port}/$`));

      // Serve renders in request mode (staticMode false) and reads the service.
      assert.ok(renderer.calls.some((call) => call.staticMode === false && call.route === '/'));
    } finally {
      await handle.close();
    }
  });

  it('serves the files of public/', async (t) => {
    const dir = setupCase({ public: { 'robots.txt': 'User-agent: *\n' } });
    const app = await openApplication(t, makeConfig(dir));
    const handle = await app.serve();
    try {
      const res = await fetch(new URL('/robots.txt', handle.url));
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'User-agent: *\n');
    } finally {
      await handle.close();
    }
  });

  it('versions public files with the same index the server answers from', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE }, public: { 'app.js': 'aaaa' } });
    const asset = join(dir, 'public', 'app.js');
    const renderer: PageRenderer = {
      render: (_entry, context) => documentOutcome(`<p>${context.assetUrl?.('/app.js') ?? ''}</p>`),
    };
    const app = await openApplication(t, makeConfig(dir, { renderer }));
    const handle = await app.serve();
    try {
      const page = await (await fetch(new URL('/', handle.url))).text();
      const version = /\/app\.js\?v=([A-Za-z0-9_-]{16})/.exec(page)?.[1];
      assert.ok(version !== undefined, 'the page links a versioned asset');

      // New bytes of the same size: the snapshot the page was versioned from
      // still answers, with the bytes it hashed, as immutable.
      writeFileSync(asset, 'bbbb');
      const res = await fetch(new URL(`/app.js?v=${version}`, handle.url));
      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control') ?? '', /immutable/);
      assert.equal(await res.text(), 'aaaa');
    } finally {
      await handle.close();
    }
  });

  it('serves a public file a root dynamic page would also match', async (t) => {
    const dir = setupCase({
      pages: { '[slug].js': PAGE_SOURCE },
      public: { 'favicon.ico': 'icon' },
    });
    const app = await openApplication(t, makeConfig(dir, { renderer: new RecordingRenderer() }));
    try {
      const res = await app.fetch(new Request('http://localhost/favicon.ico'));
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'icon');
    } finally {
      await app.close();
    }
  });

  it('copies public/ into a static build, as the server serves it', async (t) => {
    const dir = setupCase({
      pages: { 'index.js': PAGE_SOURCE },
      public: { 'robots.txt': 'r', '.env': 'SECRET=1', '.well-known/security.txt': 'c' },
    });
    const app = await openApplication(t, makeConfig(dir, { renderer: new RecordingRenderer() }));
    try {
      const result = await app.build();
      assert.deepEqual(
        result.copied.map((file) => toPosixId(relative(app.config.outDir, file))),
        ['.well-known/security.txt', 'robots.txt'],
      );
    } finally {
      await app.close();
    }
  });

  it('attaches broadcast to the same server and port when configured', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      extensions: [
        broadcastPlugin({ allowedOrigins: ['https://app.example'], authenticate: () => 'user' }),
      ],
    });

    const app = await openApplication(t, config);
    const handle = await app.serve();
    try {
      await connectSocket(handle.port);
      // The same server still serves HTTP.
      const res = await fetch(new URL('/', handle.url));
      assert.equal(res.status, 200);
    } finally {
      await handle.close();
    }
  });

  it('cleans up owned resources when listen fails and leaves the app usable', async (t) => {
    // Occupy an ephemeral port, then ask the app to bind the same one.
    const port = await listenBlocker(t);

    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const renderer = new RecordingRenderer();
    const config = makeConfig(dir, { port, renderer, extensions: [greeterExtension] });

    const app = await openApplication(t, config);

    await assert.rejects(
      app.serve(),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EADDRINUSE',
    );

    // The failed serve did not close the app: it can still build, then close.
    const result = await app.build();
    assert.deepEqual(result.written, [join(dir, 'out', 'index.html')]);
    assert.ok(renderer.calls.some((call) => call.staticMode === true));

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Standby and accept
// ---------------------------------------------------------------------------

/** An extension whose serve hook records whether the server listened when it ran. */
function listeningProbe(seen: boolean[]): JsailsExtension {
  return {
    name: 'probe',
    setup({ onServe }) {
      onServe((server) => void seen.push(server.listening));
    },
  };
}

describe('Application.standby', () => {
  it('runs every serve hook with nothing listening, then accepts on the configured address', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const seen: boolean[] = [];
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      extensions: [listeningProbe(seen)],
    });
    const app = await openApplication(t, config);

    const standby = await app.standby();
    assert.deepEqual(seen, [false]);
    assert.equal(standby.server.listening, false);
    const handle = await standby.accept();
    assert.equal(handle.server, standby.server);
    assert.equal((await fetch(new URL('/', handle.url))).status, 200);
    await standby.close();
    assert.equal(standby.server.listening, false);
  });

  it('releases a server whose accept fails: the app serves again and its close reports that drain once', async (t) => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => resolve());
    });
    const releasePort = (): Promise<void> =>
      new Promise((resolve) => {
        if (blocker.listening) blocker.close(() => resolve());
        else resolve();
      });
    // Released whatever the outcome: an open blocker would hold the test process.
    t.after(releasePort);
    const port = (blocker.address() as AddressInfo).port;
    let drains = 0;
    const flaky: JsailsExtension = {
      name: 'flaky',
      setup({ onServe }) {
        onServe(() => ({
          name: 'flaky',
          drain: async () => {
            drains += 1;
            if (drains === 1) throw new Error('first drain boom');
          },
        }));
      },
    };
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const config = makeConfig(dir, {
      port,
      renderer: new RecordingRenderer(),
      extensions: [flaky],
    });
    const app = await openApplication(t, config);

    const standby = await app.standby();
    const error = await standby.accept().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof AggregateError, String(error));
    assert.equal((error.errors[0] as NodeJS.ErrnoException).code, 'EADDRINUSE');
    assert.equal((error.errors[1] as Error).message, 'first drain boom');
    assert.equal(drains, 1, 'the failed server was drained when it was released');
    await assert.rejects(standby.accept(), (caught: unknown) => ServeErrors.is(caught, 'draining'));

    await releasePort();
    const handle = await app.serve();
    assert.equal(handle.port, port);
    assert.equal((await fetch(new URL('/', handle.url))).status, 200);
    // Only the serving server drains now: the released one's failure was
    // reported by its accept.
    await app.close();
    assert.equal(drains, 2);
  });

  it('refuses to accept once the application closed', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const app = await openApplication(t, makeConfig(dir, { renderer: new RecordingRenderer() }));
    const standby = await app.standby();
    await app.close();
    await assert.rejects(
      standby.accept(),
      (error: unknown) => error instanceof ApplicationError && error.code === 'closed',
    );
    assert.equal(standby.server.listening, false);
  });
});

// ---------------------------------------------------------------------------
// Serve: custom broadcast adapter
// ---------------------------------------------------------------------------

describe('Application.serve: custom broadcast adapter', () => {
  it('attaches a custom adapter to the app-owned server, serves HTTP on the same port, and closes both on close', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const state = makeFakeState();
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      extensions: [broadcastPlugin({ adapter: fakeAdapter(state) })],
    });

    const app = await openApplication(t, config);
    const handle = await app.serve();
    try {
      assert.equal(state.attachCalls, 1, 'the adapter attach runs exactly once');
      assert.equal(state.attachedServer, handle.server, 'attach receives the app-owned server');

      // The same port still serves the HTTP application.
      const res = await fetch(new URL('/', handle.url));
      assert.equal(res.status, 200);
    } finally {
      await handle.close();
    }

    // `closesHttpServer: false` means the transport stops itself and leaves the
    // server to the application, which must close it.
    assert.equal(state.closeCalls, 1, 'the transport was disposed exactly once');
    assert.equal(handle.server.listening, false, 'the app closes the HTTP server itself');
  });

  it('closes the HTTP server and extensions when a custom adapter close throws', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const events: string[] = [];
    const state = makeFakeState();
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      extensions: [
        orderExtension('a', events),
        broadcastPlugin({
          adapter: fakeAdapter(state, { closeError: new Error('transport boom') }),
        }),
      ],
    });

    const app = await createApplication(config);
    // The adapter's close always fails, so the memoized close rejects again.
    t.after(() => assert.rejects(app.close(), /transport boom/));
    const handle = await app.serve();

    await assert.rejects(handle.close(), /transport boom/);

    assert.equal(state.closeCalls, 1, 'the transport close was attempted');
    assert.equal(
      handle.server.listening,
      false,
      'the HTTP server is closed despite the transport error',
    );
    assert.deepEqual(
      events,
      ['a', 'dispose-a'],
      'extensions are cleaned up after the transport error',
    );
  });

  it('disposes the app-owned server and stays usable when a custom adapter attach fails', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const renderer = new RecordingRenderer();
    const config = makeConfig(dir, {
      renderer,
      extensions: [
        broadcastPlugin({
          adapter: {
            name: 'failing',
            attach() {
              throw new Error('attach boom');
            },
          },
        }),
      ],
    });

    const app = await openApplication(t, config);

    await assert.rejects(app.serve(), /attach boom/);

    // The failed serve did not close the app: it can still build, then close.
    const result = await app.build();
    assert.deepEqual(result.written, [join(dir, 'out', 'index.html')]);
    assert.ok(renderer.calls.some((call) => call.staticMode === true));

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

describe('health endpoint', () => {
  it('serves GET /up through fetch and serve, independent of the default-deny API', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const config = makeConfig(dir, { renderer: new RecordingRenderer() });

    const app = await openApplication(t, config);

    const viaFetch = await app.fetch(new Request('http://localhost/up'));
    assert.equal(viaFetch.status, 200);
    assert.equal(viaFetch.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(viaFetch.headers.get('cache-control'), 'no-store');
    assert.equal(await viaFetch.text(), 'OK');

    const handle = await app.serve();
    try {
      const viaHttp = await fetch(new URL('/up', handle.url));
      assert.equal(viaHttp.status, 200);
      assert.equal(await viaHttp.text(), 'OK');
    } finally {
      await handle.close();
    }
    await app.close();
  });

  it('rejects a health path that collides with a discovered route, naming the file', async () => {
    const dir = setupCase({ pages: { 'health.js': PAGE_SOURCE } });
    await assert.rejects(
      createApplication(makeConfig(dir, { healthPath: '/health' })),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /collides with the page route "\/health"/);
        assert.match(error.message, /health\.js/);
        return true;
      },
    );
  });

  it('serves a 404 when the health path is disabled', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const config = makeConfig(dir, { renderer: new RecordingRenderer(), healthPath: false });
    const app = await openApplication(t, config);

    assert.equal((await app.fetch(new Request('http://localhost/up'))).status, 404);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Config wiring: readiness, system checks, error hooks, server timeouts
// ---------------------------------------------------------------------------

const THROWING_API_SOURCE = `
export async function GET() {
  throw new Error('store exploded');
}
export const authorize = () => true;
`;

describe('config wiring into the HTTP pipeline', () => {
  it('serves config and extension readiness probes, the latter with the sealed services', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    let healthy = true;
    const seen: (GreetingService | undefined)[] = [];
    const probing: JsailsExtension = {
      name: 'probing',
      readiness: {
        greeter: (_signal, services) => {
          seen.push(services.tryGet(GREETER));
          return healthy;
        },
      },
      setup() {},
    };
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      extensions: [greeterExtension, probing],
      readiness: {
        probes: { config: () => true },
        cacheMs: 0,
        path: '/ready',
        authorize: (request: Request) => request.headers.get('x-ops') === 'yes',
      },
    });
    const app = await openApplication(t, config);
    try {
      const anonymous = await app.fetch(new Request('http://localhost/up?deep=1'));
      assert.equal(anonymous.status, 200);
      assert.deepEqual(await anonymous.json(), { status: 'ok' });
      assert.deepEqual(seen, [GREETING]);

      healthy = false;
      const detailed = await app.fetch(
        new Request('http://localhost/ready', { headers: { 'x-ops': 'yes' } }),
      );
      assert.equal(detailed.status, 503);
      const report = (await detailed.json()) as { checks: { id: string; ok: boolean }[] };
      assert.deepEqual(
        report.checks.map(({ id, ok }) => ({ id, ok })),
        [
          { id: 'config', ok: true },
          { id: 'greeter', ok: false },
        ],
      );
      assert.equal(await (await app.fetch(new Request('http://localhost/up'))).text(), 'OK');
    } finally {
      await app.close();
    }
  });

  it('turns readiness on from extension probes alone', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      extensions: [{ name: 'down', readiness: { db: () => false }, setup() {} }],
    });
    const app = await openApplication(t, config);
    try {
      const response = await app.fetch(new Request('http://localhost/up?deep=1'));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { status: 'error' });
    } finally {
      await app.close();
    }
  });

  it('refuses a probe name used by both the config and an extension', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      extensions: [{ name: 'dup', readiness: { db: () => true }, setup() {} }],
      readiness: { probes: { db: () => true } },
    });
    const app = await openApplication(t, config);
    try {
      await assert.rejects(
        app.fetch(new Request('http://localhost/up')),
        (error: unknown) => error instanceof AppConfigError && /probe name/.test(error.message),
      );
    } finally {
      await app.close();
    }
  });

  it('runs the config systemChecks on the readiness probe', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const systemChecks = {
      register() {},
      run: () => [{ id: 'disk', severity: 'error' as const, message: 'full' }],
    };
    const app = await openApplication(
      t,
      makeConfig(dir, { renderer: new RecordingRenderer(), systemChecks }),
    );
    try {
      const response = await app.fetch(new Request('http://localhost/up?deep=1'));
      assert.equal(response.status, 503);
    } finally {
      await app.close();
    }
  });

  it('reports a failing API handler to the config onError hook', async (t) => {
    const dir = setupCase({ api: { 'boom.js': THROWING_API_SOURCE } });
    const reports: { message: string; route: string }[] = [];
    const app = await openApplication(
      t,
      makeConfig(dir, {
        onError: (error: unknown, info: { route: string }) => {
          reports.push({ message: (error as Error).message, route: info.route });
        },
      }),
    );
    try {
      const response = await app.fetch(new Request('http://localhost/api/boom'));
      assert.equal(response.status, 500);
      assert.ok(!(await response.text()).includes('store exploded'));
      assert.deepEqual(reports, [{ message: 'store exploded', route: '/api/boom' }]);
    } finally {
      await app.close();
    }
  });

  it('renders a browser 404 through the config errorPage', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const app = await openApplication(
      t,
      makeConfig(dir, {
        renderer: new RecordingRenderer(),
        errorPage: (error: { status: number }) => `<h1>custom ${error.status}</h1>`,
      }),
    );
    try {
      const response = await app.fetch(
        new Request('http://localhost/missing', { headers: { accept: 'text/html' } }),
      );
      assert.equal(response.status, 404);
      assert.match(await response.text(), /custom 404/);
    } finally {
      await app.close();
    }
  });

  it('applies the config server timeouts to the served server', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const app = await openApplication(
      t,
      makeConfig(dir, {
        renderer: new RecordingRenderer(),
        server: { keepAliveTimeoutMs: 75_000, headersTimeoutMs: 76_000 },
      }),
    );
    const handle = await app.serve();
    try {
      assert.equal(handle.server.keepAliveTimeout, 75_000);
      assert.equal(handle.server.headersTimeout, 76_000);
      assert.equal(handle.server.requestTimeout, 300_000);
    } finally {
      await handle.close();
    }
  });
  it('passes the config render settings to createApp', async (t) => {
    const dir = setupCase({
      pages: {
        'index.js': PAGE_SOURCE,
        'live.js': `${PAGE_SOURCE}export const stream = true;\n`,
      },
    });
    const seen: Array<{ stream: boolean | undefined; timeoutMs: number | undefined }> = [];
    const renderer: PageRenderer = {
      render(entry, _context, options) {
        seen.push({ stream: options?.stream, timeoutMs: options?.timeoutMs });
        if (options?.stream !== true) return documentOutcome('<p>buffered</p>');
        return {
          kind: 'document',
          status: 200,
          headers: new Headers(),
          body: { kind: 'stream', stream: new Response(`<p>streamed ${entry.route}</p>`).body! },
        };
      },
    };
    const app = await openApplication(
      t,
      makeConfig(dir, { renderer, render: { streamTimeoutMs: 1234 } }),
    );
    try {
      const streamed = await app.fetch(new Request('http://localhost/live'));
      assert.equal(streamed.headers.get('x-accel-buffering'), 'no');
      assert.equal(await streamed.text(), '<p>streamed /live</p>');
      const buffered = await app.fetch(new Request('http://localhost/'));
      assert.equal(buffered.headers.get('x-accel-buffering'), null);
      assert.equal(await buffered.text(), '<p>buffered</p>');
      assert.deepEqual(seen, [
        { stream: true, timeoutMs: 1234 },
        { stream: undefined, timeoutMs: undefined },
      ]);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Storage directory lifecycle
// ---------------------------------------------------------------------------

describe('storage directory lifecycle', () => {
  it('creates the storage directory on serve, not on build or fetch', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const config = makeConfig(dir, { renderer: new RecordingRenderer() });
    const storageDir = config.storageDir;

    assert.equal(existsSync(storageDir), false, 'storage must not exist before serving');

    const app = await openApplication(t, config);

    await app.fetch(new Request('http://localhost/'));
    assert.equal(existsSync(storageDir), false, 'fetch must not create storage');

    await app.build();
    assert.equal(existsSync(storageDir), false, 'build must not create storage');

    const handle = await app.serve();
    try {
      assert.equal(existsSync(storageDir), true, 'serve must create storage');
    } finally {
      await handle.close();
    }
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Fetch (serverless request routing through the shared Hono pipeline)
// ---------------------------------------------------------------------------

describe('Application.fetch', () => {
  it('serves page and API routes with extension services, without a server', async (t) => {
    const dir = setupCase({
      pages: { 'index.js': PAGE_SOURCE },
      api: { 'hello.js': API_SOURCE },
    });
    const renderer = new RecordingRenderer();
    const config = makeConfig(dir, {
      renderer,
      extensions: [greeterExtension],
    });

    const app = await openApplication(t, config);

    const page = await app.fetch(new Request('http://localhost/'));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /hello-from-service:\//);

    const api = await app.fetch(new Request('http://localhost/api/hello'));
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { greeting: 'hello-from-service', route: 'api' });

    // Fetch renders in request mode (staticMode false) and reads the service.
    assert.ok(renderer.calls.some((call) => call.staticMode === false && call.route === '/'));

    await app.close();
  });

  it('serves the files of public/ through fetch', async (t) => {
    const dir = setupCase({ public: { 'robots.txt': 'User-agent: *\n' } });
    const app = await openApplication(t, makeConfig(dir));
    const res = await app.fetch(new Request('http://localhost/robots.txt'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'User-agent: *\n');
    await app.close();
  });

  it('refuses to open an app whose API module states no access', async (t) => {
    const dir = setupCase({ api: { 'open.js': 'export const GET = () => new Response();\n' } });
    // The pipeline is assembled on the first request, so that request fails.
    const app = await openApplication(t, makeConfig(dir));
    await assert.rejects(app.fetch(new Request('http://localhost/api/open')), {
      code: 'surface.missing_access',
    });
  });

  it('refuses a cookie-authenticated mutation that names no site or another one', async (t) => {
    const dir = setupCase({ api: { 'mutate.js': POST_SOURCE } });
    const session = {
      id: 'session-id',
      data: {},
      expiresAt: Date.now() + 60_000,
    };
    const config = makeConfig(dir, {
      resolveSession: () => session,
    });

    const app = await openApplication(t, config);

    // No Origin and no Sec-Fetch-Site: refused as cross-site.
    const cross = await app.fetch(
      new Request('http://localhost/api/mutate', { method: 'POST', headers: { cookie: 'sid=1' } }),
    );
    assert.equal(cross.status, 403);

    const foreign = await app.fetch(
      new Request('http://localhost/api/mutate', {
        method: 'POST',
        headers: { origin: 'https://evil.example', cookie: 'sid=1' },
      }),
    );
    assert.equal(foreign.status, 403);
    assert.equal(((await foreign.json()) as { code: string }).code, 'access.cross_site');

    // From the app origin the handler runs with the session; there is no token.
    const ok = await app.fetch(
      new Request('http://localhost/api/mutate', {
        method: 'POST',
        headers: { origin: 'http://localhost', cookie: 'sid=1' },
      }),
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { session: 'session-id' });

    await app.close();
  });

  it('does not attach broadcast or open a server when fetching', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const state = makeFakeState();
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      extensions: [broadcastPlugin({ adapter: fakeAdapter(state) })],
    });

    const app = await openApplication(t, config);

    const res = await app.fetch(new Request('http://localhost/'));
    assert.equal(res.status, 200);
    assert.equal(state.attachCalls, 0, 'fetch must never attach broadcast');
    assert.equal(state.attachedServer, undefined, 'fetch must never create a server');

    await app.close();
    assert.equal(state.closeCalls, 0, 'broadcast was never attached, so close is a no-op for it');
  });

  it('assembles the pipeline exactly once across fetch and serve', async (t) => {
    const dir = setupCase({ pages: { 'about.js': PAGE_SOURCE }, public: { about: 'shadowed' } });
    const counter = countAssemblies(t);
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      extensions: [routeExtension],
    });

    const app = await openApplication(t, config, DEVELOPMENT);

    // The first fetch assembles the pipeline once.
    const first = await app.fetch(new Request('http://localhost/plugin-route'));
    assert.equal(first.status, 200);
    assert.equal(counter.value, 1);

    // A second fetch reuses the memoized pipeline.
    const second = await app.fetch(new Request('http://localhost/plugin-route'));
    assert.equal(second.status, 200);
    assert.equal(counter.value, 1);

    // serve shares the same pipeline; no second assembly.
    const handle = await app.serve();
    const served = await fetch(new URL('/plugin-route', handle.url));
    assert.equal(served.status, 200);
    assert.equal(counter.value, 1);

    // A fetch after serve still reuses the same assembled app.
    const after = await app.fetch(new Request('http://localhost/plugin-route'));
    assert.equal(after.status, 200);
    assert.equal(counter.value, 1);

    await handle.close();
  });

  it('handles two concurrent requests without serializing them', async (t) => {
    const dir = setupCase({ api: { 'concurrent.js': CONCURRENT_SOURCE } });
    const config = makeConfig(dir);

    const app = await openApplication(t, config);

    const [a, b] = await Promise.all([
      app.fetch(new Request('http://localhost/api/concurrent')),
      app.fetch(new Request('http://localhost/api/concurrent')),
    ]);

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    // Both handlers overlap, so the peak concurrency reaches 2. A serialized
    // implementation would cap it at 1.
    assert.equal((await a.json()).peak, 2);
    assert.equal((await b.json()).peak, 2);

    await app.close();
  });

  it('rejects fetch after close', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const app = await openApplication(t, makeConfig(dir, { renderer: new RecordingRenderer() }));

    await app.close();
    await assert.rejects(app.fetch(new Request('http://localhost/')), /application is closed/);
  });

  it('forgets a failed assembly and retries it on the next request', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE, 'about.js': PAGE_SOURCE } });
    const counter = countAssemblies(t);
    // A public directory that is a file fails assembly.
    const publicDir = join(dir, 'public');
    writeFileSync(publicDir, 'not a directory');
    const config = makeConfig(dir, { renderer: new RecordingRenderer() });

    const app = await openApplication(t, config, DEVELOPMENT);

    await assert.rejects(app.fetch(new Request('http://localhost/')), (error: unknown) =>
      AssetErrors.is(error, 'invalid_root'),
    );

    // The failed assembly was forgotten, so the retry assembles afresh.
    rmSync(publicDir);
    writeFile(join(publicDir, 'about'), 'shadowed');
    const res = await app.fetch(new Request('http://localhost/'));
    assert.equal(res.status, 200);
    assert.equal(counter.value, 1);

    // A further request reuses the now-memoized pipeline.
    await app.fetch(new Request('http://localhost/'));
    assert.equal(counter.value, 1);

    await app.close();
  });

  it('close waits for an in-flight fetch before tearing down extensions', async (t) => {
    const dir = setupCase({ api: { 'gated.js': GATED_SOURCE } });
    const events: string[] = [];
    const gate = makeGate();
    const gateExtension: JsailsExtension = {
      name: 'gate',
      setup(context) {
        context.services.provide(GATE, gate);
      },
    };
    const config = makeConfig(dir, {
      extensions: [gateExtension, orderExtension('a', events)],
    });
    // Registered before the app's close, so a failed assertion releases the
    // handler that close waits on.
    t.after(() => gate.release());

    const app = await openApplication(t, config);

    const pending = app.fetch(new Request('http://localhost/api/gated'));
    await waitFor(() => gate.started());

    const closing = app.close();
    // Teardown must not run while the handler is still in flight.
    assert.deepEqual(events, ['a']);

    gate.release();
    assert.equal(await pending.then((res) => res.text()), 'done');
    await closing;

    assert.deepEqual(events, ['a', 'dispose-a']);
  });
});

// ---------------------------------------------------------------------------
// Close: bounded transport shutdown
// ---------------------------------------------------------------------------

describe('Application.close: shutdown timeout', () => {
  it('forces the deadline on a lingering non-Socket.IO upgraded socket and still tears down', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const events: string[] = [];
    const config = makeConfig(dir, {
      shutdownTimeoutMs: 30,
      setup() {
        events.push('app-setup');
        return () => {
          events.push('app-cleanup');
        };
      },
      extensions: [
        orderExtension('a', events),
        broadcastPlugin({ allowedOrigins: ['https://app.example'], authenticate: () => 'user' }),
      ],
    });

    const app = await createApplication(config);
    t.after(async () => {
      try {
        await app.close();
      } catch {
        // The test asserts this close's deadline error; here it only has to end.
      }
    });
    const handle = await app.serve();

    // Open a raw TCP connection and send a WebSocket upgrade to a path Socket.IO
    // does not own. Socket.IO never closes it, so the server's drain would wait
    // on it forever; the shutdown deadline must force it instead.
    const stuck = connect(handle.port, '127.0.0.1');
    t.after(() => stuck.destroy());
    // Wait until the server has processed the upgrade request: only then is the
    // socket a genuine "upgraded" connection that neither closeIdleConnections
    // nor closeAllConnections touches, so the deadline (not a forced close) must
    // be what ends it.
    const upgraded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('upgrade not processed')), 3000);
      handle.server.once('upgrade', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    stuck.write(
      'GET /not-socket-io HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n',
    );
    await upgraded;

    // Wait until the server has accepted and tracked the connection.
    await waitForConnections(handle.server, 1);

    await assert.rejects(app.close(), (error: unknown) => {
      assert.ok(ServeErrors.is(error, 'shutdown_timeout'), String(error));
      assert.equal(error.context.upgraded, 1, 'the upgraded socket is counted');
      // Broadcast disconnected its own (absent) clients: the socket it does not
      // own is not blamed on it.
      assert.deepEqual(error.payload, { attachments: [] });
      return true;
    });

    // Transport teardown was forced, but the app cleanup and reverse extension
    // teardown still ran.
    assert.deepEqual(events, ['a', 'app-setup', 'app-cleanup', 'dispose-a']);

    // The server owns no active connection afterward.
    await waitForConnections(handle.server, 0);
  });

  it('closes normally without a lingering connection and without a timeout', async (t) => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const config = makeConfig(dir, {
      shutdownTimeoutMs: 30,
      extensions: [
        broadcastPlugin({ allowedOrigins: ['https://app.example'], authenticate: () => 'user' }),
      ],
    });

    const app = await openApplication(t, config);
    await app.serve();
    await app.close();
  });
});

/** Poll `server.getConnections` until the count matches `expected`. */
function waitForConnections(server: NodeHttpServer, expected: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = (): void => {
      server.getConnections((error, count) => {
        if (error) {
          reject(error);
          return;
        }
        if (count === expected) {
          resolve();
          return;
        }
        if (Date.now() - started > 3000) {
          reject(new Error(`timed out waiting for ${expected} connections (have ${count})`));
          return;
        }
        setTimeout(check, 5);
      });
    };
    check();
  });
}

/** Connect a Socket.IO client to the broadcast path on `port`. */
function connectSocket(port: number): Promise<void> {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    path: BROADCAST_PATH,
    transports: ['websocket'],
    reconnection: false,
    timeout: 2000,
    extraHeaders: { Origin: 'https://app.example' },
  });
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('socket connect timed out'));
    }, 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}
