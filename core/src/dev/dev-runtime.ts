/**
 * CLI-internal development runtime: compile, watch, and serve one app.
 *
 * `runDev` orchestrates the toolchain around a JSails app:
 *
 * 1. An initial build runs `tsc -p tsconfig.json` (only when `tsconfig.json` is
 *    present) and `vite build` (only when a `vite.config.*` file is present).
 *    Each tool binary is resolved from the project's own `node_modules` through
 *    Node's module resolution — never `npx`, never the shell `PATH`. A tool
 *    whose config file is absent is skipped, so a precompiled app (no
 *    TypeScript, no Vite) still works; a tool whose config file is present but
 *    whose binary is missing is an error telling the user to run `npm install`.
 * 2. Once the initial build succeeds, the same tools are restarted in watch
 *    mode (`tsc --watch --preserveWatchOutput`, `vite build --watch`) and the
 *    app is served through `serve-child.js`. A recursive `fs.watch` on the
 *    project classifies each change: compiled server JS restarts the child,
 *    Vite output only bumps the build generation so the browser reloads, and
 *    everything else is ignored. See `change-classify.ts` for the table.
 *
 * The serve-child chdirs back to the project and reads the app config path
 * from the environment, so neither the config path nor the project path is
 * ever shell-interpolated.
 *
 * Every child runs in its own detached process group. `runDev` owns them all
 * and tears them down — bounded SIGTERM grace then SIGKILL — on SIGINT/SIGTERM,
 * a failed or aborted initial build, or an unexpected watcher exit. Only the
 * process groups created here are signalled, never the caller's session. The
 * SIGTERM/SIGKILL pass is a graceful signal on POSIX; on Windows the owned
 * trees are force-terminated (`taskkill.exe /T /F`), so no graceful-shutdown
 * claim is made there.
 */

import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import type { ChangeClass } from './change-classify.js';
import { DEV_GENERATION_ENV, generationFilePath, writeGeneration } from './dev-generation.js';
import { watchProject, type ProjectWatcher } from './project-watcher.js';

import { DEFAULT_APP_CONFIG_PATH } from '../app/config/index.js';
import { killOwnedProcessTree } from '../cli/owned-process-tree.js';
import { runMetaCommand } from '../cli/meta-commands.js';
import {
  injectScopedAutoImportsInDirectory,
  watchScopedAutoImports,
} from '../compiler/scoped-auto-imports.js';
import { waitForShutdownSignal, type ShutdownSignal } from '../cli/shutdown.js';

/** Environment variable carrying the project cwd into the serve child. */
export const DEV_CWD_ENV = 'JSAILS_DEV_CWD';
/** Environment variable carrying the app config path into the serve child. */
export const DEV_CONFIG_ENV = 'JSAILS_DEV_CONFIG';

/** Vite config filenames probed for in the project root. */
const VITE_CONFIG_FILES = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
] as const;

/**
 * Grace period between the SIGTERM and the SIGKILL pass when tearing children
 * down. At least the app's default shutdown timeout so the serve child has time
 * to close its own transport cleanly.
 */
const SHUTDOWN_GRACE_MS = 5000;

/** Options for {@link runDev}. */
export interface DevOptions {
  /** App config module, resolved against `cwd`. Defaults to `jsails.app.js`. */
  readonly configPath?: string;
  /** Project root. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

/** A minimal child-process handle returned by {@link DevDeps.spawn}. */
export interface DevChild {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  on(event: 'exit' | 'error', listener: (...args: any[]) => void): void;
  once(event: 'exit' | 'error', listener: (...args: any[]) => void): void;
  removeListener(event: 'exit' | 'error', listener: (...args: any[]) => void): void;
}

/** Options accepted by {@link DevDeps.spawn}. */
export interface DevSpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly detached?: boolean;
  readonly stdio?: unknown;
}

/**
 * Dependency seam for {@link runDev}. Tests inject fakes so no real compiler,
 * Vite, or serve process is started; the defaults are the real factories.
 */
