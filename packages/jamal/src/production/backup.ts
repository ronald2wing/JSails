/**
 * The remote half of `jamal backup` and `jamal restore`: the commands that
 * dump a production accessory inside its own container and load a dump back,
 * and how a dump file is recognized as one accessory kind or another.
 *
 * Every command is a fixed argv run over ssh; the dump and restore logic is a
 * constant `sh -c` script run with `docker exec` inside the accessory
 * container, so it reads its credentials from the container's own
 * environment (the env file the accessory was started with) and none of them
 * is ever in an argv, on the host or in the container:
 *
 * - MariaDB: `mariadb-dump --single-transaction --routines --triggers --events` of the
 *   container's `MARIADB_DATABASE` as `MARIADB_USER`, the password passed in
 *   `MYSQL_PWD`. The image gives root a random password that jamal never
 *   learns, so the app user, which owns the database, is the one that dumps
 *   and restores it. A restore drops and recreates that database, then loads
 *   the dump, so tables created after the backup do not survive it.
 * - PostgreSQL: `pg_dump --format=custom` of `POSTGRES_DB` as `POSTGRES_USER`
 *   over the container's local socket, which the image trusts. A restore
 *   loads into a fresh `jamal_restore` database in one transaction and only
 *   then swaps it for the live one (refusing new connections, ending open
 *   ones, renaming both in one transaction), so a dump that fails to load
 *   leaves the live database untouched.
 * - Valkey: `BGSAVE`, a wait until that save (not an earlier one) completed
 *   successfully, then `dump.rdb`. The accessory runs with `appendonly yes`,
 *   and Valkey then loads its append-only directory at start and ignores
 *   `dump.rdb`, so a restore stops the container, makes the dump the base of
 *   a fresh append-only directory (and `dump.rdb`) in a throwaway container
 *   on the data volume, and starts the accessory again, all in one host-side
 *   script that a dropped connection cannot cut short.
 *
 * A restore first stages the dump inside the container and checks its
 * SHA-256 there, so a dump that arrived truncated or altered is refused
 * before anything is replaced. Each script reports a known failure with its
 * own exit status ({@link BACKUP_EXIT}), which the executor maps to a
 * value-free {@link BackupError}.
 */

import { JsailsError } from 'jsails/errors';

import { SERVICE_CONVENTIONS, type AccessoryServiceType } from '../service-conventions.js';
import { remoteOpArgv } from './remote-op.js';

/** The accessory kinds jamal backs up: every production accessory. */
export type BackupKind = AccessoryServiceType;

/** Why a backup or restore was refused or failed. */
export type BackupErrorCode =
  | 'not_running'
  | 'no_credentials'
  | 'dump_failed'
  | 'empty_dump'
  | 'timed_out'
  | 'write_failed'
  | 'exists'
  | 'unknown_format'
  | 'kind_mismatch'
  | 'missing_checksum'
  | 'invalid_checksum'
  | 'checksum_mismatch'
  | 'unreadable'
  | 'confirmation_required'
  | 'upload_failed'
  | 'restore_failed'
  | 'restart_failed'
  | 'unreachable';

/** Raised for a refused or failed backup or restore. Value-free: no path, server, or output. */
export class BackupError extends JsailsError {
  constructor(
    readonly code: BackupErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly suggestion?: string },
  ) {
    super(message, options);
  }
}

/** The file extension of each kind's dump: plain SQL, a custom-format archive, an RDB file. */
export const BACKUP_EXTENSIONS: Readonly<Record<BackupKind, string>> = Object.freeze({
  mariadb: 'sql',
  postgres: 'dump',
  valkey: 'rdb',
});

/** The exit statuses the backup scripts reserve for the failures they recognize. */
export interface BackupExitStatuses {
  /** A wait (for a save, or for a running save to end) passed its bound. */
  readonly timedOut: number;
  /** Valkey reported a failed save. */
  readonly saveFailed: number;
  /** The container's environment lacks the database, user, or password. */
  readonly noCredentials: number;
  /** The staged dump's SHA-256 is not the one the restore verified locally. */
  readonly checksumMismatch: number;
  /** The restored PostgreSQL database could not be swapped in; the live one was kept. */
  readonly swapFailed: number;
  /** The container has no `sha256sum` to check the staged dump. */
  readonly noDigestTool: number;
}

/**
 * The statuses themselves: above the tools' own (MariaDB and PostgreSQL
 * clients exit 1 or 2, a shell 126 or 127) and below ssh's 255.
 */
export const BACKUP_EXIT: BackupExitStatuses = Object.freeze({
  timedOut: 70,
  saveFailed: 71,
  noCredentials: 72,
  checksumMismatch: 73,
  swapFailed: 74,
  noDigestTool: 75,
});

