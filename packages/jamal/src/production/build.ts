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
 * {@link assertDockerfile} and {@link readGitState} are the preflight a
 * deploy runs before it builds: without a Dockerfile `docker buildx build`
 * would fail after the image tag was chosen, and a tree with uncommitted
 * changes would be built under a commit it does not match. The release is
 * named after the commit (`release-id.ts`) and records whether the tree was
 * dirty (`--allow-dirty`), so what a release contains is always knowable.
 *
 * {@link captureDigest} reads the digest the registry gave the pushed image
 * from the local image's `RepoDigests` (`docker push` records it there), so
 * the server pulls and runs `repo@sha256:…`, never the tag, which another
 * push could move.
 */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

import { defineErrors, JsailsError, type ErrorRegistry } from 'jsails/errors';
import { isStringArray } from '../object-shape.js';
import { pinnedRepoDigest } from './image-ref.js';
import type { CommandResult, ProcessRunner } from './process-runner.js';

const RELEASE_SOURCE_ERRORS = {
  not_a_checkout: {
    kind: 'invalid',
    message:
      'the project is not a git checkout with a commit, which a release is built from and named after',
    suggestion: 'run jamal deploy from a git checkout with at least one commit',
  },
  dirty_tree: {
    kind: 'conflict',
    message:
      'the working tree has uncommitted changes, so the image would not match the commit it is named after',
    suggestion: 'commit or stash the changes, or pass --allow-dirty to deploy them as they are',
  },
  digest_unknown: {
    kind: 'unavailable',
    message: 'the registry digest of the pushed image could not be read from the local Docker',
    suggestion: 'check that "docker push" reached the registry named by config.image',
  },
} as const;

/**
 * `jamal_release_source.*`: the tree a release would be built from, or the
 * image it was pushed as, cannot name the release.
 */
export const ReleaseSourceErrors: ErrorRegistry<
  'jamal_release_source',
  typeof RELEASE_SOURCE_ERRORS
> = defineErrors('jamal_release_source', RELEASE_SOURCE_ERRORS);

/** The commit a tree is at, and whether it holds changes that commit does not. */
export interface GitState {
  /** The full hex object name of `HEAD`. */
  readonly sha: string;
  /** Whether a tracked file is modified or an untracked, unignored file exists. */
  readonly dirty: boolean;
}

/** A full SHA-1 or SHA-256 object name. */
const OBJECT_NAME = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Run git in `cwd` and collect its stdout; `undefined` when it fails or cannot start. */
function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => {
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined);
    });
  });
}

/**
 * The commit `cwd` is at and whether its tree is dirty. Throws
 * `jamal_release_source.not_a_checkout` outside a checkout or before the
 * first commit.
 */
export async function readGitState(cwd: string): Promise<GitState> {
  const head = (await git(cwd, ['rev-parse', '--verify', 'HEAD']))?.trim();
  if (head === undefined || !OBJECT_NAME.test(head)) {
    throw new ReleaseSourceErrors.Error('not_a_checkout');
  }
  const status = await git(cwd, ['status', '--porcelain', '--untracked-files=normal']);
  if (status === undefined) throw new ReleaseSourceErrors.Error('not_a_checkout');
  return { sha: head, dirty: status.trim() !== '' };
}

/**
 * The pinned reference (`<repository>@sha256:…`) the registry holds for the
 * pushed `imageRef`, read from the local image's `RepoDigests`. Throws
 * `jamal_release_source.digest_unknown` when the image has no digest for
 * `repository`, or several.
 */
export async function captureDigest(
  imageRef: string,
  repository: string,
  runner: ProcessRunner,
): Promise<string> {
  const result = await runner([
    'docker',
    'image',
    'inspect',
    '--format',
    '{{json .RepoDigests}}',
    imageRef,
  ]);
  let entries: unknown;
  try {
    entries = result.exitCode === 0 ? JSON.parse(result.stdout) : undefined;
  } catch {
    entries = undefined;
  }
  const pinned = isStringArray(entries) ? pinnedRepoDigest(entries, repository) : undefined;
  if (pinned === undefined) throw new ReleaseSourceErrors.Error('digest_unknown');
  return pinned;
}

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
        'from it with "docker buildx build", so add a Dockerfile before deploying: ' +
        '"npx jsails make:dockerfile" generates one for a JSails app',
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
