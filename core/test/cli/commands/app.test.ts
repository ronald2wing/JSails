/**
 * Tests for `runAppCommand` (`build`, `serve`) through injected dependencies,
 * plus the `build` subprocess against a fixture project.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  CLI_SUITE_CONCURRENCY,
  cliPath,
  runCli as spawnCli,
  type ProcessResult,
} from '../spawn-cli.js';

import type { Application, CreateApplicationOptions } from '../../../src/app/application.js';
import type { ResolvedAppConfig } from '../../../src/app/config/index.js';
import { AppConfigError } from '../../../src/app/config/errors.js';
import { reportAppFailure, runAppCommand, type AppDeps } from '../../../src/cli/commands/app.js';
import type { GenerateStaticSiteResult } from '../../../src/pages/static-site/index.js';
import { JsailsError } from '../../../src/errors/jsails-error.js';
import { RouteManifestError } from '../../../src/routing/routes.js';
import type { ShutdownSignal } from '../../../src/cli/shutdown.js';

/**
 * Tests for the app CLI (`build` / `serve`) and the app command injection seam.
 *
 * Unit tests inject fake factories through `runAppCommand` to verify lifecycle,
 * close-once semantics, and signal disposal without a real server or config
 * module. Subprocess tests run the compiled CLI against real `jsails.app.js`
 * modules that use an in-memory service provider (no database is ever opened).
 */

// ---------------------------------------------------------------------------
// injection seam: fake factories
// ---------------------------------------------------------------------------

interface FakeAppHandle {
  config: ResolvedAppConfig;
  options: CreateApplicationOptions | undefined;
  buildCalls: number;
  serveCalls: number;
  closeCalls: number;
  closeSignals: (AbortSignal | undefined)[];
}

/** The loaded app the commands are handed; the fake factory only passes it through. */
const SOURCE = { configPath: 'jsails.app.js' } as unknown as ResolvedAppConfig;

/** What the fake app's build answers: a page skipped, one not found, one redirected. */
const BUILD_RESULT: GenerateStaticSiteResult = {
  written: ['/out/index.html', '/out/moved/index.html'],
  copied: [],
  skipped: ['/api/x'],
  liveOnly: ['/account'],
  raw: ['/out/redirects.json'],
  redirects: [{ from: '/moved', to: 'https://pay.example/?token=secret', status: 308 }],
  notFound: ['/posts/draft', '/posts/missing'],
};

function makeFakeAppDeps() {
  const events: string[] = [];
  const apps: FakeAppHandle[] = [];
  let buildError: Error | undefined;
  let serveError: Error | undefined;
  let markServed!: () => void;
  const served = new Promise<void>((resolve) => {
    markServed = resolve;
  });

  const deps: AppDeps = {
    createApplication: async (config, options) => {
      events.push('create');
      const handle: FakeAppHandle = {
        config: config as ResolvedAppConfig,
        options,
        buildCalls: 0,
        serveCalls: 0,
        closeCalls: 0,
        closeSignals: [],
      };
      apps.push(handle);
      return {
        build: async () => {
          events.push('build');
          handle.buildCalls += 1;
          if (buildError) throw buildError;
          return BUILD_RESULT;
        },
        serve: async () => {
          events.push('serve');
          handle.serveCalls += 1;
          if (serveError) throw serveError;
          markServed();
          return { url: 'http://127.0.0.1:9/' };
        },
        close: async (options?: { signal?: AbortSignal }) => {
          events.push('close');
          handle.closeCalls += 1;
          handle.closeSignals.push(options?.signal);
        },
      } as unknown as Application;
    },
  };

  return {
    deps,
    events,
    apps,
    served,
    setBuildError: (error: Error) => {
      buildError = error;
    },
    setServeError: (error: Error) => {
      serveError = error;
    },
  };
}

function makeSignal(events?: string[]) {
  let disposed = 0;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const abort = new AbortController();
  const signal: ShutdownSignal = {
    promise,
    abort: abort.signal,
    dispose: () => {
      events?.push('dispose');
      disposed += 1;
    },
  };
  return {
    signal,
    resolve: () => resolve(),
    disposeCount: () => disposed,
  };
}

