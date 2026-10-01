/**
 * `jsails make:dockerfile`: write the production `Dockerfile` and
 * `.dockerignore` that `jamal deploy` builds, rendered by
 * `app/dockerfile.ts` (the generator the server-rendered starters use too).
 *
 * ```sh
 * jsails make:dockerfile                    # Dockerfile + .dockerignore here
 * jsails make:dockerfile --dir ../my-app    # into another project
 * jsails make:dockerfile --health-path /healthz
 * jsails make:dockerfile --force            # replace both files
 * ```
 *
 * An existing file stops the command before either file is written, unless
 * `--force` is given, which replaces both: a partial pair from an earlier
 * generation is never left beside a fresh one. An existing directory of either
 * name stops it even with `--force`.
 * The output depends only on the flags, never on the clock or the machine, so
 * re-running it reproduces the same bytes. The command reads the project's
 * `package.json` only to warn about what the image build will need (a
 * committed `package-lock.json` and a `build` script); it never imports app
 * code.
 */

import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { renderAppDockerfile, renderAppDockerignore } from '../../app/dockerfile.js';
import { resolveHealthPath } from '../../app/config/paths.js';
import { isErrno } from '../../errors/inspect.js';
import type { CommandModule } from '../descriptor.js';
import type { MAKE_DOCKERFILE_OPTIONS } from '../manifest.js';
import { usageError } from '../usage-error.js';

/**
 * The files the command writes, relative to the project directory, in write
 * order. The `.dockerignore` comes first because it is what keeps `.env*`,
 * `.jamal/`, and credential keys out of the build context, and the
 * Dockerfile's `COPY . .` would carry them into the image without it: a failed
 * run may leave an ignore file without a Dockerfile, never the reverse.
 */
export const DOCKERFILE_OUTPUTS: readonly ['.dockerignore', 'Dockerfile'] = Object.freeze([
  '.dockerignore',
  'Dockerfile',
] as const);

type DockerfileOutput = (typeof DOCKERFILE_OUTPUTS)[number];

/** Options for {@link runMakeDockerfileCommand}, as parsed from its flags. */
export interface MakeDockerfileOptions {
  /** The project directory; defaults to the working directory. */
  readonly dir?: string;
  /** Replace existing files instead of refusing. */
  readonly force?: boolean;
  /** The app's health path; defaults to `/up`. */
  readonly healthPath?: string;
  /** Omit the image `HEALTHCHECK` (an app with `healthPath: false`). */
  readonly noHealthcheck?: boolean;
}

const HELP_HINT = 'Run "jsails make:dockerfile --help" for usage.';

function usageFailure(message: string): number {
  return usageError((line) => console.error(line), HELP_HINT, `make:dockerfile: ${message}`);
}

/** Whether `path` is an existing directory. */
function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * Whether `path` exists at all: a directory named `Dockerfile` counts, and so
 * does a symbolic link, dangling or not, since it is an entry the command
 * would replace.
 */
function exists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

/**
 * What the image build will stop on, as warnings: `npm ci` needs a lockfile,
 * and the build stage runs `npm run build`. A missing or unreadable
 * `package.json` is reported once instead.
 */
function projectWarnings(projectDir: string): string[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
  } catch {
    // Unreadable and malformed manifests read the same here: the image build
    // needs a valid one, and the warning says so without echoing its content.
    return ['no readable package.json in the project directory; the image build installs from it'];
  }
  const warnings: string[] = [];
  if (!exists(join(projectDir, 'package-lock.json'))) {
    warnings.push(
      'no package-lock.json; the image build runs "npm ci", so run "npm install" and commit the lockfile',
    );
  }
  const scripts =
    typeof manifest === 'object' && manifest !== null
      ? (manifest as { scripts?: unknown }).scripts
      : undefined;
  const build =
    typeof scripts === 'object' && scripts !== null
      ? (scripts as Record<string, unknown>).build
      : undefined;
  if (typeof build !== 'string' || build.length === 0) {
    warnings.push(
      'package.json has no "build" script; the image build runs "npm run build" to compile the app',
    );
  }
  return warnings;
}

