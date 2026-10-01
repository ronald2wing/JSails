/**
 * What `config:export` and `config:import` share: the sync directory a run
 * uses, and the value-free report of a failed run. Both commands run over the
 * services the `config` plugin provides, so the sets, store and overrides are
 * exactly the app's.
 */

import { resolve } from 'node:path';

import type { CommandInvocation } from 'jsails/kernel';

import { ConfigError } from '../config-error.js';

/** The `--dir` option both commands take. */
export const DIR_OPTION: {
  readonly type: 'string';
  readonly value: string;
  readonly summary: string;
} = Object.freeze({
  type: 'string',
  value: '<path>',
  summary: "The sync directory (default: the config plugin's syncDir)",
} as const);

/** The directory a run uses: `--dir` against the working directory, else the plugin's. */
export function syncDirOf(
  context: Pick<CommandInvocation, 'cwd'>,
  flag: string | undefined,
  configured: string,
): string {
  return flag === undefined ? configured : resolve(context.cwd, flag);
}

/**
 * Run `body`; a {@link ConfigError} is reported with its message (value-free
 * by construction) and the set and key it names, anything else as a fixed
 * line. Resolves with the exit code.
 */
export async function reportConfigFailure(
  context: Pick<CommandInvocation, 'stderr'>,
  body: () => Promise<number>,
): Promise<number> {
  try {
    return await body();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const where =
      error.set === undefined
        ? ''
        : ` (${error.set}${error.key === undefined ? '' : `.${error.key}`})`;
    context.stderr(`jsails: ${error.message}${where}`);
    return 1;
  }
}
