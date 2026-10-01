import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DEV_CONFIG_ENV,
  DEV_CWD_ENV,
  runDev,
  type DevChild,
  type DevDeps,
  type DevSpawnOptions,
} from '../../src/dev/dev-runtime.js';
import { applyDefaultNodeEnv } from '../../src/dev/serve-child.js';
import type { ChangeClass } from '../../src/dev/change-classify.js';
import {
  DEV_GENERATION_ENV,
  generationFilePath,
  readGeneration,
} from '../../src/dev/dev-generation.js';

/**
 * Tests for the dev runtime orchestration (`runDev`).
 *
 * These drive the real orchestration against fake process and watcher seams: no
 * compiler, Vite, or serve process is ever started. The fakes record every
 * spawn, signal, and watch request so the tests can assert on command order,
 * restart behavior, and teardown ownership.
 */

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

/** A fake child process: an EventEmitter plus a manually-triggered exit/error. */
class FakeChild implements DevChild {
  private readonly emitter = new EventEmitter();
  readonly pid: number;
  exitCode: number | null = null;

  constructor(pid: number) {
    this.pid = pid;
  }

  on(event: 'exit' | 'error', listener: (...args: any[]) => void): void {
    this.emitter.on(event, listener);
  }

  once(event: 'exit' | 'error', listener: (...args: any[]) => void): void {
    this.emitter.once(event, listener);
  }

  removeListener(event: 'exit' | 'error', listener: (...args: any[]) => void): void {
    this.emitter.removeListener(event, listener);
  }

  exit(code: number): void {
    this.exitCode = code;
    this.emitter.emit('exit', code, null);
  }

  fail(): void {
    this.emitter.emit('error', new Error('spawn failed'));
  }
}

interface SpawnRecord {
  command: string;
  args: readonly string[];
  options: DevSpawnOptions | undefined;
  child: FakeChild;
}

interface WatcherRecord {
  root: string;
  onChange: (change: ChangeClass) => void;
  onError: (error: unknown) => void;
  closed: number;
}

interface Harness {
  deps: DevDeps;
  spawns: SpawnRecord[];
  killed: Array<{ pid: number; signal: string }>;
  metaRuns: string[];
  signal: () => void;
  disposeCount: () => number;
  watcher: () => WatcherRecord | undefined;
  notifyChange: (change?: ChangeClass) => void;
  notifyWatcherError: (error: unknown) => void;
}

const createdDirs: string[] = [];

after(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Track a temp dir so the `after` hook can remove it. */
function makeProject(files: { tsconfig?: boolean; viteConfig?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-dev-proj-'));
  createdDirs.push(dir);
  if (files.tsconfig) writeFileSync(join(dir, 'tsconfig.json'), '{}');
  if (files.viteConfig) writeFileSync(join(dir, 'vite.config.js'), 'export default {};');
  return dir;
}

function createHarness(
  options: {
    resolveTool?: (tool: 'tsc' | 'vite') => string | undefined;
    runMeta?: (rootDir: string) => Promise<number>;
  } = {},
): Harness {
  const spawns: SpawnRecord[] = [];
  const killed: Array<{ pid: number; signal: string }> = [];
  const metaRuns: string[] = [];
  let watcher: WatcherRecord | undefined;
  let nextPid = 1000;
  let resolveSignal!: () => void;
  let disposed = 0;
  const signalPromise = new Promise<void>((resolvePromise) => {
    resolveSignal = resolvePromise;
  });

  const resolveTool = options.resolveTool ?? ((tool) => `/tools/${tool}.js`);

  const deps: DevDeps = {
    spawn: (command, args, spawnOptions) => {
      const child = new FakeChild(nextPid);
      nextPid += 1;
      spawns.push({ command, args, options: spawnOptions, child });
      return child;
    },
    killGroup: (pid, signal) => {
      killed.push({ pid, signal });
      return true;
    },
    waitForShutdown: () => ({
      promise: signalPromise,
      dispose: () => {
        disposed += 1;
      },
    }),
    resolveTool: (tool) => resolveTool(tool),
    resolveServeChild: () => '/tools/serve-child.js',
    watchProject: (root, listeners) => {
      watcher = {
        root,
        onChange: listeners.onChange,
        onError: listeners.onError,
        closed: 0,
      };
      return {
        close: () => {
          if (watcher !== undefined) {
            watcher.closed += 1;
          }
        },
      };
    },
    runMeta: (rootDir) => {
      metaRuns.push(rootDir);
      return options.runMeta?.(rootDir) ?? Promise.resolve(0);
    },
    graceMs: 10,
  };

  return {
    deps,
    spawns,
    killed,
    metaRuns,
    signal: () => resolveSignal(),
    disposeCount: () => disposed,
    watcher: () => watcher,
    notifyChange: (change = 'server-restart') => watcher?.onChange(change),
    notifyWatcherError: (error) => watcher?.onError(error),
  };
}

/** Capture `console.error` output so tests can assert on actionable messages. */
function captureErrors(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  return {
    errors,
    restore: () => {
      console.error = original;
    },
  };
}

const tick = (): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, 0));

