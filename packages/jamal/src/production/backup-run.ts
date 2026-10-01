/**
 * Execution of `jamal backup` and `jamal restore` against the production
 * server.
 *
 * Both hold the app's deploy lock ({@link withDeployLock}) for their whole
 * run and send every command through its fenced runner, so a deploy or
 * rollback cannot replace containers under a dump, two restores cannot
 * interleave, and a run whose lock was force-released stops at its next
 * command. Both refuse an accessory whose container is
 * not running. {@link runBackup} streams the dump command's stdout straight
 * into the local backup file ({@link openBackupSink}); {@link runRestore}
 * streams an already verified file into the container's staging path, where
 * its digest is checked again, and only then replaces the accessory's data
 * (`backup.ts` describes the per-kind sequences). The dump tools' own error
 * output goes to the logger's `warn` for the operator; every error raised is a
 * value-free {@link BackupError}.
 */

import { createReadStream, rmSync } from 'node:fs';

import { Async } from 'jsails/support';

import { ACCESSORY_HEALTH_MAX_ATTEMPTS, ACCESSORY_HEALTH_RETRY_DELAY_MS } from './accessories.js';
import {
  BACKUP_EXIT,
  BackupError,
  SSH_FAILURE_EXIT,
  applyDatabaseArgv,
  backupFileName,
  discardStageArgv,
  dumpArgv,
  runningArgv,
  stageArgv,
  valkeyRestoreArgv,
  type BackupKind,
} from './backup.js';
import { openBackupSink, type BackupSink, type BackupWritten } from './backup-file.js';
import { defaultLockOwner, withDeployLock, type DeployLockOptions } from './execute.js';
import { ProcessRunnerError, type CommandResult } from './process-runner.js';
import { BACKUP_EXIT_VALKEY } from './remote-op.js';
import type { LockOwner } from './lock.js';
import type { ReleaseLogger } from './release.js';
import type { RemoteRunner } from './transport.js';

/** What every backup and restore run needs: the target, the accessory, and the seams. */
interface AccessoryRunOptions {
  readonly remoteRunner: RemoteRunner;
  readonly server: string;
  /** `config.service` and the destination: whose deploy lock is held. */
  readonly service: string;
  readonly destination: string | undefined;
  /** The accessory's container name (its `config.services` key). */
  readonly accessory: string;
  readonly kind: BackupKind;
  /** Progress on `info`, the dump tools' own error output on `warn`. */
  readonly logger: ReleaseLogger;
  /** Who takes the lock; defaults to the local user, for `<verb> <accessory>`. */
  readonly lockOwner?: LockOwner;
  /** Interrupt seams for the held lock (tests); default to `process`. */
  readonly signals?: DeployLockOptions['signals'];
  readonly onInterrupted?: DeployLockOptions['onInterrupted'];
}

/** Options for {@link runBackup}. */
export interface BackupRunOptions extends AccessoryRunOptions {
  /** The directory the backup is written to. */
  readonly dir: string;
  /** The app part of the file name: the service, with its destination when set. */
  readonly app: string;
  /** The backup's timestamp; defaults to now. */
  readonly now?: Date;
}

