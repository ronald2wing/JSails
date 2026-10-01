/**
 * `jsails jamal ...`: forwards to the `jamal` bin of the project's own
 * `@jsails/jamal` install.
 *
 * Jamal is a dependency of the app, not of the framework, so core never
 * imports it: it resolves `@jsails/jamal/package.json` from the project
 * root, reads the package's `bin.jamal`, and runs that file with the current
 * Node binary, inheriting stdio, so the verbs behave exactly as `npx jamal`
 * would. Without the package the command prints the install line and exits 1.
 * {@link runJamal} is the same resolution and run without the printing, for a
 * caller such as `jsails test` that words its own single report from the
 * outcome.
 *
 * While the child runs, SIGTERM is passed on to it and SIGINT is ignored here:
 * a terminal delivers Ctrl-C to the whole process group, so the child already
 * has it, and a deploy must outlive this forwarder long enough to release its
 * server lock.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import path from 'node:path';

import type { JsailsError } from '../errors/jsails-error.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import type { CommandModule } from './descriptor.js';
import type { NO_OPTIONS } from './manifest.js';
import { writeFailure } from './report.js';
import { onProcessSignals } from './shutdown.js';

/** The package that provides the `jamal` bin. */
export const JAMAL_PACKAGE = '@jsails/jamal';

const JAMAL_FORWARD_ERRORS = {
  jamal_not_installed: {
    kind: 'unavailable',
    message: '@jsails/jamal is not installed in this project',
    suggestion: 'Install it: npm install @jsails/jamal',
  },
  invalid_jamal_package: {
    kind: 'internal',
    message: 'the installed @jsails/jamal package declares no jamal bin',
    suggestion: 'Reinstall it: npm install @jsails/jamal',
  },
  jamal_start_failed: {
    kind: 'internal',
    message: 'could not start jamal',
  },
} as const;

/**
 * `jsails jamal`'s codes, `jamal_forward.*`: the project's `@jsails/jamal`
 * install is missing or unusable, or its bin could not be started. A spawn
 * error names the executable path, so it stays on the `cause`.
 */
export const JamalForwardErrors: ErrorRegistry<'jamal_forward', typeof JAMAL_FORWARD_ERRORS> =
  defineErrors('jamal_forward', JAMAL_FORWARD_ERRORS);

/**
 * The absolute path of the `jamal` bin installed for the project at
 * `projectRoot`. Throws a `jamal_forward.*` error when the package is absent
 * or its manifest names no bin inside the package directory.
 */
export function resolveJamalBin(projectRoot: string): string {
  let manifestPath: string;
  try {
    manifestPath = createRequire(path.join(path.resolve(projectRoot), 'package.json')).resolve(
      `${JAMAL_PACKAGE}/package.json`,
    );
  } catch (error) {
    throw new JamalForwardErrors.Error('jamal_not_installed', {}, { cause: error });
  }
  const packageDir = path.dirname(manifestPath);
  let bin: unknown;
  try {
    bin = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: unknown }).bin;
  } catch {
    bin = undefined;
  }
  const relative =
    typeof bin === 'object' && bin !== null ? (bin as { jamal?: unknown }).jamal : undefined;
  const binPath = typeof relative === 'string' ? path.resolve(packageDir, relative) : undefined;
  const inside = binPath === undefined ? '' : path.relative(packageDir, binPath);
  if (
    binPath === undefined ||
    inside === '' ||
    inside === '..' ||
    inside.startsWith(`..${path.sep}`) ||
    path.isAbsolute(inside)
  ) {
    throw new JamalForwardErrors.Error('invalid_jamal_package');
  }
  return binPath;
}

/** The collaborators of {@link runJamal}; tests replace `run`. */
export interface JamalRunDeps {
  /** The project root the package is resolved from and the bin runs in. */
  readonly cwd: string;
  /** Run `binPath` with `args` under Node in `cwd`; resolves the exit code. */
  run(binPath: string, args: readonly string[], cwd: string): Promise<number>;
}

/** The collaborators of {@link forwardToJamal}. */
export interface JamalForwardDeps extends JamalRunDeps {
  stderr(text: string): void;
  /** The environment a failure report reads `JSAILS_DEBUG` from. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * What became of one attempt to run the project's `jamal` bin: it ran and
 * exited with `code` (having printed its own diagnostics), or it never ran.
 */
export type JamalRun =
  | { readonly kind: 'exited'; readonly code: number }
  | { readonly kind: 'not_run'; readonly error: JsailsError };

/** Run `binPath` under the current Node binary with inherited stdio. */
export function runNodeBin(binPath: string, args: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { cwd, stdio: 'inherit' });
    // The terminal already delivered Ctrl-C to the child's process group, so
    // only SIGTERM is passed on.
    const detachSignals = onProcessSignals(['SIGINT', 'SIGTERM'], (signal) => {
      if (signal === 'SIGTERM') child.kill('SIGTERM');
    });
    child.on('error', (error) => {
      detachSignals();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      detachSignals();
      if (code !== null) {
        resolve(code);
        return;
      }
      const number = signal === null ? undefined : osConstants.signals[signal];
      resolve(number === undefined ? 1 : 128 + number);
    });
  });
}

const defaultRunDeps: JamalRunDeps = {
  get cwd() {
    return process.cwd();
  },
  run: runNodeBin,
};

/**
 * Run the project's `jamal` bin with `args` and report the outcome without
 * printing anything itself. A resolution failure other than a
 * `jamal_forward.*` error is a bug and propagates.
 */
export async function runJamal(
  args: readonly string[],
  deps: JamalRunDeps = defaultRunDeps,
): Promise<JamalRun> {
  let binPath: string;
  try {
    binPath = resolveJamalBin(deps.cwd);
  } catch (error) {
    if (JamalForwardErrors.is(error)) return { kind: 'not_run', error };
    throw error;
  }
  try {
    return { kind: 'exited', code: await deps.run(binPath, args, deps.cwd) };
  } catch (error) {
    return {
      kind: 'not_run',
      error: new JamalForwardErrors.Error('jamal_start_failed', {}, { cause: error }),
    };
  }
}

/**
 * Forward `args` to the project's `jamal` bin and resolve its exit code, or
 * print why it cannot run and resolve 1.
 */
export async function forwardToJamal(
  args: readonly string[],
  deps: JamalForwardDeps,
): Promise<number> {
  const outcome = await runJamal(args, deps);
  if (outcome.kind === 'exited') return outcome.code;
  await writeFailure(outcome.error, (line) => deps.stderr(line), { env: deps.env });
  return 1;
}

/**
 * `jsails jamal <verb>`: every token goes to the project's jamal bin, which
 * decides each verb's environment (a server verb runs as the deployed app,
 * a local verb as development), so the dispatcher resolves none.
 */
export const jamalCommand: CommandModule<typeof NO_OPTIONS, 'nothing'> = {
  run: (context) =>
    forwardToJamal(context.positionals, {
      cwd: context.cwd,
      run: runNodeBin,
      stderr: (text) => context.stderr(text),
      env: context.env,
    }),
};
