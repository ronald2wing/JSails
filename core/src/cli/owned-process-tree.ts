/**
 * Owned child processes, shared by the dev runtime and the `create` install
 * step: how a Node tool shim is spawned on every platform, and how the process
 * tree a detached child leads is torn down.
 *
 * On Windows `npm` is a `.cmd` shim, which Node refuses to spawn without a
 * shell (CVE-2024-27980). {@link npmSpawn} therefore runs npm's own JavaScript
 * entry with this Node (`node <npm-cli.js> ...args`): no shell, arguments
 * passed verbatim. Only when no `npm-cli.js` can be found does it fall back to
 * `cmd.exe /d /s /c npm ...` with the caller's fixed arguments.
 * `scripts/subprocess.mjs` resolves npm the same way for the repo tooling.
 *
 * Every child these surfaces start is spawned detached, so it leads its own
 * process group/tree. Teardown must terminate that group — and only that group
 * — never the caller's session or unrelated processes.
 *
 * On POSIX a detached child leads a process group, so `process.kill(-pid,
 * signal)` signals the whole group and nothing else. On Windows `process.kill`
 * cannot target a tree, so the group is force-terminated with the well-known
 * `taskkill.exe /PID <pid> /T /F`. `taskkill.exe` is resolved from `SystemRoot`
 * (a Windows-provided environment variable), never the `PATH` and never a
 * shell, and its argv is fixed — no user input is interpolated into it. Windows
 * teardown is therefore a hard kill, not a graceful signal, and no
 * graceful-shutdown claim is made for it.
 *
 * An already-exited PID is never an error: POSIX swallows the `ESRCH` from a
 * vanished group, and `taskkill.exe` reports "not found" as a normal non-zero
 * exit rather than a spawn failure.
 */

import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/** Where {@link npmSpawn} looks for npm, injectable for tests. */
export interface NpmSpawnContext {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** The Node binary that runs `npm-cli.js`; defaults to `process.execPath`. */
  readonly execPath?: string;
  /** Whether a file exists; defaults to `fs.existsSync`. */
  readonly exists?: (path: string) => boolean;
}

/** A spawnable command: the program and its argument array. */
export interface SpawnCommand {
  readonly command: string;
  readonly args: string[];
}

/**
 * npm's JavaScript entry on Windows, or `undefined` when none exists: the one
 * npm exports to the scripts it runs (`npm_execpath`, which is `npx-cli.js`
 * under npx, beside `npm-cli.js`; another package manager's entry is ignored),
 * else the copy a standard Node install ships beside `node.exe`.
 */
function windowsNpmCli(
  env: NodeJS.ProcessEnv,
  execPath: string,
  exists: (path: string) => boolean,
): string | undefined {
  const candidates: string[] = [];
  const fromNpm = env.npm_execpath;
  if (fromNpm !== undefined && fromNpm !== '') {
    const name = win32.basename(fromNpm);
    if (name === 'npm-cli.js') candidates.push(fromNpm);
    else if (name === 'npx-cli.js')
      candidates.push(win32.join(win32.dirname(fromNpm), 'npm-cli.js'));
  }
  candidates.push(win32.join(win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  return candidates.find((candidate) => exists(candidate));
}

/**
 * The command that runs `npm ...args` on `context.platform` without a shell
 * that could re-split them: `npm` itself on POSIX, `node <npm-cli.js>` on
 * Windows. `args` must be fixed tokens chosen by the caller, never input: the
 * last-resort `cmd.exe` form joins them into one command line.
 */
export function npmSpawn(
  args: readonly string[],
  context: NpmSpawnContext = { platform: process.platform, env: process.env },
): SpawnCommand {
  if (context.platform !== 'win32') return { command: 'npm', args: [...args] };
  const execPath = context.execPath ?? process.execPath;
  const cli = windowsNpmCli(context.env, execPath, context.exists ?? existsSync);
  if (cli !== undefined) return { command: execPath, args: [cli, ...args] };
  return {
    command: windowsCmdPath(context.env),
    args: ['/d', '/s', '/c', ['npm', ...args].join(' ')],
  };
}

/**
 * `cmd.exe` on Windows, resolved from the canonical `ComSpec` environment
 * variable (never the `PATH`), falling back to a well-known `SystemRoot`
 * location when `ComSpec` is unset.
 */
function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  const comspec = env.ComSpec;
  if (comspec !== undefined && comspec.trim() !== '') return comspec;
  const root = (env.SystemRoot ?? '').trim() || 'C:\\Windows';
  return win32.join(root, 'System32', 'cmd.exe');
}

/** The minimal child surface the tree kill needs (for test injection). */
export interface TreeKillChild {
  once(event: 'error', listener: () => void): void;
}

/** Spawn options for the Windows `taskkill.exe` call. */
interface TreeKillSpawnOptions {
  readonly detached?: boolean;
  readonly stdio?: 'ignore';
  readonly shell: false;
}

/** The spawn surface the tree kill needs (for test injection). */
export interface TreeKillSpawn {
  (command: string, args: readonly string[], options: TreeKillSpawnOptions): TreeKillChild;
}

/** Dependencies for {@link killOwnedProcessTree}, injectable for tests. */
interface OwnedProcessTreeDeps {
  readonly platform: NodeJS.Platform;
  readonly spawn: TreeKillSpawn;
  /** Windows `SystemRoot`; falls back to a well-known default when unset. */
  readonly systemRoot?: string | undefined;
}

/** Spawn `taskkill.exe` with a fixed argv; never a shell, never the PATH. */
function defaultSpawn(
  command: string,
  args: readonly string[],
  options: TreeKillSpawnOptions,
): TreeKillChild {
  return spawnProcess(command, [...args], {
    detached: options.detached ?? true,
    stdio: options.stdio ?? 'ignore',
    shell: options.shell,
  });
}

const defaultDeps: OwnedProcessTreeDeps = {
  platform: process.platform,
  spawn: defaultSpawn,
  systemRoot: process.env.SystemRoot,
};

/** The `taskkill.exe` location on Windows, resolved from `SystemRoot`. */
function taskkillPath(systemRoot: string | undefined): string {
  const root = (systemRoot ?? '').trim() || 'C:\\Windows';
  return win32.join(root, 'System32', 'taskkill.exe');
}

/**
 * Best-effort terminate of the process tree led by `pid`, never throwing.
 * Returns `true` when a teardown was issued, `false` when the PID was already
 * gone.
 */
export function killOwnedProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  deps: OwnedProcessTreeDeps = defaultDeps,
): boolean {
  if (deps.platform === 'win32') {
    const child = deps.spawn(taskkillPath(deps.systemRoot), ['/PID', String(pid), '/T', '/F'], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    // A missing `taskkill.exe` must surface as an 'error' event, never an
    // unhandled rejection; the teardown itself is fire-and-forget.
    child.once('error', () => {});
    return true;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}