// ---------------------------------------------------------------------------
// injection seam: build lifecycle
// ---------------------------------------------------------------------------

describe('runAppCommand: build', () => {
  it('creates over the loaded app, builds, and closes exactly once', async () => {
    const fake = makeFakeAppDeps();
    const code = await runAppCommand('build', SOURCE, fake.deps);

    assert.equal(code, 0);
    assert.equal(fake.apps[0]?.config, SOURCE);
    assert.equal(fake.apps.length, 1);
    assert.equal(fake.apps[0]?.buildCalls, 1);
    assert.equal(fake.apps[0]?.closeCalls, 1, 'app closed exactly once');
  });

  it('names every page that answered not-found or redirected', async (t) => {
    const lines: string[] = [];
    t.mock.method(console, 'log', (line: unknown) => {
      lines.push(String(line));
    });
    const fake = makeFakeAppDeps();
    assert.equal(await runAppCommand('build', SOURCE, fake.deps), 0);
    const notFound = lines.findIndex((line) => line.startsWith('Wrote nothing for 2 page(s)'));
    assert.ok(notFound >= 0, 'the not-found pages are counted');
    assert.deepEqual(lines.slice(notFound + 1, notFound + 3), [
      '  /posts/draft',
      '  /posts/missing',
    ]);
    const redirects = lines.findIndex((line) => line.startsWith('Recorded 1 redirect(s)'));
    assert.ok(redirects >= 0, 'the redirects are counted');
    assert.match(lines[redirects]!, /redirects\.json/);
    // The target stays in redirects.json: it may carry what a log should not.
    assert.equal(lines[redirects + 1], '  /moved (308)');
    assert.ok(lines.every((line) => !line.includes('secret')));
  });

  it('assembles the build in safe mode, so it runs only the config plugins', async () => {
    const fake = makeFakeAppDeps();
    assert.equal(await runAppCommand('build', SOURCE, fake.deps), 0);
    assert.deepEqual(fake.apps[0]?.options, { safeMode: true });
  });

  it('closes the app exactly once when the build fails', async () => {
    const fake = makeFakeAppDeps();
    fake.setBuildError(new Error('build boom'));

    await assert.rejects(runAppCommand('build', SOURCE, fake.deps), /build boom/);

    assert.equal(fake.apps[0]?.buildCalls, 1);
    assert.equal(fake.apps[0]?.closeCalls, 1, 'app closed exactly once on build failure');
  });
});

// ---------------------------------------------------------------------------
// failure reporting
// ---------------------------------------------------------------------------

describe('reportAppFailure', () => {
  /** The lines a failure report writes, with debug off, and its exit code. */
  async function report(error: unknown): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    const code = await reportAppFailure(error, (line) => lines.push(line), { env: {} });
    return { code, lines };
  }

  it('echoes a config error, which is value-free by construction', async () => {
    assert.deepEqual(await report(new AppConfigError('config.port is invalid')), {
      code: 1,
      lines: ['jsails: config.port is invalid'],
    });
  });

  it('echoes a route manifest error raised while assembling', async () => {
    const error = new RouteManifestError('duplicate_route', 'two modules claim the route /a');
    assert.deepEqual((await report(error)).lines, ['jsails: two modules claim the route /a']);
  });

  it('replaces the message of any other error, a framework-shaped one included', async () => {
    class ExtensionError extends JsailsError {
      readonly code = 'setup_failed';
    }
    for (const error of [new Error('token=secret'), new ExtensionError('token=secret'), 'raw']) {
      const { code, lines } = await report(error);
      assert.equal(code, 1);
      assert.equal(lines[0], 'jsails: the application command failed');
      assert.ok(!lines.join('\n').includes('secret'), 'the message never reaches the report');
    }
  });

  it("follows a config error with its cause's value-free facts", async () => {
    const cause = new TypeError('token=secret');
    const { lines } = await report(
      new AppConfigError('failed to load app config "jsails.app.js"', {
        code: 'load_failed',
        cause,
      }),
    );
    assert.equal(lines[0], 'jsails: failed to load app config "jsails.app.js"');
    assert.match(lines[1] ?? '', /^ {2}caused by: TypeError\b/);
    assert.ok(!lines.join('\n').includes('secret'));
  });
});

