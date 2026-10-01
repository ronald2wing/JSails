/**
 * The `db:push` and `db:diff` command modules. Core's built-in commands of
 * those names parse the shared flags and call these through a schema
 * config's command table (see `schema-config.ts`).
 *
 * - `db:diff` prints the plan: each operation with its classification, and
 *   for every blocking or destructive one the digest `db:push --approve`
 *   takes. `--json` prints the plan as JSON instead. Exit 0.
 * - `db:push` applies every safe operation and the approved ones, prints
 *   what it applied and what it deferred, and exits 0 when the schema is now
 *   the declared one and 3 when anything was deferred (2 is the CLI's usage
 *   error, 1 any other failure). `--approve-all` is
 *   accepted in development and test only. `--wait-lock <seconds>` bounds
 *   the wait for another push. `--json` prints the push report.
 *
 * The environment is `JSAILS_ENV`, as the CLI resolved it (`development`
 * when unset). Connection secrets come from the environment through the
 * config's `database` options; nothing printed carries a value.
 */

import { dirname, resolve } from 'node:path';

import { resolveDatabaseConfig, type DatabaseOptions } from '../engine/config.js';
import type { ModelTarget } from '../model/index.js';
import { diffSchema } from '../schema/diff-schema.js';
import { pushSchema, type PushReport } from '../schema/push-schema.js';
import { SchemaErrors } from '../schema/schema-errors.js';
import type { PlannedOperation, SchemaPlan } from '../schema/schema-plan.js';
import type { SchemaSource } from '../schema/schema-source.js';

/** Where a schema command reads its environment and writes its output. */
export interface SchemaCommandIo {
  /** The config module the command was loaded from; relative SQLite paths resolve beside it. */
  readonly configPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  stdout(line: string): void;
}

/** `db:push`'s flags. */
export interface DbPushCommandOptions {
  /** `--approve <digest>`, repeatable. */
  readonly approve: readonly string[];
  /** `--approve-all`. */
  readonly approveAll: boolean;
  /** `--wait-lock <seconds>`, as typed. */
  readonly waitLock?: string;
  /** `--json`. */
  readonly json: boolean;
}

/** `db:diff`'s flags. */
export interface DbDiffCommandOptions {
  /** `--json`. */
  readonly json: boolean;
}

/** The commands a schema config carries, by name. */
export interface SchemaCommandTable {
  readonly 'db:push': (options: DbPushCommandOptions, io: SchemaCommandIo) => Promise<number>;
  readonly 'db:diff': (options: DbDiffCommandOptions, io: SchemaCommandIo) => Promise<number>;
}

/** The parts of a schema config the commands read. */
export interface SchemaCommandConfig {
  readonly database: DatabaseOptions;
  readonly models: readonly ModelTarget[];
  readonly owner: string;
}

/** Exit status of a push that deferred work: distinct from a failure (1) and a usage error (2). */
export const DEFERRED_EXIT_CODE = 3;

const WAIT = /^\d{1,5}(\.\d{1,3})?$/;
const LABEL_WIDTH = 12;

function source(config: SchemaCommandConfig, io: SchemaCommandIo): SchemaSource {
  return {
    config: resolveDatabaseConfig(config.database, {
      env: io.env,
      root: dirname(resolve(io.configPath)),
    }),
    models: config.models,
  };
}

function environment(io: SchemaCommandIo): string {
  const name = io.env.JSAILS_ENV;
  return name === undefined || name === '' ? 'development' : name;
}

/** JSON for output: bigints as decimal strings, bytes as hex. */
function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, inner: unknown) => {
      if (typeof inner === 'bigint') return inner.toString();
      if (inner instanceof Uint8Array) return Buffer.from(inner).toString('hex');
      return inner;
    },
    2,
  );
}

function operationLine(op: PlannedOperation): string {
  const digest = op.classification === 'safe' ? '' : `${op.digest}  `;
  return `  ${op.classification.padEnd(LABEL_WIDTH)}${digest}${op.summary}`;
}

function approveHint(ops: readonly PlannedOperation[]): string | undefined {
  const digests = ops.filter((op) => op.classification !== 'safe').map((op) => op.digest);
  if (digests.length === 0) return undefined;
  return `Approve with: jsails db:push ${digests.map((digest) => `--approve ${digest}`).join(' ')}`;
}

function printPlan(plan: SchemaPlan, io: SchemaCommandIo): void {
  if (plan.operations.length === 0) {
    io.stdout(`The ${plan.dialect} schema of ${plan.owner} is up to date.`);
  } else {
    io.stdout(
      `Schema plan for ${plan.owner} on ${plan.dialect}: ${plan.operations.length} operation(s)`,
    );
    for (const op of plan.operations) io.stdout(operationLine(op));
    const hint = approveHint(plan.operations);
    if (hint !== undefined) io.stdout(hint);
  }
  if (plan.unmanaged.length > 0) {
    io.stdout(`Unmanaged tables (left alone): ${plan.unmanaged.join(', ')}`);
  }
}

function printPush(report: PushReport, io: SchemaCommandIo): void {
  if (report.applied.length > 0) {
    io.stdout(`Applied ${report.applied.length} operation(s):`);
    for (const op of report.applied) io.stdout(operationLine(op));
  }
  if (report.deferred.length > 0) {
    io.stdout(`Deferred ${report.deferred.length} operation(s):`);
    for (const op of report.deferred) {
      const why =
        op.reason === 'dependency' ? ' (waits for, or applies with, a deferred operation)' : '';
      io.stdout(`${operationLine(op)}${why}`);
    }
    // Approvals last one push: a blocking or destructive operation that was
    // approved but waited with its unit needs its digest again.
    const hint = approveHint(report.deferred);
    if (hint !== undefined) io.stdout(hint);
  }
  if (report.unmanaged.length > 0) {
    io.stdout(`Unmanaged tables (left alone): ${report.unmanaged.join(', ')}`);
  }
  io.stdout(
    report.complete
      ? `The ${report.dialect} schema of ${report.owner} is up to date.`
      : `The ${report.dialect} schema of ${report.owner} is not complete; deferred operations need approval.`,
  );
}

/** `jsails db:push` for a schema config. */
export async function runDbPush(
  config: SchemaCommandConfig,
  options: DbPushCommandOptions,
  io: SchemaCommandIo,
): Promise<number> {
  let waitLockSeconds: number | undefined;
  if (options.waitLock !== undefined) {
    if (!WAIT.test(options.waitLock)) {
      throw new SchemaErrors.Error('invalid_options', { field: 'wait-lock' });
    }
    waitLockSeconds = Number(options.waitLock);
  }
  const report = await pushSchema(source(config, io), {
    approve: options.approveAll ? 'all' : options.approve,
    environment: environment(io),
    owner: config.owner,
    ...(waitLockSeconds === undefined ? {} : { waitLockSeconds }),
  });
  if (options.json) io.stdout(json(report));
  else printPush(report, io);
  return report.complete ? 0 : DEFERRED_EXIT_CODE;
}

/** `jsails db:diff` for a schema config. */
export async function runDbDiff(
  config: SchemaCommandConfig,
  options: DbDiffCommandOptions,
  io: SchemaCommandIo,
): Promise<number> {
  const plan = await diffSchema(source(config, io), { owner: config.owner });
  if (options.json) io.stdout(json(plan));
  else printPlan(plan, io);
  return 0;
}