/** Options for {@link runRestore}. */
export interface RestoreRunOptions extends AccessoryRunOptions {
  /** The backup file, already checked by `verifyBackupFile`. */
  readonly file: string;
  /** The digest that check computed; the staged copy must match it. */
  readonly sha256: string;
  /** Delay seam for the Valkey restart probe; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The lock options shared by both runs. */
function lockOptions(
  options: AccessoryRunOptions,
  verb: 'backup' | 'restore',
  onInterrupt?: () => void,
): DeployLockOptions {
  return {
    remoteRunner: options.remoteRunner,
    server: options.server,
    service: options.service,
    destination: options.destination,
    owner: options.lockOwner ?? defaultLockOwner(`${verb} ${options.accessory}`),
    logger: options.logger,
    ...(options.signals === undefined ? {} : { signals: options.signals }),
    ...(options.onInterrupted === undefined ? {} : { onInterrupted: options.onInterrupted }),
    ...(onInterrupt === undefined ? {} : { onInterrupt }),
  };
}

/** Raise the error for an ssh-level failure, when `result` is one. */
function assertReachable(result: CommandResult): void {
  if (result.exitCode === SSH_FAILURE_EXIT) {
    throw new BackupError('unreachable', 'the server could not be reached over ssh');
  }
}

/** Forward a failed command's own error output to the operator. */
function forwardStderr(options: AccessoryRunOptions, result: CommandResult): void {
  const text = result.stderr.trim();
  if (text !== '') options.logger.warn(text);
}

/** Refuse an accessory whose container does not exist or is not running. */
async function assertRunning(options: AccessoryRunOptions): Promise<void> {
  const result = await options.remoteRunner.run(options.server, runningArgv(options.accessory));
  assertReachable(result);
  if (result.exitCode !== 0 || result.stdout.trim() !== 'true') {
    throw new BackupError('not_running', 'the accessory container is not running', {
      suggestion: 'Start it with "jamal accessory boot <name>"',
    });
  }
}

/** Map a dump command's non-zero exit to its error. */
function dumpFailure(options: AccessoryRunOptions, result: CommandResult): BackupError {
  assertReachable(result);
  forwardStderr(options, result);
  switch (result.exitCode) {
    case BACKUP_EXIT.noCredentials:
      return new BackupError(
        'no_credentials',
        'the accessory container has no database, user, or password in its environment',
        {
          suggestion:
            'Declare DATABASE_NAME, DATABASE_USER, and DATABASE_PASSWORD in config.env and recreate the accessory',
        },
      );
    case BACKUP_EXIT.timedOut:
      return new BackupError('timed_out', 'the accessory did not finish its save in time');
    case BACKUP_EXIT.saveFailed:
      return new BackupError('dump_failed', 'the accessory reported a failed save');
    default:
      return new BackupError('dump_failed', `the dump exited with code ${result.exitCode}`);
  }
}

/**
 * Dump one accessory into a new file under `options.dir`, holding the deploy
 * lock. Resolves with the published file; on any failure the partial file is
 * removed and nothing is published.
 */
export async function runBackup(input: BackupRunOptions): Promise<BackupWritten> {
  const fileName = backupFileName(input.app, input.accessory, input.kind, input.now ?? new Date());
  let sink: BackupSink | undefined;
  const removePartial = (): void => {
    if (sink !== undefined) rmSync(sink.partialPath, { force: true });
  };
  return withDeployLock(lockOptions(input, 'backup', removePartial), async (lock) => {
    const options: BackupRunOptions = { ...input, remoteRunner: lock.remote };
    await assertRunning(options);
    sink = await openBackupSink(options.dir, fileName);
    try {
      options.logger.info(`Dumping the ${options.kind} accessory ${options.accessory}.`);
      let result: CommandResult;
      try {
        result = await options.remoteRunner.run(
          options.server,
          dumpArgv(options.kind, options.accessory),
          {
            stdoutTo: sink.stream,
            timeoutMs: null,
          },
        );
      } catch (error) {
        if (error instanceof ProcessRunnerError && error.code === 'output_failed') {
          throw new BackupError('write_failed', 'the backup file could not be written', {
            cause: error,
          });
        }
        throw error;
      }
      if (result.exitCode !== 0) {
        throw dumpFailure(options, result);
      }
      return await sink.commit(options.kind);
    } catch (error) {
      await sink.discard();
      throw error;
    }
  });
}

/** Map a staging failure to its error. */
function stageFailure(options: AccessoryRunOptions, result: CommandResult): BackupError {
  assertReachable(result);
  forwardStderr(options, result);
  if (result.exitCode === BACKUP_EXIT.checksumMismatch) {
    return new BackupError(
      'upload_failed',
      'the dump arrived on the server incomplete or altered; nothing was replaced',
    );
  }
  if (result.exitCode === BACKUP_EXIT.noDigestTool) {
    return new BackupError(
      'upload_failed',
      'the accessory container has no sha256sum to check the dump; nothing was replaced',
    );
  }
  return new BackupError(
    'upload_failed',
    `sending the dump to the server exited with code ${result.exitCode}; nothing was replaced`,
  );
}

/** Stream the verified file into the container's staging path, checked there. */
async function stage(options: RestoreRunOptions): Promise<void> {
  const source = createReadStream(options.file);
  try {
    let result: CommandResult;
    try {
      result = await options.remoteRunner.run(
        options.server,
        stageArgv(options.kind, options.accessory, options.sha256),
        { stdinFrom: source, timeoutMs: null },
      );
    } catch (error) {
      if (error instanceof ProcessRunnerError && error.code === 'input_failed') {
        throw new BackupError('unreadable', 'the backup file could not be read', { cause: error });
      }
      throw error;
    }
    if (result.exitCode !== 0) {
      throw stageFailure(options, result);
    }
  } finally {
    source.destroy();
  }
}

/** Remove a staged dump after a failure, best effort: the failure itself is what is reported. */
async function discardStage(options: RestoreRunOptions): Promise<void> {
  try {
    await options.remoteRunner.run(
      options.server,
      discardStageArgv(options.kind, options.accessory),
    );
  } catch {
    // A leftover staged file is never loaded as data, and the next restore
    // overwrites it.
  }
}

/** Load the staged dump into a MariaDB or PostgreSQL accessory. */
async function applyDatabase(
  options: RestoreRunOptions,
  kind: Exclude<BackupKind, 'valkey'>,
): Promise<void> {
  options.logger.info(`Replacing the ${kind} database of ${options.accessory}.`);
  const result = await options.remoteRunner.run(
    options.server,
    applyDatabaseArgv(kind, options.accessory),
    {
      timeoutMs: null,
    },
  );
  if (result.exitCode === 0) return;
  assertReachable(result);
  forwardStderr(options, result);
  if (result.exitCode === BACKUP_EXIT.noCredentials) {
    throw new BackupError(
      'no_credentials',
      'the accessory container has no database, user, or password in its environment',
    );
  }
  if (result.exitCode === BACKUP_EXIT.swapFailed) {
    throw new BackupError(
      'restore_failed',
      'the restored database could not be swapped in; the live database was kept',
    );
  }
  throw new BackupError(
    'restore_failed',
    kind === 'postgres'
      ? `the restore exited with code ${result.exitCode}; the live database was kept`
      : `the restore exited with code ${result.exitCode}; the database may be partly restored`,
    kind === 'postgres'
      ? {}
      : {
          suggestion:
            'Run the restore again once the cause is fixed; it starts from an empty database',
        },
  );
}

/**
 * Replace a Valkey accessory's data with the staged dump: stop it (its own
 * shutdown save then lands before the swap, not after), swap the files on the
 * volume, and start it, in one host-side command, then wait until it answers.
 * A failed swap still starts the accessory, on its previous data, before
 * reporting.
 */
async function applyValkey(options: RestoreRunOptions): Promise<void> {
  const argv = valkeyRestoreArgv(options.accessory);
  options.logger.info(`Stopping, replacing the data of, and starting ${options.accessory}.`);
  const result = await options.remoteRunner.run(options.server, argv.replace, {
    timeoutMs: null,
  });
  if (result.exitCode !== 0) {
    assertReachable(result);
    forwardStderr(options, result);
    throw valkeyFailure(result.exitCode);
  }
  const sleep = options.sleep ?? Async.sleep;
  for (let attempt = 1; attempt <= ACCESSORY_HEALTH_MAX_ATTEMPTS; attempt += 1) {
    const probe = await options.remoteRunner.run(options.server, argv.ping);
    if (probe.exitCode === 0) return;
    if (attempt < ACCESSORY_HEALTH_MAX_ATTEMPTS) await sleep(ACCESSORY_HEALTH_RETRY_DELAY_MS);
  }
  throw new BackupError(
    'restart_failed',
    'the data was replaced, but the accessory did not answer after starting',
    { suggestion: 'See "jamal accessory logs <name>"' },
  );
}

/** Map a failed Valkey replacement's exit status to its error. */
function valkeyFailure(exitCode: number): BackupError {
  const start = { suggestion: 'Start it with "jamal accessory start <name>"' };
  switch (exitCode) {
    case BACKUP_EXIT_VALKEY.stopFailed:
      return new BackupError(
        'restore_failed',
        'the accessory could not be stopped; nothing was replaced',
      );
    case BACKUP_EXIT_VALKEY.swapFailed:
      return new BackupError(
        'restore_failed',
        'the data could not be replaced; the accessory was started on its previous data',
      );
    case BACKUP_EXIT_VALKEY.startFailed:
      return new BackupError(
        'restart_failed',
        'the data was replaced, but the accessory could not be started',
        start,
      );
    case BACKUP_EXIT_VALKEY.nothingStarted:
      return new BackupError(
        'restart_failed',
        'the data could not be replaced, and the accessory could not be started',
        start,
      );
    default:
      return new BackupError('restore_failed', `replacing the data exited with code ${exitCode}`, {
        suggestion: 'Check the accessory with "jamal accessory details <name>"',
      });
  }
}

/**
 * Replace one accessory's data with a verified backup file, holding the
 * deploy lock. The file is staged and checked in the container before
 * anything is replaced; a staging failure leaves the accessory untouched.
 */
export async function runRestore(input: RestoreRunOptions): Promise<void> {
  await withDeployLock(lockOptions(input, 'restore'), async (lock) => {
    const options: RestoreRunOptions = { ...input, remoteRunner: lock.remote };
    await assertRunning(options);

    options.logger.info(`Sending the dump to the ${options.kind} accessory ${options.accessory}.`);
    await stage(options);
    const kind = options.kind;
    try {
      if (kind === 'valkey') {
        await applyValkey(options);
      } else {
        await applyDatabase(options, kind);
      }
    } catch (error) {
      await discardStage(options);
      throw error;
    }
  });
}