// ---------------------------------------------------------------------------
// injection seam: serve lifecycle
// ---------------------------------------------------------------------------

describe('runAppCommand: serve', () => {
  it('installs signals before startup, then closes exactly once on signal', async () => {
    const fake = makeFakeAppDeps();
    const sig = makeSignal();

    const pending = runAppCommand('serve', SOURCE, {
      ...fake.deps,
      waitForShutdown: () => {
        fake.events.push('signal-install');
        return sig.signal;
      },
    });

    await fake.served;
    assert.equal(fake.apps[0]?.closeCalls, 0, 'app stays open while serving');

    sig.resolve();
    const code = await pending;

    assert.equal(code, 0);
    assert.equal(fake.apps[0]?.options?.safeMode, undefined, 'serve runs the sealed mode');
    assert.equal(fake.apps[0]?.closeCalls, 1, 'app closed exactly once on shutdown');
    assert.equal(sig.disposeCount(), 1, 'signal listeners disposed on shutdown');
    assert.ok(
      fake.events.indexOf('signal-install') < fake.events.indexOf('create'),
      'signal handlers installed before application assembly',
    );
  });

  it('runs the web role, adds the worker with --with, and drains under the second signal', async () => {
    const fake = makeFakeAppDeps();
    const sig = makeSignal(fake.events);
    const pending = runAppCommand(
      'serve',
      SOURCE,
      { ...fake.deps, waitForShutdown: () => sig.signal },
      { with: ['worker'] },
    );
    await fake.served;
    sig.resolve();
    assert.equal(await pending, 0);

    assert.deepEqual(fake.apps[0]?.options, { roles: ['web', 'worker'], purpose: 'serve' });
    assert.deepEqual(fake.apps[0]?.closeSignals, [sig.signal.abort]);
    assert.ok(
      fake.events.indexOf('close') < fake.events.indexOf('dispose'),
      'the handlers stay installed while the app drains',
    );

    const webOnly = makeFakeAppDeps();
    const second = makeSignal();
    const serving = runAppCommand('serve', SOURCE, {
      ...webOnly.deps,
      waitForShutdown: () => second.signal,
    });
    await webOnly.served;
    second.resolve();
    assert.equal(await serving, 0);
    assert.deepEqual(webOnly.apps[0]?.options?.roles, ['web']);
  });

  it('disposes signal listeners and closes the app when listen fails', async () => {
    const fake = makeFakeAppDeps();
    fake.setServeError(new Error('EADDRINUSE'));
    const sig = makeSignal();

    await assert.rejects(
      runAppCommand('serve', SOURCE, { ...fake.deps, waitForShutdown: () => sig.signal }),
      /EADDRINUSE/,
    );

    assert.equal(fake.apps[0]?.closeCalls, 1, 'app closed exactly once on listen failure');
    assert.equal(sig.disposeCount(), 1, 'signal listeners disposed on listen failure');
  });
});

// ---------------------------------------------------------------------------
// subprocess: real CLI
// ---------------------------------------------------------------------------

const indexUrl = pathToFileURL(
  fileURLToPath(new URL('../../../src/index.js', import.meta.url)),
).href;
const apiUrl = pathToFileURL(
  fileURLToPath(new URL('../../../src/api/index.js', import.meta.url)),
).href;

// Fixtures live under dist/ so bare imports resolve to the repo's node_modules.
const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('../..', import.meta.url)), 'app-cli-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string): Promise<ProcessResult> {
  return spawnCli(args, { cwd });
}

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, content: string, filename = 'jsails.app.js'): void {
  writeFileSync(join(dir, filename), content);
}

function writePage(dir: string, rel = 'index.js'): void {
  const path = join(dir, 'pages', rel);
  mkdirSync(join(dir, 'pages'), { recursive: true });
  writeFileSync(path, 'export default function Page() { return null; };\n');
}

