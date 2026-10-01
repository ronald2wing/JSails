#!/usr/bin/env node

/**
 * The `jamal` executable (`package.json` `bin`): resolves the project's
 * environment, then runs one jamal verb over the process arguments in the
 * working directory and exits with its code. `jsails jamal ...` forwards here
 * when the package is installed in the project.
 *
 * The environment comes from the kernel's resolver (`resolveEnvironment`), the
 * one the `jsails` CLI runs, with the name the verb defaults to
 * (`verb-scope.ts`) when `JSAILS_ENV` names none:
 *
 * - A local verb runs as `development`, as `jsails dev` would: `.env`,
 *   `.env.development`, the development credentials, then `.env.local`.
 *   Compose interpolates the managed file from it.
 * - A server verb runs as the deployed app, `production` unless `JSAILS_ENV`
 *   names another (`staging`). Such an environment reads no `.env` file at
 *   all, so a `$NAME` in the secrets files, or a value the config reads, is
 *   never a development one: only the real environment, a secrets file and
 *   that environment's sealed credentials. A sealed document without its key
 *   refuses the verb (`credentials.missing_key`). On Windows a server verb
 *   resolves nothing, since the command refuses it there.
 *
 * Every verb needs its secrets. A verb started under a JSails command that
 * already resolved another environment refuses
 * (`environment.inherited_mismatch`). The resolver consumes
 * `JSAILS_CREDENTIALS_KEY`, removing it from the environment; the key ring
 * that opened the document stays on the resolution, which the bin hands to
 * the command (`deploymentCredentials`), so `jamal deploy` can deliver it to
 * the app container while no child process, `$(...)` command included, ever
 * sees it.
 *
 * `jsails jamal ...` resolves nothing before it forwards here, so both entry
 * points give a verb the same environment. The values live only in this
 * process and its children.
 */

import {
  applyEnvironment,
  environmentFailureLines,
  renderCauseChain,
  resolveEnvironment,
  type ResolvedEnvironment,
} from 'jsails/internal';

import { defaultJamalDeps, invokedVerb, runJamalCommand } from './command.js';
import { deploymentCredentialsOf } from './credentials-delivery.js';
import { reportFailure } from './deps.js';
import { isLocalVerb, verbDefaultEnvironment } from './verb-scope.js';

const args = process.argv.slice(2);

const verb = invokedVerb(args);
const defaultName = verb === undefined ? undefined : verbDefaultEnvironment(verb);

/** A resolution that failed: the error, and the lines that report it. */
interface EnvironmentFailure {
  readonly error: unknown;
  readonly lines: readonly string[];
}

/** The resolution, `undefined` when the verb needs none, or its failure. */
function resolveVerbEnvironment(): ResolvedEnvironment | undefined | EnvironmentFailure {
  if (defaultName === undefined) return undefined;
  try {
    const resolved = resolveEnvironment({
      rootDir: process.cwd(),
      defaultName,
      secrets: 'required',
    });
    applyEnvironment(resolved);
    return resolved;
  } catch (error) {
    const lines = environmentFailureLines(error);
    if (lines === undefined) throw error;
    return { error, lines };
  }
}

const environment = resolveVerbEnvironment();

if (environment !== undefined && 'lines' in environment) {
  process.exitCode = 1;
  for (const line of environment.lines) {
    process.stderr.write(line.startsWith('  ') ? `${line}\n` : `jamal: ${line}\n`);
  }
  // An unreadable file keeps its errno error on `cause`, which tells EISDIR
  // from EACCES; the renderer prints it value-free.
  renderCauseChain(environment.error, { env: process.env }).then(
    (lines) => {
      for (const line of lines) process.stderr.write(`${line}\n`);
    },
    () => {
      // The renderer could not load: the lines above already name the failure.
    },
  );
} else {
  const resolved = environment;
  runJamalCommand(args, {
    ...defaultJamalDeps,
    // A server verb acts for the deployed app, whose key ring a deploy delivers.
    deploymentCredentials:
      resolved === undefined || verb === undefined || isLocalVerb(verb)
        ? undefined
        : deploymentCredentialsOf(resolved),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch(async (error: unknown) => {
      process.exitCode = 1;
      await reportFailure(defaultJamalDeps, error);
    });
}