/** ssh's own exit status for a connection or authentication failure. */
export const SSH_FAILURE_EXIT = 255;

/** Where a restore stages the dump inside a database container (its writable layer). */
const DATABASE_STAGE_PATH = '/tmp/jamal-restore';

/**
 * Where a Valkey restore stages the dump: on the data volume, because the
 * container is stopped before the swap and only the volume is shared with the
 * throwaway container that performs it.
 */
const VALKEY_STAGE_NAME = '.jamal-restore.rdb';

/** The longest Valkey save wait, in one-second polls, before the dump gives up. */
const VALKEY_SAVE_POLLS = 3600;

const MARIADB_DUMP_SCRIPT = [
  `[ -n "$MARIADB_DATABASE" ] && [ -n "$MARIADB_USER" ] && [ -n "$MARIADB_PASSWORD" ] || exit ${BACKUP_EXIT.noCredentials}`,
  'export MYSQL_PWD="$MARIADB_PASSWORD"',
  'exec mariadb-dump --user="$MARIADB_USER" --single-transaction --routines --triggers --events --hex-blob -- "$MARIADB_DATABASE"',
].join('\n');

const POSTGRES_DUMP_SCRIPT = [
  'u=${POSTGRES_USER:-postgres}',
  'exec pg_dump --username="$u" --dbname="${POSTGRES_DB:-$u}" --format=custom',
].join('\n');

/**
 * `rdb_saves` counts the saves since start, so waiting for it to pass the
 * value read before `BGSAVE` waits for this save; a save already running
 * makes `BGSAVE` fail, and the loop retries until it has ended, because that
 * save's data predates the request. `SCHEDULE` defers the save past a running
 * append-only rewrite instead of failing.
 */
const VALKEY_DUMP_SCRIPT = [
  `info() { valkey-cli INFO persistence | tr -d '\\r' | sed -n "s/^$1://p"; }`,
  'before=$(info rdb_saves)',
  `case $before in ''|*[!0-9]*) exit ${BACKUP_EXIT.saveFailed} ;; esac`,
  'i=0',
  "until reply=$(valkey-cli BGSAVE SCHEDULE) && case $reply in 'Background saving'*) true ;; *) false ;; esac; do",
  `  i=$((i + 1)); [ "$i" -lt ${VALKEY_SAVE_POLLS} ] || exit ${BACKUP_EXIT.timedOut}; sleep 1`,
  'done',
  'until [ "$(info rdb_bgsave_in_progress)" = 0 ] && [ "$(info rdb_saves)" -gt "$before" ]; do',
  `  i=$((i + 1)); [ "$i" -lt ${VALKEY_SAVE_POLLS} ] || exit ${BACKUP_EXIT.timedOut}; sleep 1`,
  'done',
  `[ "$(info rdb_last_bgsave_status)" = ok ] || exit ${BACKUP_EXIT.saveFailed}`,
  `exec cat ${SERVICE_CONVENTIONS.valkey.dataDir}/dump.rdb`,
].join('\n');

const DUMP_SCRIPTS: Readonly<Record<BackupKind, string>> = Object.freeze({
  mariadb: MARIADB_DUMP_SCRIPT,
  postgres: POSTGRES_DUMP_SCRIPT,
  valkey: VALKEY_DUMP_SCRIPT,
});

/**
 * Write stdin to `$1` and keep it only when its SHA-256 is `$2`: a dropped
 * connection ends stdin early without failing `cat`, and a truncated dump
 * must never reach the apply step.
 */
const STAGE_SCRIPT = [
  'umask 077',
  'cat > "$1" || { rm -f -- "$1"; exit 1; }',
  `command -v sha256sum >/dev/null 2>&1 || { rm -f -- "$1"; exit ${BACKUP_EXIT.noDigestTool}; }`,
  'd=$(sha256sum < "$1")',
  `[ "\${d%% *}" = "$2" ] || { rm -f -- "$1"; exit ${BACKUP_EXIT.checksumMismatch}; }`,
].join('\n');

/**
 * Drop and recreate the container's database, then load the staged dump into
 * it. The identifier is backquoted with embedded backquotes doubled, inside a
 * single-quoted `printf` format so the shell never reads the backquotes. The
 * dump loads with `--sandbox`, so a file that carries client commands
 * (`\! <shell command>`, `source`) cannot run them in the container: a
 * restore executes SQL as the app user and nothing more.
 */