export interface DevDeps {
  /** Spawn a child process; defaults to `node:child_process.spawn`. */
  spawn(command: string, args: readonly string[], options?: DevSpawnOptions): DevChild;
  /** Terminate the owned process tree `pid` leads; defaults to the platform-aware kill. */
  killGroup(pid: number, signal: NodeJS.Signals): boolean;
  /** Install SIGINT/SIGTERM handlers that resolve on the first signal. */
  waitForShutdown(): ShutdownSignal;
  /** Resolve a project tool (`tsc`/`vite`) to its absolute JS entry, or `undefined`. */
  resolveTool(tool: 'tsc' | 'vite', cwd: string): string | undefined;
  /** Resolve the serve-child entry module. */
  resolveServeChild(): string;
  /** Start the recursive project watcher. */
  watchProject(
    rootDir: string,
    listeners: {
      readonly onChange: (change: ChangeClass) => void;
      readonly onError: (error: unknown) => void;
    },
  ): ProjectWatcher;
  /** Generate `.jsails/` build artifacts for `rootDir`; defaults to `runMetaCommand`. */
  runMeta(rootDir: string): Promise<number>;
  /** SIGTERM-to-SIGKILL grace, defaulting to {@link SHUTDOWN_GRACE_MS}. */
  readonly graceMs?: number;
}

/** One completed (or aborted) initial build step. */
type BuildOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'failed'; readonly code: number }
  | { readonly kind: 'aborted' };

const require = createRequire(import.meta.url);

/** The real `child_process.spawn` adapter, always detached with inherited stdio. */
function defaultSpawn(
  command: string,
  args: readonly string[],
  options: DevSpawnOptions = {},
): DevChild {
  const child = spawnProcess(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached ?? true,
    stdio: (options.stdio ?? 'inherit') as 'inherit',
    shell: false,
  });
  return adaptChild(child);
}

/** Present a `ChildProcess` through the minimal {@link DevChild} surface. */
function adaptChild(child: ChildProcess): DevChild {
  return {
    get pid() {
      return child.pid;
    },
    get exitCode() {
      return child.exitCode;
    },
    on(event, listener) {
      child.on(event, listener);
    },
    once(event, listener) {
      child.once(event, listener);
    },
    removeListener(event, listener) {
      child.removeListener(event, listener);
    },
  };
}

/** Terminate the owned process tree `pid` leads, swallowing a vanished group. */
function defaultKillGroup(pid: number, signal: NodeJS.Signals): boolean {
  return killOwnedProcessTree(pid, signal);
}

