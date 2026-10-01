/**
 * `jsails jamal ...`: forwards to the `jamal` bin of the project's own
 * `@jsails/jamal` install.
 *
 * Jamal is a dependency of the app, not of the framework, so core never
 * imports it: it resolves `@jsails/jamal/package.json` from the project
 * root, reads the package's `bin.jamal`, and runs that file with the current
 * Node binary, inheriting stdio, so the verbs behave exactly as `npx jamal`
 * would. Without the package the command prints the install line and exits 1.
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

import { JsailsError } from '../errors/jsails-error.js';
import { formatError } from '../errors/inspect.js';

/** The package that provides the `jamal` bin. */
export const JAMAL_PACKAGE = '@jsails/jamal';

/** Raised when the project's `@jsails/jamal` install is missing or unusable. Value-free. */
export class JamalForwardError extends JsailsError {
  constructor(
    readonly code: 'jamal_not_installed' | 'invalid_jamal_package',
    message: string,
    suggestion: string,
  ) {
    super(message, { suggestion });
  }
}

/**
 * The absolute path of the `jamal` bin installed for the project at
 * `projectRoot`. Throws {@link JamalForwardError} when the package is absent
 * or its manifest names no bin inside the package directory.
 */
export function resolveJamalBin(projectRoot: string): string {
  let manifestPath: string;
  try {
    manifestPath = createRequire(path.join(path.resolve(projectRoot), 'package.json')).resolve(
      `${JAMAL_PACKAGE}/package.json`,
    );
  } catch {
    throw new JamalForwardError(
      'jamal_not_installed',
      `${JAMAL_PACKAGE} is not installed in this project`,
      `Install it: npm install ${JAMAL_PACKAGE}`,
    );
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
    throw new JamalForwardError(
      'invalid_jamal_package',
      `the installed ${JAMAL_PACKAGE} package declares no jamal bin`,
      `Reinstall it: npm install ${JAMAL_PACKAGE}`,
    );
  }
  return binPath;
}

/** The collaborators of {@link forwardToJamal}; tests replace `run`. */
export interface JamalForwardDeps {
  /** The project root the package is resolved from and the bin runs in. */
  readonly cwd: string;
  stderr(text: string): void;
  /** Run `binPath` with `args` under Node in `cwd`; resolves the exit code. */
  run(binPath: string, args: readonly string[], cwd: string): Promise<number>;
}

/** Run `binPath` under the current Node binary with inherited stdio. */
export function runNodeBin(binPath: string, args: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { cwd, stdio: 'inherit' });
    const ignoreInterrupt = (): void => {
      // The terminal already delivered Ctrl-C to the child's process group.
    };
    const passTerminate = (): void => {
      child.kill('SIGTERM');
    };
    process.on('SIGINT', ignoreInterrupt);
    process.on('SIGTERM', passTerminate);
    const detachSignals = (): void => {
      process.removeListener('SIGINT', ignoreInterrupt);
      process.removeListener('SIGTERM', passTerminate);
    };
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

const defaultDeps: JamalForwardDeps = {
  get cwd() {
    return process.cwd();
  },
  stderr: (text) => process.stderr.write(`${text}\n`),
  run: runNodeBin,
};

/**
 * Forward `args` to the project's `jamal` bin and resolve its exit code, or
 * print why it cannot run and resolve 1.
 */
export async function forwardToJamal(
  args: readonly string[],
  deps: JamalForwardDeps = defaultDeps,
): Promise<number> {
  let binPath: string;
  try {
    binPath = resolveJamalBin(deps.cwd);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }
  try {
    return await deps.run(binPath, args, deps.cwd);
  } catch {
    // A spawn error names the executable path; the message stays value-free.
    deps.stderr('jsails: could not start jamal');
    return 1;
  }
}