const MARIADB_APPLY_SCRIPT = [
  `trap 'rm -f -- "$1"' EXIT`,
  `[ -n "$MARIADB_DATABASE" ] && [ -n "$MARIADB_USER" ] && [ -n "$MARIADB_PASSWORD" ] || exit ${BACKUP_EXIT.noCredentials}`,
  'export MYSQL_PWD="$MARIADB_PASSWORD"',
  "q=$(printf '%s' \"$MARIADB_DATABASE\" | sed 's/`/``/g')",
  'printf \'DROP DATABASE IF EXISTS `%s`;\\nCREATE DATABASE `%s`;\\n\' "$q" "$q" | mariadb --user="$MARIADB_USER" || exit 1',
  'mariadb --user="$MARIADB_USER" --sandbox -- "$MARIADB_DATABASE" < "$1"',
].join('\n');

/**
 * Restore into `jamal_restore`, then swap it in. psql quotes the names it
 * reads from variables (`:"db"`), so no name is ever spliced into SQL. If the
 * swap fails, its transaction rolled back the renames, and the recovery
 * re-allows connections to the live database it had closed.
 */
const POSTGRES_APPLY_SCRIPT = [
  `trap 'rm -f -- "$1"' EXIT`,
  'export PGOPTIONS=--client-min-messages=warning',
  'u=${POSTGRES_USER:-postgres}',
  'db=${POSTGRES_DB:-$u}',
  'sql() { psql -X -q -v ON_ERROR_STOP=1 --username="$u" --dbname=template1 -v db="$db" -v u="$u"; }',
  "sql <<'SQL' || exit 1",
  'DROP DATABASE IF EXISTS jamal_restore WITH (FORCE);',
  'DROP DATABASE IF EXISTS jamal_replaced WITH (FORCE);',
  'CREATE DATABASE jamal_restore TEMPLATE template0 OWNER :"u";',
  'SQL',
  'pg_restore --username="$u" --dbname=jamal_restore --no-owner --exit-on-error --single-transaction "$1" || {',
  "  sql <<'SQL'",
  'DROP DATABASE IF EXISTS jamal_restore WITH (FORCE);',
  'SQL',
  '  exit 1',
  '}',
  "sql <<'SQL' || {",
  'ALTER DATABASE :"db" WITH ALLOW_CONNECTIONS false;',
  "SELECT count(pg_terminate_backend(pid, 10000)) FROM pg_stat_activity WHERE datname = :'db' AND pid <> pg_backend_pid() \\g /dev/null",
  'BEGIN;',
  'ALTER DATABASE :"db" RENAME TO jamal_replaced;',
  'ALTER DATABASE jamal_restore RENAME TO :"db";',
  'COMMIT;',
  'SQL',
  "  sql <<'SQL'",
  'ALTER DATABASE :"db" WITH ALLOW_CONNECTIONS true;',
  'DROP DATABASE IF EXISTS jamal_restore WITH (FORCE);',
  'SQL',
  `  exit ${BACKUP_EXIT.swapFailed}`,
  '}',
  "sql <<'SQL'",
  'DROP DATABASE IF EXISTS jamal_replaced WITH (FORCE);',
  'SQL',
].join('\n');

/**
 * Run in a throwaway container on the stopped accessory's data volume: build
 * a fresh multi-part append-only directory whose base is the dump (the
 * manifest names one base and one empty incremental file) beside the old one,
 * then switch with renames only, and make the dump `dump.rdb` too, so turning
 * `appendonly` off later cannot resurrect pre-restore data. The preparation
 * hard-links the staged file instead of copying it (Valkey replaces both
 * files by rename and never writes into them), so a full volume fails the
 * preparation and leaves the old data in place. If moving the new directory
 * in fails, the old one is moved back. The image's entrypoint hands the files
 * to the `valkey` user when the accessory starts.
 */
const VALKEY_SWAP_SCRIPT = [
  'set -e',
  'umask 077',
  `cd ${SERVICE_CONVENTIONS.valkey.dataDir}`,
  'rm -rf .jamal-aof .jamal-aof-old',
  'mkdir .jamal-aof',
  `ln ${VALKEY_STAGE_NAME} .jamal-aof/appendonly.aof.1.base.rdb`,
  ': > .jamal-aof/appendonly.aof.1.incr.aof',
  "printf 'file appendonly.aof.1.base.rdb seq 1 type b\\nfile appendonly.aof.1.incr.aof seq 1 type i\\n' > .jamal-aof/appendonly.aof.manifest",
  'if [ -e appendonlydir ]; then mv appendonlydir .jamal-aof-old; fi',
  'mv .jamal-aof appendonlydir || { if [ -e .jamal-aof-old ]; then mv .jamal-aof-old appendonlydir; fi; exit 1; }',
  `mv -f ${VALKEY_STAGE_NAME} dump.rdb`,
  'rm -rf .jamal-aof-old',
].join('\n');