/** Read a package's `bin` map and return the requested entry, or `undefined`. */
function binEntry(bin: unknown, binName: string): string | undefined {
  if (typeof bin === 'string') return bin;
  if (bin !== null && typeof bin === 'object' && !Array.isArray(bin)) {
    const value = (bin as Record<string, unknown>)[binName];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** Resolve a project tool's bin from the project's own `node_modules`. */
function defaultResolveTool(tool: 'tsc' | 'vite', cwd: string): string | undefined {
  const packageName = tool === 'tsc' ? 'typescript' : 'vite';
  try {
    const pkgJsonPath = require.resolve(`${packageName}/package.json`, {
      paths: [cwd],
    });
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      bin?: unknown;
    };
    const entry = binEntry(pkg.bin, tool);
    return entry === undefined ? undefined : resolve(dirname(pkgJsonPath), entry);
  } catch {
    return undefined;
  }
}

/** Resolve the serve-child entry next to this module. */
function defaultResolveServeChild(): string {
  return join(import.meta.dirname, 'serve-child.js');
}

const defaultDevDeps: DevDeps = {
  spawn: defaultSpawn,
  killGroup: defaultKillGroup,
  waitForShutdown: waitForShutdownSignal,
  resolveTool: defaultResolveTool,
  resolveServeChild: defaultResolveServeChild,
  watchProject: (rootDir, listeners) => watchProject(rootDir, listeners),
  runMeta: (rootDir) => runMetaCommand({ dir: rootDir }),
};

/**
 * Run the development toolchain to completion. Resolves `0` on a clean
 * signal-initiated shutdown, or a non-zero exit code on failure. The caller
 * owns printing the result; this function prints its own actionable errors.
 */
export async function runDev(
  options: DevOptions = {},
  deps: Partial<DevDeps> = {},
): Promise<number> {
  const d: DevDeps = { ...defaultDevDeps, ...deps };

  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.configPath ?? DEFAULT_APP_CONFIG_PATH);

  const hasTsconfig = existsSync(join(cwd, 'tsconfig.json'));
  const hasViteConfig = VITE_CONFIG_FILES.some((name) => existsSync(join(cwd, name)));

  const tscBin = hasTsconfig ? d.resolveTool('tsc', cwd) : undefined;
  if (hasTsconfig && tscBin === undefined) {
    console.error(
      'jsails dev: tsconfig.json is present but TypeScript is not installed; run npm install',
    );
    return 1;
  }
  const viteBin = hasViteConfig ? d.resolveTool('vite', cwd) : undefined;
  if (hasViteConfig && viteBin === undefined) {
    console.error(
      'jsails dev: a Vite config is present but Vite is not installed; run npm install',
    );
    return 1;
  }

  const serveChild = d.resolveServeChild();
  const graceMs = d.graceMs ?? SHUTDOWN_GRACE_MS;
  const signal = d.waitForShutdown();
  const running = new Set<DevChild>();
  let autoImportWatcher: ReturnType<typeof watchScopedAutoImports> | undefined;
  let projectWatcher: ProjectWatcher | undefined;
  let serve: DevChild | undefined;
  let closing = false;
  let restarting = false;
  let restartQueued = false;
  let failServe: ((name: string) => void) | undefined;
  const serveFailure = new Promise<string>((resolveFailure) => {
    failServe = resolveFailure;
  });

  // The generation tells a browser whether the page it shows came from the
  // current build. It is written to a file because the serve child is replaced
  // on every restart and must read the value the parent last wrote.
  const generationPath = generationFilePath(cwd);
  let generation = 0;
  const bumpGeneration = (): void => {
    generation += 1;
    writeGeneration(generationPath, generation);
  };

  const startServe = (): DevChild => {
    const child = spawnTracked(d, running, process.execPath, [serveChild], {
      cwd,
      env: serveEnv(cwd, configPath, generationPath),
    });
    serve = child;
    const fail = (): void => {
      if (serve === child && !restarting && !closing) {
        failServe?.('serve');
      }
    };
    child.once('exit', fail);
    child.once('error', fail);
    return child;
  };

  const restartServe = async (): Promise<void> => {
    if (closing) {
      return;
    }
    if (restarting) {
      restartQueued = true;
      return;
    }
    restarting = true;
    try {
      if (serve !== undefined) {
        await stopChild(d, serve, graceMs);
      }
      if (!closing) {
        startServe();
      }
    } finally {
      restarting = false;
      if (restartQueued && !closing) {
        restartQueued = false;
        void restartServe();
      }
    }
  };

  try {
    // Generate `.jsails/` artifacts before `tsc` so the ambient declarations and
    // the model/component registries exist when the compiler runs. This is a
    // pure source scan (no app code executes), so it is safe to run in-process.
    const metaCode = await d.runMeta(cwd);
    if (metaCode !== 0) {
      console.error('jsails dev: build:meta failed');
      return metaCode;
    }

    const build = await buildInitial(d, running, { tscBin, viteBin }, cwd, signal);
    if (build.kind === 'aborted') {
      return 0;
    }
    if (build.kind === 'failed') {
      console.error('jsails dev: the initial build failed');
      return build.code;
    }

    const distDir = join(cwd, 'dist');
    if (existsSync(distDir)) {
      try {
        injectScopedAutoImportsInDirectory(distDir);
      } catch (error) {
        console.error(
          `jsails dev: auto-import failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        return 1;
      }
    }

    if (existsSync(distDir)) {
      autoImportWatcher = watchScopedAutoImports(distDir, {
        onError: (error) => {
          console.error(
            `jsails dev: auto-import failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        },
      });
    }

    const watchers: Array<{ name: string; child: DevChild }> = [];
    if (tscBin !== undefined) {
      watchers.push({
        name: 'tsc',
        child: spawnTracked(
          d,
          running,
          process.execPath,
          [tscBin, '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'],
          { cwd },
        ),
      });
    }
    if (viteBin !== undefined) {
      watchers.push({
        name: 'vite',
        child: spawnTracked(d, running, process.execPath, [viteBin, 'build', '--watch'], { cwd }),
      });
    }

    // Write the baseline before the first spawn so the child never starts at a
    // generation the parent has already moved past.
    writeGeneration(generationPath, generation);
    startServe();
    projectWatcher = d.watchProject(cwd, {
      onChange: (change) => {
        // A client-only change needs a browser reload but not a new process;
        // bumping the generation is enough, and it is deliberately not gated on
        // `restarting` so a reload is never swallowed by an in-flight restart.
        if (change === 'client-reload') {
          bumpGeneration();
          return;
        }
        bumpGeneration();
        void restartServe();
      },
      onError: (error) => {
        console.error(
          `jsails dev: file watcher failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        failServe?.('file watcher');
      },
    });

    console.log('Dev server ready. The browser reloads when the build changes.');

    const outcome = await Promise.race([
      signal.promise.then(() => 'signal' as const),
      unexpectedWatcherExit(watchers),
      serveFailure,
    ]);
    closing = true;

    if (outcome === 'signal') {
      return 0;
    }
    console.error(`jsails dev: the ${outcome} watcher exited unexpectedly`);
    return 1;
  } finally {
    closing = true;
    projectWatcher?.close();
    autoImportWatcher?.close();
    signal.dispose();
    await shutdownAll(d, running, graceMs);
  }
}

/** Stop one serve child, escalating to SIGKILL after the grace period. */
function stopChild(d: DevDeps, child: DevChild, graceMs: number): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveStop) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolveStop();
    };

    child.once('exit', finish);
    child.once('error', finish);
    if (child.pid === undefined) {
      finish();
      return;
    }
    d.killGroup(child.pid, 'SIGTERM');
    timer = setTimeout(() => {
      d.killGroup(child.pid as number, 'SIGKILL');
      finish();
    }, graceMs);
  });
}

/**
 * Run the one-shot initial build steps in order (tsc, then Vite), returning the
 * first non-ok outcome. An aborted step means a shutdown signal arrived while a
 * build was still running; the child stays in `running` so `shutdownAll` kills it.
 */
async function buildInitial(
  d: DevDeps,
  running: Set<DevChild>,
  tools: {
    readonly tscBin: string | undefined;
    readonly viteBin: string | undefined;
  },
  cwd: string,
  signal: ShutdownSignal,
): Promise<BuildOutcome> {
  if (tools.tscBin !== undefined) {
    const outcome = await buildOnce(
      d,
      running,
      process.execPath,
      [tools.tscBin, '-p', 'tsconfig.json'],
      cwd,
      signal,
    );
    if (outcome.kind !== 'ok') return outcome;
  }
  if (tools.viteBin !== undefined) {
    const outcome = await buildOnce(
      d,
      running,
      process.execPath,
      [tools.viteBin, 'build'],
      cwd,
      signal,
    );
    if (outcome.kind !== 'ok') return outcome;
  }
  return { kind: 'ok' };
}

/** Run one one-shot build step, resolving on exit, spawn error, or shutdown signal. */
function buildOnce(
  d: DevDeps,
  running: Set<DevChild>,
  command: string,
  args: string[],
  cwd: string,
  signal: ShutdownSignal,
): Promise<BuildOutcome> {
  const child = spawnTracked(d, running, command, args, { cwd });
  return new Promise<BuildOutcome>((resolveOutcome) => {
    let settled = false;
    const settle = (outcome: BuildOutcome): void => {
      if (settled) return;
      settled = true;
      resolveOutcome(outcome);
    };
    child.once('exit', (code: number | null) =>
      settle(code === 0 ? { kind: 'ok' } : { kind: 'failed', code: code ?? 1 }),
    );
    child.once('error', () => settle({ kind: 'failed', code: 1 }));
    void signal.promise.then(() => settle({ kind: 'aborted' }));
  });
}

/** Spawn a detached child and track it in `running` until it exits or errors. */
function spawnTracked(
  d: DevDeps,
  running: Set<DevChild>,
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): DevChild {
  const child = d.spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: 'inherit',
  });
  running.add(child);
  child.once('exit', () => running.delete(child));
  child.once('error', () => running.delete(child));
  return child;
}

/** Resolve with the name of the first watcher to exit or error unexpectedly. */
function unexpectedWatcherExit(
  watchers: ReadonlyArray<{ name: string; child: DevChild }>,
): Promise<string> {
  return new Promise<string>((resolveName) => {
    for (const { name, child } of watchers) {
      child.once('exit', () => resolveName(name));
      child.once('error', () => resolveName(name));
    }
  });
}

/** Environment passed to the serve child: project cwd, config path, generation file. */
function serveEnv(cwd: string, configPath: string, generationPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [DEV_CWD_ENV]: cwd,
    [DEV_CONFIG_ENV]: configPath,
    [DEV_GENERATION_ENV]: generationPath,
  };
}

/** SIGTERM every owned group, wait the grace period, then SIGKILL stragglers. */
async function shutdownAll(d: DevDeps, running: Set<DevChild>, graceMs: number): Promise<void> {
  for (const child of [...running]) {
    if (child.pid !== undefined) {
      d.killGroup(child.pid, 'SIGTERM');
    }
  }
  await waitForRunningEmpty(running, graceMs);
  for (const child of [...running]) {
    if (child.pid !== undefined) {
      d.killGroup(child.pid, 'SIGKILL');
    }
  }
}

/** Resolve when `running` is empty or the grace period elapses, whichever first. */
function waitForRunningEmpty(running: Set<DevChild>, timeoutMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    if (running.size === 0) {
      resolveWait();
      return;
    }
    const interval = setInterval(() => {
      if (running.size === 0) {
        clearInterval(interval);
        clearTimeout(timer);
        resolveWait();
      }
    }, 25);
    const timer = setTimeout(() => {
      clearInterval(interval);
      resolveWait();
    }, timeoutMs);
  });
}