async function waitFor(cond: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${message}`);
    }
    await tick();
  }
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

describe('runDev: orchestration', () => {
  it('compiles (tsc then vite), then watches and serves, shutting down on signal', async () => {
    const dir = makeProject({ tsconfig: true, viteConfig: true });
    const h = createHarness();

    const pending = runDev({ cwd: dir }, h.deps);

    // build:meta runs in-process before the initial build.
    await waitFor(() => h.metaRuns.length === 1, 'build:meta to run');
    assert.equal(h.metaRuns[0], dir);

    // Initial build: tsc first.
    await waitFor(() => h.spawns.length === 1, 'the tsc initial build to spawn');
    assert.equal(h.spawns[0]?.command, process.execPath);
    assert.deepEqual(h.spawns[0]?.args, ['/tools/tsc.js', '-p', 'tsconfig.json']);
    h.spawns[0]?.child.exit(0);

    // Then vite.
    await waitFor(() => h.spawns.length === 2, 'the vite initial build to spawn');
    assert.deepEqual(h.spawns[1]?.args, ['/tools/vite.js', 'build']);
    h.spawns[1]?.child.exit(0);

    // Then two watchers and the serve child.
    await waitFor(() => h.spawns.length === 5, 'the watchers to spawn');
    assert.deepEqual(h.spawns[2]?.args, [
      '/tools/tsc.js',
      '-p',
      'tsconfig.json',
      '--watch',
      '--preserveWatchOutput',
    ]);
    assert.deepEqual(h.spawns[3]?.args, ['/tools/vite.js', 'build', '--watch']);

    const serve = h.spawns[4]!;
    assert.deepEqual(serve.args, ['/tools/serve-child.js']);
    assert.equal(serve.options?.cwd, dir);
    assert.equal(serve.options?.detached, true);
    assert.equal(serve.options?.env?.[DEV_CWD_ENV], dir);
    assert.equal(serve.options?.env?.[DEV_CONFIG_ENV], resolve(dir, 'jsails.app.js'));
    assert.equal(serve.options?.env?.[DEV_GENERATION_ENV], generationFilePath(dir));
    assert.equal(h.watcher()?.root, dir);

    // The baseline is written before the first spawn, so the child never boots
    // at a generation the parent has already moved past.
    assert.equal(readGeneration(generationFilePath(dir)), 0);

    h.signal();
    const code = await pending;

    assert.equal(code, 0);

    // Only the three owned processes remain; each gets SIGTERM then SIGKILL.
    const watcherPids = [h.spawns[2].child.pid, h.spawns[3].child.pid, serve.child.pid];
    assert.deepEqual(h.killed, [
      { pid: watcherPids[0], signal: 'SIGTERM' },
      { pid: watcherPids[1], signal: 'SIGTERM' },
      { pid: watcherPids[2], signal: 'SIGTERM' },
      { pid: watcherPids[0], signal: 'SIGKILL' },
      { pid: watcherPids[1], signal: 'SIGKILL' },
      { pid: watcherPids[2], signal: 'SIGKILL' },
    ]);

    assert.equal(h.disposeCount(), 1, 'signal listeners disposed exactly once');
    assert.equal(h.watcher()?.closed, 1, 'the project watcher is closed exactly once');
  });

  it('skips tools whose config files are absent (precompiled app, serve only)', async () => {
    const dir = makeProject();
    const h = createHarness();

    const pending = runDev({ cwd: dir }, h.deps);

    await waitFor(() => h.spawns.length === 1, 'the serve child to spawn');
    assert.equal(h.spawns[0]?.command, process.execPath);
    assert.deepEqual(h.spawns[0]?.args, ['/tools/serve-child.js']);

    h.signal();
    assert.equal(await pending, 0);
  });

  it('restarts the serve child after a relevant project change', async () => {
    const dir = makeProject();
    const h = createHarness();

    const pending = runDev({ cwd: dir }, h.deps);
    await waitFor(() => h.spawns.length === 1, 'the first serve child to spawn');
    const first = h.spawns[0]!.child;

    h.notifyChange();
    await waitFor(
      () => h.killed.some((entry) => entry.pid === first.pid && entry.signal === 'SIGTERM'),
      'the first serve child to receive SIGTERM',
    );
    first.exit(0);

    await waitFor(() => h.spawns.length === 2, 'the replacement serve child to spawn');
    assert.deepEqual(h.spawns[1]?.args, ['/tools/serve-child.js']);

    h.signal();
    assert.equal(await pending, 0);
  });

  it('bumps the generation without restarting for a client-only change', async () => {
    const dir = makeProject();
    const h = createHarness();

    const pending = runDev({ cwd: dir }, h.deps);
    await waitFor(() => h.spawns.length === 1, 'the serve child to spawn');
    const generationPath = generationFilePath(dir);
    assert.equal(readGeneration(generationPath), 0);

    h.notifyChange('client-reload');
    await waitFor(() => readGeneration(generationPath) === 1, 'the generation to bump');

    // A reload is a browser concern; the process serving it is unchanged.
    assert.equal(h.spawns.length, 1, 'no new serve child was spawned');
    assert.equal(h.killed.length, 0, 'the serve child was not signalled');

    h.signal();
    assert.equal(await pending, 0);
  });

  it('bumps the generation and restarts for a server change', async () => {
    const dir = makeProject();
    const h = createHarness();

    const pending = runDev({ cwd: dir }, h.deps);
    await waitFor(() => h.spawns.length === 1, 'the first serve child to spawn');
    const first = h.spawns[0]!.child;
    const generationPath = generationFilePath(dir);

    h.notifyChange('server-restart');
    await waitFor(() => readGeneration(generationPath) === 1, 'the generation to bump');
    await waitFor(
      () => h.killed.some((entry) => entry.pid === first.pid && entry.signal === 'SIGTERM'),
      'the first serve child to receive SIGTERM',
    );
    first.exit(0);
    await waitFor(() => h.spawns.length === 2, 'the replacement serve child to spawn');

    // The replacement reads the bumped value, so a tab that reconnects after
    // the restart sees a generation it does not have and reloads.
    assert.equal(h.spawns[1]?.options?.env?.[DEV_GENERATION_ENV], generationPath);
    assert.equal(readGeneration(generationPath), 1);

    h.signal();
    assert.equal(await pending, 0);
  });

  it('does not swallow a reload that lands during an in-flight restart', async () => {
    const dir = makeProject();
    const h = createHarness();

    const pending = runDev({ cwd: dir }, h.deps);
    await waitFor(() => h.spawns.length === 1, 'the first serve child to spawn');
    const first = h.spawns[0]!.child;
    const generationPath = generationFilePath(dir);

    // Start a restart, then land a client change before the child has exited.
    h.notifyChange('server-restart');
    await waitFor(() => readGeneration(generationPath) === 1, 'the restart bump');
    h.notifyChange('client-reload');
    await waitFor(() => readGeneration(generationPath) === 2, 'the reload bump');

    first.exit(0);
    await waitFor(() => h.spawns.length === 2, 'the replacement serve child to spawn');
    assert.equal(readGeneration(generationPath), 2, 'the reload bump survived the restart');

    h.signal();
    assert.equal(await pending, 0);
  });

  it('aborts cleanly when a signal arrives during the initial build', async () => {
    const dir = makeProject({ tsconfig: true });
    const h = createHarness();

    const pending = runDev({ cwd: dir }, h.deps);

    // The tsc build is still running when the signal lands.
    await waitFor(() => h.spawns.length === 1, 'the tsc initial build to spawn');
    const build = h.spawns[0]!.child;
    h.signal();
    const code = await pending;

    assert.equal(code, 0);
    // The in-flight build is still owned and torn down.
    assert.deepEqual(h.killed, [
      { pid: build.pid, signal: 'SIGTERM' },
      { pid: build.pid, signal: 'SIGKILL' },
    ]);
    assert.equal(h.disposeCount(), 1);
    assert.equal(h.watcher(), undefined, 'no project watcher was started');
  });

  it('returns the build exit code when the initial build fails', async () => {
    const dir = makeProject({ tsconfig: true });
    const h = createHarness();

    const cap = captureErrors();
    let code: number;
    try {
      const pending = runDev({ cwd: dir }, h.deps);
      await waitFor(() => h.spawns.length === 1, 'the tsc initial build to spawn');
      h.spawns[0]!.child.exit(2);
      code = await pending;
    } finally {
      cap.restore();
    }

    assert.equal(code, 2);
    assert.ok(cap.errors.some((e) => e.includes('initial build failed')));
    // The failed build already exited, so nothing is left to tear down.
    assert.equal(h.killed.length, 0);
    assert.equal(h.disposeCount(), 1);
    assert.equal(h.watcher(), undefined);
  });

  it('aborts before any build when build:meta fails', async () => {
    const dir = makeProject({ tsconfig: true });
    const h = createHarness({ runMeta: () => Promise.resolve(1) });

    const cap = captureErrors();
    let code: number;
    try {
      code = await runDev({ cwd: dir }, h.deps);
    } finally {
      cap.restore();
    }

    assert.equal(code, 1);
    assert.ok(cap.errors.some((e) => e.includes('build:meta failed')));
    assert.equal(h.spawns.length, 0, 'no build process was spawned');
    assert.equal(h.disposeCount(), 1);
  });

  it('reports and exits non-zero when a watcher dies unexpectedly', async () => {
    const dir = makeProject({ tsconfig: true });
    const h = createHarness();

    const cap = captureErrors();
    let code: number;
    try {
      const pending = runDev({ cwd: dir }, h.deps);
      await waitFor(() => h.spawns.length === 1, 'the tsc initial build to spawn');
      h.spawns[0]!.child.exit(0); // tsc build succeeds
      await waitFor(() => h.spawns.length === 3, 'the watchers to spawn');

      h.spawns[1]!.child.exit(1); // the tsc watcher dies
      code = await pending;
    } finally {
      cap.restore();
    }

    assert.equal(code, 1);
    assert.ok(cap.errors.some((e) => e.includes('the tsc watcher exited unexpectedly')));
    assert.equal(h.disposeCount(), 1);
  });

  it('reports and exits non-zero when the project watcher errors', async () => {
    const dir = makeProject();
    const h = createHarness();

    const cap = captureErrors();
    let code: number;
    try {
      const pending = runDev({ cwd: dir }, h.deps);
      await waitFor(() => h.spawns.length === 1, 'the serve child to spawn');
      h.notifyWatcherError(new Error('watch failed'));
      code = await pending;
    } finally {
      cap.restore();
    }

    assert.equal(code, 1);
    assert.ok(cap.errors.some((e) => e.includes('file watcher failed')));
    assert.equal(h.watcher()?.closed, 1);
  });
});

// ---------------------------------------------------------------------------
// missing tool bins
// ---------------------------------------------------------------------------

describe('runDev: missing tool bins', () => {
  it('errors with an install hint when tsconfig.json has no TypeScript', async () => {
    const dir = makeProject({ tsconfig: true });
    const h = createHarness({
      resolveTool: (tool) => (tool === 'tsc' ? undefined : '/tools/vite.js'),
    });

    const cap = captureErrors();
    let code: number;
    try {
      code = await runDev({ cwd: dir }, h.deps);
    } finally {
      cap.restore();
    }

    assert.equal(code, 1);
    assert.ok(cap.errors.some((e) => e.includes('run npm install')));
    assert.equal(h.spawns.length, 0, 'no process was spawned');
    assert.equal(h.disposeCount(), 0, 'no signal handler installed');
    assert.equal(h.watcher(), undefined, 'no project watcher created');
  });

  it('errors with an install hint when a Vite config has no Vite', async () => {
    const dir = makeProject({ viteConfig: true });
    const h = createHarness({
      resolveTool: (tool) => (tool === 'vite' ? undefined : '/tools/tsc.js'),
    });

    const cap = captureErrors();
    let code: number;
    try {
      code = await runDev({ cwd: dir }, h.deps);
    } finally {
      cap.restore();
    }

    assert.equal(code, 1);
    assert.ok(cap.errors.some((e) => e.includes('run npm install')));
    assert.equal(h.spawns.length, 0);
    assert.equal(h.disposeCount(), 0);
    assert.equal(h.watcher(), undefined);
  });
});

// ---------------------------------------------------------------------------
// serve-child environment
// ---------------------------------------------------------------------------

describe('runDev: serve child environment', () => {
  it('passes the requested config path and project cwd without redirecting HOME', async () => {
    const dir = makeProject();
    const h = createHarness();

    const pending = runDev({ cwd: dir, configPath: 'custom.app.js' }, h.deps);
    await waitFor(() => h.spawns.length === 1, 'the serve child to spawn');

    const env = h.spawns[0]!.options?.env;
    assert.equal(env?.[DEV_CWD_ENV], dir);
    assert.equal(env?.[DEV_CONFIG_ENV], resolve(dir, 'custom.app.js'));
    assert.equal(env?.HOME, process.env.HOME, 'HOME is inherited unchanged');
    assert.equal(env?.HOMEPATH, process.env.HOMEPATH, 'HOMEPATH is inherited unchanged');

    h.signal();
    assert.equal(await pending, 0);
  });

  it('defaults the config path to jsails.app.js when none is requested', async () => {
    const dir = makeProject();
    const h = createHarness();

    const pending = runDev({ cwd: dir }, h.deps);
    await waitFor(() => h.spawns.length === 1, 'the serve child to spawn');

    assert.equal(h.spawns[0]!.options?.env?.[DEV_CONFIG_ENV], resolve(dir, 'jsails.app.js'));

    h.signal();
    assert.equal(await pending, 0);
  });
});

// ---------------------------------------------------------------------------
// serve-child: NODE_ENV defaulting
// ---------------------------------------------------------------------------

describe('serve-child: NODE_ENV defaulting', () => {
  it('defaults NODE_ENV to development only when it is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    applyDefaultNodeEnv(env);
    assert.equal(env.NODE_ENV, 'development');
  });

  it('preserves an explicitly provided NODE_ENV', () => {
    for (const value of ['development', 'test', 'staging', 'production']) {
      const env: NodeJS.ProcessEnv = { NODE_ENV: value };
      applyDefaultNodeEnv(env);
      assert.equal(env.NODE_ENV, value);
    }
  });

  it('never mutates the parent process environment', () => {
    const original = process.env.NODE_ENV;
    const env: NodeJS.ProcessEnv = {};
    applyDefaultNodeEnv(env);
    assert.equal(process.env.NODE_ENV, original);
  });
});

// ---------------------------------------------------------------------------
// serve-child guard: a deleted project directory fails controlled
// ---------------------------------------------------------------------------

describe('serve-child: guard against a deleted project directory', () => {
  it('fails controlled instead of throwing an unhandled stack', () => {
    const serveChild = join(import.meta.dirname, '../../src/dev/serve-child.js');
    const missingDir = join(tmpdir(), `jsails-dev-missing-${process.pid}`);

    const result = spawnSync(process.execPath, [serveChild], {
      env: { ...process.env, [DEV_CWD_ENV]: missingDir, [DEV_CONFIG_ENV]: 'jsails.app.js' },
      encoding: 'utf8',
    });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /jsails dev:/, 'a controlled message is printed');
    assert.doesNotMatch(result.stderr, /ENOENT/, 'no raw errno leaks to stderr');
    assert.doesNotMatch(result.stderr, /at process\.chdir/, 'no unhandled stack trace');
  });
});