/** The argv (after `ssh <server>`) that prints `true` when `container` is running. */
export function runningArgv(container: string): readonly string[] {
  return ['docker', 'container', 'inspect', '--format', '{{.State.Running}}', container];
}

/** The argv that writes one accessory's dump to stdout, run inside its container. */
export function dumpArgv(kind: BackupKind, container: string): readonly string[] {
  return ['docker', 'exec', container, 'sh', '-c', DUMP_SCRIPTS[kind]];
}

/** Where a restore stages the dump inside `kind`'s container. */
export function stagePath(kind: BackupKind): string {
  return kind === 'valkey'
    ? `${SERVICE_CONVENTIONS.valkey.dataDir}/${VALKEY_STAGE_NAME}`
    : DATABASE_STAGE_PATH;
}

/**
 * The argv that writes stdin to the staging path inside the container and
 * keeps it only when its SHA-256 is `sha256`. The digest is of the dump, not
 * of a credential, so it may sit in the argv.
 */
export function stageArgv(kind: BackupKind, container: string, sha256: string): readonly string[] {
  return [
    'docker',
    'exec',
    '-i',
    container,
    'sh',
    '-c',
    STAGE_SCRIPT,
    'sh',
    stagePath(kind),
    sha256,
  ];
}

/** The argv that removes a staged dump a failed restore left in the container. */
export function discardStageArgv(kind: BackupKind, container: string): readonly string[] {
  return ['docker', 'exec', container, 'rm', '-f', '--', stagePath(kind)];
}

/** The argv that loads the staged dump into a database accessory, replacing its database. */
export function applyDatabaseArgv(
  kind: Exclude<BackupKind, 'valkey'>,
  container: string,
): readonly string[] {
  const script = kind === 'mariadb' ? MARIADB_APPLY_SCRIPT : POSTGRES_APPLY_SCRIPT;
  return ['docker', 'exec', container, 'sh', '-c', script, 'sh', DATABASE_STAGE_PATH];
}

/** The argvs of a Valkey restore after staging: the host-side replacement, then the probe. */
export interface ValkeyRestoreArgv {
  /**
   * Stop, swap on the volume, start: one remote command, the `valkey.replace`
   * op of `remote-op.ts` (exit statuses `BACKUP_EXIT_VALKEY`).
   */
  readonly replace: readonly string[];
  /** The health probe polled after the start. */
  readonly ping: readonly string[];
}

/** The argvs that replace a Valkey accessory's data with the staged dump. */
export function valkeyRestoreArgv(container: string): ValkeyRestoreArgv {
  const convention = SERVICE_CONVENTIONS.valkey;
  return {
    replace: remoteOpArgv({
      kind: 'valkey.replace',
      container,
      mount: `${convention.volume}:${convention.dataDir}`,
      image: convention.image,
      swap: VALKEY_SWAP_SCRIPT,
    }),
    // REDISCLI_AUTH, when a password is set, is in the container's own env file.
    ping: ['docker', 'exec', container, 'valkey-cli', 'ping'],
  };
}

/** The leading bytes that identify a MariaDB/MySQL dump: its sandbox line or banner comment. */
const SQL_DUMP_HEADS: readonly string[] = [
  '/*M!999999\\- enable the sandbox mode */',
  '-- MariaDB dump',
  '-- MySQL dump',
];

/** How many leading bytes {@link detectBackupKind} needs. */
export const BACKUP_HEAD_BYTES = 64;

/**
 * The kind of dump `head` (a file's first bytes) starts, or undefined for a
 * file that is none of them. Judged by content, not by file name, so a
 * renamed file cannot pass for another kind.
 */
export function detectBackupKind(head: Buffer): BackupKind | undefined {
  const text = head.toString('latin1');
  if (text.startsWith('PGDMP')) return 'postgres';
  // Valkey writes the RDB magic it inherited; a later format may name itself.
  if (text.startsWith('REDIS') || text.startsWith('VALKEY')) return 'valkey';
  if (SQL_DUMP_HEADS.some((prefix) => text.startsWith(prefix))) return 'mariadb';
  return undefined;
}

/**
 * The file name of a new backup: `<app>-<accessory>-<UTC timestamp>.<ext>`,
 * the timestamp in ISO 8601 basic form (`20261121T164012Z`), which sorts by
 * time and has no character a file system rejects.
 */
export function backupFileName(
  app: string,
  accessory: string,
  kind: BackupKind,
  date: Date,
): string {
  const stamp = date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll(/[-:]/g, '');
  return `${app}-${accessory}-${stamp}.${BACKUP_EXTENSIONS[kind]}`;
}
