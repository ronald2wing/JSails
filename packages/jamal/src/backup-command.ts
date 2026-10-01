/**
 * Jamal's accessory backup verbs: `jamal backup <accessory> [--out <dir>]`
 * and `jamal restore <accessory> <file> [--yes]`.
 *
 * `backup` dumps one production accessory (MariaDB, PostgreSQL, or Valkey)
 * into `<app>-<accessory>-<UTC timestamp>.<ext>` under `.jamal/backups` (or
 * `--out`), with a `.sha256` sidecar. `restore` checks a file against its
 * sidecar and refuses a dump of another kind before it asks anything, then
 * requires `--yes` or the accessory's name typed at the terminal, because it
 * replaces all of the accessory's data. Both require `config.production`,
 * honour `config.production.ssh`, hold the deploy lock, and refuse on
 * Windows (`platform.ts`). The credentials stay in the accessory container:
 * neither verb loads the secrets files.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { resolveAccessoryName } from './accessory.js';
import type { JamalConfig } from './config/index.js';
import {
  loadProductionConfigOrReport,
  remoteRunnerFor,
  reportFailure,
  type JamalDeps,
} from './deps.js';
import { BackupError, type BackupKind } from './production/backup.js';
import { verifyBackupFile } from './production/backup-file.js';
import { runBackup, runRestore } from './production/backup-run.js';
import type { ReleaseLogger } from './production/release.js';
import { formatError } from './thrown-value.js';
import { usageFailure } from './usage-failure.js';
import { BACKUP_USAGE, RESTORE_USAGE } from './usage.js';

/** Where `jamal backup` writes when `--out` is not given, relative to the project root. */
export const DEFAULT_BACKUP_DIR = '.jamal/backups';

const BACKUP_OPTIONS = {
  out: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const RESTORE_OPTIONS = {
  yes: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/** A logger that forwards progress to stdout and the dump tools' errors to stderr. */
function logger(deps: JamalDeps): ReleaseLogger {
  return {
    info: (message) => deps.stdout(message),
    warn: (message) => deps.stderr(message),
  };
}

/** A path as the operator should read it: relative to the project when inside it. */
function displayPath(deps: JamalDeps, path: string): string {
  const inside = relative(deps.cwd, path);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path;
}

/** The accessory named on the command line and its kind, or a usage failure's exit code. */
function accessoryOrUsage(deps: JamalDeps, config: JamalConfig, name: string): BackupKind | number {
  try {
    return resolveAccessoryName(config, name);
  } catch (error) {
    return usageFailure(deps, formatError(error));
  }
}

/** The app part of a backup's file name: the service, with its destination when set. */
function appStem(config: JamalConfig): string {
  const destination = config.production?.destination;
  return destination === undefined ? config.service : `${config.service}-${destination}`;
}

/**
 * Run `jamal backup` over the tokens after `backup`. Resolves to 0 when the
 * backup was written, 2 for a usage error, and 1 for a config or remote
 * failure.
 */
export async function runBackupCommand(deps: JamalDeps, args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options: BACKUP_OPTIONS, allowPositionals: true });
  } catch (error) {
    return usageFailure(deps, formatError(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    deps.stdout(BACKUP_USAGE);
    return 0;
  }
  const name = positionals[0];
  if (name === undefined) {
    return usageFailure(deps, '"jamal backup" requires an accessory name');
  }
  if (positionals.length > 1) {
    return usageFailure(deps, `unexpected argument: ${positionals.slice(1).join(' ')}`);
  }
  if (values.out === '') {
    return usageFailure(deps, '--out must name a directory');
  }

  const config = await loadProductionConfigOrReport(deps, 'backup');
  if (config === undefined) return 1;
  const kind = accessoryOrUsage(deps, config, name);
  if (typeof kind === 'number') return kind;
  const target = config.production!;

  try {
    const written = await runBackup({
      remoteRunner: remoteRunnerFor(deps, target),
      server: target.server,
      service: config.service,
      destination: target.destination,
      accessory: name,
      kind,
      logger: logger(deps),
      dir: resolve(deps.cwd, values.out ?? DEFAULT_BACKUP_DIR),
      app: appStem(config),
    });
    deps.stdout(
      `Wrote ${displayPath(deps, written.path)} (${written.bytes} bytes, sha256 ${written.sha256}).`,
    );
    return 0;
  } catch (error) {
    await reportFailure(deps, error, 'backup failed');
    return 1;
  }
}

/**
 * Whether the operator confirmed replacing `name`'s data: `--yes`, or the
 * name typed back at the terminal. Throws `confirmation_required` when no
 * terminal can ask.
 */
async function confirmed(
  deps: JamalDeps,
  name: string,
  kind: BackupKind,
  yes: boolean,
): Promise<boolean> {
  if (yes) return true;
  const answer = await deps.prompt?.(
    `This replaces all data of the ${kind} accessory "${name}" on the server.\n` +
      `Type the accessory name to continue: `,
  );
  if (answer === undefined) {
    throw new BackupError(
      'confirmation_required',
      "a restore replaces the accessory's data and needs confirmation",
      { suggestion: 'Pass --yes, or run it at a terminal and type the accessory name' },
    );
  }
  return answer.trim() === name;
}

/**
 * Run `jamal restore` over the tokens after `restore`. Resolves to 0 when the
 * accessory was restored, 2 for a usage error, and 1 for a refused file, a
 * declined confirmation, or a config or remote failure.
 */
export async function runRestoreCommand(deps: JamalDeps, args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options: RESTORE_OPTIONS, allowPositionals: true });
  } catch (error) {
    return usageFailure(deps, formatError(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    deps.stdout(RESTORE_USAGE);
    return 0;
  }
  const [name, file] = positionals;
  if (name === undefined || file === undefined) {
    return usageFailure(deps, '"jamal restore" requires an accessory name and a backup file');
  }
  if (positionals.length > 2) {
    return usageFailure(deps, `unexpected argument: ${positionals.slice(2).join(' ')}`);
  }

  const config = await loadProductionConfigOrReport(deps, 'restore');
  if (config === undefined) return 1;
  const kind = accessoryOrUsage(deps, config, name);
  if (typeof kind === 'number') return kind;
  const target = config.production!;
  const path = resolve(deps.cwd, file);

  try {
    const verified = await verifyBackupFile(path);
    if (verified.kind !== kind) {
      throw new BackupError(
        'kind_mismatch',
        `the backup file is a ${verified.kind} dump, and the accessory is ${kind}`,
      );
    }
    if (!(await confirmed(deps, name, kind, values.yes))) {
      deps.stderr('jamal: restore cancelled: the accessory name was not typed back');
      return 1;
    }
    await runRestore({
      remoteRunner: remoteRunnerFor(deps, target),
      server: target.server,
      service: config.service,
      destination: target.destination,

      accessory: name,
      kind,
      logger: logger(deps),
      file: path,
      sha256: verified.sha256,
    });
    deps.stdout(`Restored the ${kind} accessory ${name} from ${displayPath(deps, path)}.`);
    return 0;
  } catch (error) {
    await reportFailure(deps, error, 'restore failed');
    return 1;
  }
}
