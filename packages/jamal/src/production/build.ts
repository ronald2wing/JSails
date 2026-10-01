/**
 * Local build and push for jamal production deploys.
 *
 * {@link runBuild} drives `docker buildx build -t <imageRef> <context>` and
 * {@link runPush} drives `docker push <imageRef>` — the two local steps of a
 * production deploy, both through an injected {@link ProcessRunner} so they run
 * on the same process seam as the remote ssh steps and never spawn a process in
 * tests. Both ask the runner to stream (`stream: true`): a build takes
 * minutes, and its log is the operator's only view of progress and of why it
 * failed. Each resolves with the raw {@link CommandResult} on success; a
 * non-zero exit is converted into a {@link BuildError} whose message names only
 * the operation and the exit code — the image reference and any docker output
 * are never echoed.
 *
 * {@link assertDockerfile} is the preflight a deploy runs before it touches
 * the server: without it, a project with no Dockerfile would take the deploy
 * lock and run the pre-build hooks before `docker buildx build` failed.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

import { JsailsError } from 'jsails/support';
import type { CommandResult, ProcessRunner } from './process-runner.js';

/** Build context directory when the caller has no explicit one. */
export const DEFAULT_BUILD_CONTEXT = '.';

/** Why a local build or push step failed. */
export type BuildErrorCode = 'missing_runner' | 'command_failed' | 'missing_dockerfile';

/** Raised when a build or push exits non-zero. Value-free: no image or output. */
export class BuildError extends JsailsError {
  constructor(
    readonly code: BuildErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The names `docker buildx build` reads from the context root when no `-f` is given. */
const DEFAULT_DOCKERFILE_NAMES = ['Dockerfile', 'dockerfile'] as const;

/**
 * Throw a value-free {@link BuildError} unless `contextDir` holds a Dockerfile
 * that `docker buildx build` would read by default.
 */
export function assertDockerfile(contextDir: string): void {
  const found = DEFAULT_DOCKERFILE_NAMES.some(
    (name) => statSync(join(contextDir, name), { throwIfNoEntry: false })?.isFile() === true,
  );
  if (!found) {
    throw new BuildError(
      'missing_dockerfile',
      'no Dockerfile was found in the project root; jamal deploy builds the production image ' +
        'from it with "docker buildx build", so add a Dockerfile before deploying',
    );
  }
}

/** Run `docker buildx build -t <imageRef> <context>`; context defaults to `.`. */
export function runBuild(
  imageRef: string,
  context: string,
  runner: ProcessRunner,
): Promise<CommandResult>;
export function runBuild(imageRef: string, runner: ProcessRunner): Promise<CommandResult>;
export async function runBuild(
  imageRef: string,
  contextOrRunner: string | ProcessRunner,
  maybeRunner?: ProcessRunner,
): Promise<CommandResult> {
  const context = typeof contextOrRunner === 'string' ? contextOrRunner : DEFAULT_BUILD_CONTEXT;
  const runner = typeof contextOrRunner === 'function' ? contextOrRunner : maybeRunner;
  if (runner === undefined) {
    throw new BuildError('missing_runner', 'runBuild requires a command runner');
  }
  return assertExitZero(
    await runner(['docker', 'buildx', 'build', '-t', imageRef, context], { stream: true }),
    'docker buildx build',
  );
}

/** Run `docker push <imageRef>` through the injected runner. */
export async function runPush(imageRef: string, runner: ProcessRunner): Promise<CommandResult> {
  return assertExitZero(
    await runner(['docker', 'push', imageRef], { stream: true }),
    'docker push',
  );
}

/** Resolve with the result, or reject a non-zero exit with a value-free error. */
function assertExitZero(result: CommandResult, operation: string): CommandResult {
  if (result.exitCode !== 0) {
    throw new BuildError('command_failed', `${operation} exited with code ${result.exitCode}`);
  }
  return result;
}