/**
 * Write one output. Without `force` the file is created exclusively, which
 * closes the gap between the existence check and the write: a file that
 * appeared meanwhile is never replaced. With `force` the content is staged in
 * a sibling and renamed over the entry, so a symbolic link named `Dockerfile`
 * is replaced itself instead of having its target (anywhere on the machine)
 * overwritten, and an interrupted run never leaves a truncated file.
 */
async function writeOutput(path: string, content: string, force: boolean): Promise<void> {
  if (!force) {
    await writeFile(path, content, { flag: 'wx' });
    return;
  }
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, content, { flag: 'wx' });
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

/** Write the production `Dockerfile` and `.dockerignore`; returns the exit code. */
export async function runMakeDockerfileCommand(options: MakeDockerfileOptions): Promise<number> {
  if (options.noHealthcheck === true && options.healthPath !== undefined) {
    return usageFailure('--health-path and --no-healthcheck cannot be combined');
  }
  let healthPath: string | false | undefined;
  if (options.noHealthcheck === true) {
    healthPath = false;
  } else if (options.healthPath !== undefined) {
    try {
      healthPath = resolveHealthPath(options.healthPath);
    } catch {
      // The app config's own rule, reworded for the flag; the value is not echoed.
      return usageFailure(
        '--health-path must be an absolute path without a trailing slash, outside /_jsails',
      );
    }
  }

  const projectDir = resolve(options.dir ?? '.');
  if (!isDirectory(projectDir)) {
    console.error('jsails make:dockerfile: the project directory does not exist');
    return 1;
  }

  const force = options.force === true;
  const existing = DOCKERFILE_OUTPUTS.filter((name) => exists(join(projectDir, name)));
  if (existing.length > 0 && !force) {
    console.error(
      `jsails make:dockerfile: refusing to overwrite ${existing.join(' and ')}; pass --force to replace ${existing.length === 1 ? 'it' : 'them'}`,
    );
    return 1;
  }
  const directory = existing.find((name) => isDirectory(join(projectDir, name)));
  if (directory !== undefined) {
    console.error(`jsails make:dockerfile: ${directory} is a directory`);
    return 1;
  }

  const contents: Readonly<Record<DockerfileOutput, string>> = {
    '.dockerignore': renderAppDockerignore(),
    Dockerfile: renderAppDockerfile(healthPath === undefined ? {} : { healthPath }),
  };
  const created: string[] = [];
  for (const name of DOCKERFILE_OUTPUTS) {
    const path = join(projectDir, name);
    try {
      await writeOutput(path, contents[name], force);
    } catch (error) {
      // A file this run created is removed again, so a failed run never
      // leaves half of a fresh pair behind.
      for (const done of created) await rm(done, { force: true });
      if (isErrno(error, 'EEXIST')) {
        console.error(`jsails make:dockerfile: refusing to overwrite ${name}`);
        return 1;
      }
      throw error;
    }
    if (!existing.includes(name)) created.push(path);
  }
  for (const name of DOCKERFILE_OUTPUTS) {
    console.log(`${existing.includes(name) ? 'Replaced' : 'Created'} ${name}`);
  }
  for (const warning of projectWarnings(projectDir)) {
    console.error(`jsails make:dockerfile: warning: ${warning}`);
  }
  return 0;
}

/** `jsails make:dockerfile`. */
export const makeDockerfileCommand: CommandModule<typeof MAKE_DOCKERFILE_OPTIONS, 'nothing'> = {
  run: (context) => {
    const { values } = context;
    return runMakeDockerfileCommand({
      ...(values.dir === undefined ? {} : { dir: values.dir }),
      force: values.force === true,
      ...(values['health-path'] === undefined ? {} : { healthPath: values['health-path'] }),
      noHealthcheck: values['no-healthcheck'] === true,
    });
  },
};
