/**
 * Jamal deploy-lock verbs: `jamal lock status|release`.
 *
 * A deploy holds a lock directory on the server for its whole run and
 * releases it when it ends, fails, or is interrupted. A deploy whose process
 * died outright (a crash, `kill -9`, a lost machine) cannot release it, and
 * every later deploy then stops with "the deploy lock is already held".
 * `status` shows whether the lock is held and the owner line the holder
 * recorded (user, machine, start time); `release` removes it. Both require
 * `config.production` and honour `config.production.ssh`; `--dry-run` prints
 * the ssh command instead.
 */

import { parseArgs } from 'node:util';

import { formatError } from '../errors/inspect.js';
import {
  loadProductionConfigOrReport,
  printRemoteDryRun,
  remoteRunnerFor,
  type JamalDeps,
} from './deps.js';
import { usageFailure } from './plan-command.js';
import { deployLockDir } from './production/execute.js';
import {
  forceReleaseLock,
  lockReleaseArgv,
  lockStatus,
  lockStatusArgv,
} from './production/lock.js';
import { LOCK_USAGE } from './usage.js';

const LOCK_OPTIONS = {
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/**
 * Run `jamal lock` over the tokens after `lock`. Resolves to 0 on success
 * (including "not held" and a dry run), 2 for a usage error, and 1 for a
 * config or remote failure.
 */
export async function runLockCommand(deps: JamalDeps, args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: LOCK_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageFailure(deps, formatError(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    deps.stdout(LOCK_USAGE);
    return 0;
  }
  const verb = positionals[0];
  if (verb !== 'status' && verb !== 'release') {
    return usageFailure(deps, 'a verb is required (status | release)');
  }
  if (positionals.length > 1) {
    return usageFailure(deps, `unexpected argument: ${positionals.slice(1).join(' ')}`);
  }

  const config = await loadProductionConfigOrReport(deps, 'lock');
  if (config === undefined) {
    return 1;
  }
  const target = config.production!;
  const lockDir = deployLockDir(config.service);

  if (values['dry-run']) {
    printRemoteDryRun(
      deps,
      target.server,
      verb === 'status' ? lockStatusArgv(lockDir) : lockReleaseArgv(lockDir),
    );
    return 0;
  }

  const remote = remoteRunnerFor(deps, target);
  try {
    if (verb === 'status') {
      const status = await lockStatus(remote, { server: target.server, lockDir });
      if (!status.held) {
        deps.stdout('the deploy lock is not held');
      } else {
        deps.stdout(
          status.owner === undefined
            ? 'the deploy lock is held'
            : `the deploy lock is held by ${status.owner}`,
        );
      }
      return 0;
    }
    await forceReleaseLock(remote, { server: target.server, lockDir });
    deps.stdout('the deploy lock is released');
    return 0;
  } catch (error) {
    deps.stderr(`jsails: lock ${verb} failed: ${formatError(error)}`);
    return 1;
  }
}