/** A config with a custom renderer + an extension-provided in-memory service. */
const BUILD_CONFIG = `import { createServiceToken, documentOutcome } from ${JSON.stringify(indexUrl)};

const GREETER = createServiceToken('greeter');

const greeterExtension = {
  name: 'greeter',
  setup(context) {
    context.services.provide(GREETER, { greeting: 'hello-from-extension' });
    return () => {};
  },
};

const renderer = {
  render(entry, context) {
    const greeting = context.services.get(GREETER).greeting;
    return documentOutcome('<html><body>' + greeting + ':' + entry.route + '</body></html>');
  },
};

export default { renderer, extensions: [greeterExtension] };
`;

/** A config whose `setup` cleanup writes a marker on shutdown (for `serve`). */
const SERVE_CONFIG = `import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentOutcome } from ${JSON.stringify(indexUrl)};

const here = dirname(fileURLToPath(import.meta.url));

export default {
  port: 0,
  renderer: {
    render(entry) {
      return documentOutcome('<html><body>served:' + entry.route + '</body></html>');
    },
  },
  setup() {
    return () => {
      writeFileSync(join(here, 'cleanup.marker'), 'closed');
    };
  },
};
`;

describe('cli: build subprocess', { concurrency: CLI_SUITE_CONCURRENCY }, () => {
  it('builds a static site with a custom renderer + extension service (no database)', async () => {
    const dir = makeDir('build-static');
    writePage(dir);
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(
      join(dir, 'api', 'hello.js'),
      'export async function GET() { return new Response("{}"); }\n',
    );
    writeFileSync(
      join(dir, 'pages', 'account.js'),
      `import { definePage } from ${JSON.stringify(apiUrl)};
export const route = definePage('/account', { access: ({ session }) => session !== null });
export default () => 'account';
`,
    );
    writeConfig(dir, BUILD_CONFIG);

    const result = await runCli(['build'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Built 1 output file/);
    assert.match(result.stdout, /Skipped 1 API route/);
    assert.match(result.stdout, /Skipped 1 live-only page/);
    assert.equal(existsSync(join(dir, 'out', 'account')), false);

    const html = readFileSync(join(dir, 'out', 'index.html'), 'utf8');
    assert.match(html, /hello-from-extension:\//);
  });

  it('refuses a jsails.config.ts that imports app code, at its line and column', async () => {
    const dir = makeDir('ts-app-config');
    // Its own package, as an app is: inside the `jsails` package a bare
    // `jsails/kernel` would be a self-reference, which the scan refuses first.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ts-app', type: 'module' }));
    writeFileSync(
      join(dir, 'jsails.config.ts'),
      [
        "import { defineApp } from 'jsails/kernel';",
        "import user from './models/user.ts';",
        'export default defineApp({ config: () => ({ port: user }) });',
        '',
      ].join('\n'),
    );
    const result = await runCli(['build', '--config', 'jsails.config.ts'], dir);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /jsails\.config\.ts imports outside the config graph \(relative_import\) at 2:1/,
    );
  });

  it('rejects a missing app config without leaking filesystem details', async () => {
    const dir = makeDir('missing-app-config');
    const result = await runCli(['build', '--config', 'nope.js'], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load app config/);
  });

  it('does not echo a config module exception', async () => {
    const dir = makeDir('throwing-app-config');
    writeConfig(dir, `throw new Error('supersecret-password'); export default {};`);

    const result = await runCli(['build'], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load app config/);
    assert.doesNotMatch(result.stderr, /supersecret-password/);
  });

  it('does not echo an extension setup error that embeds a secret', async () => {
    const dir = makeDir('extension-secret');
    writeConfig(
      dir,
      `import { createServiceToken } from ${JSON.stringify(indexUrl)};
const T = createServiceToken('x');
export default {
  extensions: [{ name: 'boom', setup() { throw new Error('supersecret-password'); } }],
};`,
    );

    const result = await runCli(['build'], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /the application command failed/);
    assert.doesNotMatch(result.stderr, /supersecret-password/);
  });

  it('does not echo a renderer error that embeds a secret', async () => {
    const dir = makeDir('renderer-secret');
    writePage(dir);
    writeConfig(
      dir,
      `export default {
  renderer: { render() { throw new Error('another-supersecret'); } },
};`,
    );

    const result = await runCli(['build'], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /the application command failed/);
    assert.doesNotMatch(result.stderr, /another-supersecret/);
  });

  it('rejects migration-only flags on app commands', async () => {
    const dir = makeDir('app-flags');
    writeConfig(dir, `export default {};`);

    const [build, serve] = await Promise.all([
      runCli(['build', '--migrations', 'x'], dir),
      runCli(['serve', '--name', 'x'], dir),
    ]);
    assert.equal(build.status, 2);
    assert.equal(serve.status, 2);
  });
});

describe('cli: serve subprocess', () => {
  it(
    'serves an ephemeral-port HTTP response, then SIGTERM shuts down and runs cleanup',
    {
      skip:
        process.platform === 'win32' &&
        'Windows has no graceful signals: kill() terminates the child outright, so no shutdown hook can run',
    },
    async () => {
      const dir = makeDir('serve-ephemeral');
      writePage(dir);
      writeConfig(dir, SERVE_CONFIG);

      const { child, waitForUrl } = startServe(dir);
      try {
        const url = await waitForUrl();

        const response = await fetch(url);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /served:/);

        const exit = await signalAndWait(child, 'SIGTERM');
        assert.equal(exit.code, 0, 'serve exits cleanly after SIGTERM');
        assert.ok(existsSync(join(dir, 'cleanup.marker')), 'setup cleanup ran on SIGTERM');
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
    },
  );
});

describe('cli: help keeps every command', () => {
  it('lists migration, work, schedule, build, and serve in --help', async () => {
    const result = await runCli(['--help'], makeDir('help'));

    assert.equal(result.status, 0, result.stderr);
    for (const name of ['db:push', 'db:diff', 'work', 'schedule', 'build', 'serve']) {
      assert.match(result.stdout, new RegExp(name), `help must list ${name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// subprocess helpers
// ---------------------------------------------------------------------------

/**
 * How long a serve child may take to print its URL, or to exit after a
 * signal, before the test gives up with its output. It only guards against a
 * hang (each waiter settles on the child's own event the moment it happens),
 * so it is generous: on a loaded machine a serve child has taken more than
 * 15 s just to start and assemble the app.
 */
const SERVE_EVENT_LIMIT_MS = 120_000;

/** Start `jsails serve` and return the child plus a URL waiter. */
function startServe(dir: string): {
  child: ChildProcess;
  waitForUrl: () => Promise<string>;
  output: () => { stdout: string; stderr: string };
} {
  const child = spawn(process.execPath, [cliPath, 'serve'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  // 'close' rather than 'exit': it fires once the output streams are drained,
  // so a URL printed just before exiting is never missed.
  let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    closed = { code, signal };
  });

  // Resolves on the URL line, and rejects as soon as the child exits without
  // printing it (a config or startup failure), so a broken serve fails the
  // test at once instead of after the whole startup allowance.
  const waitForUrl = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const found = (): string | undefined => /Serving at (http:\/\/\S+)/.exec(stdout)?.[1];
      const timer = setTimeout(() => {
        settle();
        reject(new Error(`timed out waiting for serve URL; stdout: ${stdout}; stderr: ${stderr}`));
      }, SERVE_EVENT_LIMIT_MS);
      const settle = (): void => {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        child.off('close', onClose);
      };
      const onData = (): void => {
        const url = found();
        if (url === undefined) return;
        settle();
        resolve(url);
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        settle();
        const url = found();
        if (url !== undefined) {
          resolve(url);
          return;
        }
        reject(
          new Error(
            `serve exited (code ${String(code)}, signal ${String(signal)}) before printing its URL; stderr: ${stderr}`,
          ),
        );
      };
      child.stdout?.on('data', onData);
      child.on('close', onClose);
      if (closed === undefined) {
        onData();
      } else {
        onClose(closed.code, closed.signal);
      }
    });

  return { child, waitForUrl, output: () => ({ stdout, stderr }) };
}

/** Send `signal` and resolve when the child exits, or reject on timeout. */
function signalAndWait(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  child.kill(signal);
  // The guard timer is cleared once the child exits: left pending, it would
  // keep the test process alive for its whole duration after the last test.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for exit after ${signal}`)),
      SERVE_EVENT_LIMIT_MS,
    );
  });
  return Promise.race([exited, timeout]).finally(() => clearTimeout(timer));
}
