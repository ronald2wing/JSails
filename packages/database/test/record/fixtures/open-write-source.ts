/**
 * A data source for the write suites on a database of its own for the run's
 * driver, with the options a write can need beyond the models: a seal
 * provider for encrypted columns and the attachment options. Also a test
 * seal whose envelope is recognisable in raw column bytes, in-memory
 * attachment options whose disk records deletions (and fails the ones it is
 * told to) and whose reporter records cleanup failures, a change-feed
 * recorder, and statement recorders.
 */

import type { DatabaseOptions, SqlValue } from '../../../src/engine/index.js';
import { createQueryLedger, withQueryLedger } from '../../../src/engine/index.js';
import type { ChangeRecord } from '../../../src/change/index.js';
import type { SealProvider } from '../../../src/codec/index.js';
import type { ModelTarget } from '../../../src/model/index.js';
import {
  JsailsDataSource,
  type AttachmentDisk,
  type AttachmentOptions,
} from '../../../src/record/index.js';
import { pushSchema } from '../../../src/schema/index.js';
import { lastInFirstOut, type MatrixLifecycle } from '../../../src/testing/index.js';
import { matrixEngineConfig } from '../../conformance/engine/fixtures/matrix-engine.js';

/** The bytes every test-sealed value starts with. */
export const SEAL_PREFIX = 'sealed:';

/** A reversible seal whose envelope is `sealed:<stored form>`. */
export const TEST_SEAL: SealProvider = () => ({
  queryable: 'none',
  encode: (value: SqlValue) => new TextEncoder().encode(`${SEAL_PREFIX}${String(value)}`),
  decode: (value: Uint8Array) => new TextDecoder().decode(value).slice(SEAL_PREFIX.length),
});

/** Whether a raw column value is a test-seal envelope. */
export function isSealed(raw: unknown): boolean {
  if (!(raw instanceof Uint8Array)) return false;
  return new TextDecoder().decode(raw).startsWith(SEAL_PREFIX);
}

/** An attachment disk that only records the keys deleted from it. */
export interface MemoryDisk extends AttachmentDisk {
  readonly deleted: string[];
  /** Keys whose next delete fails (once each) instead of being recorded. */
  readonly failing: Set<string>;
}

function memoryDisk(): MemoryDisk {
  const deleted: string[] = [];
  const failing = new Set<string>();
  return {
    deleted,
    failing,
    delete: (key: string) => {
      if (failing.delete(key)) return Promise.reject(new Error('disk unavailable'));
      deleted.push(key);
      return Promise.resolve();
    },
  };
}

/** Attachment options on a memory disk, recording what the cleanup reporter receives. */
export interface MemoryAttachments extends AttachmentOptions {
  readonly disk: MemoryDisk;
  readonly cleanupErrors: unknown[];
}

export function memoryAttachments(): MemoryAttachments {
  const cleanupErrors: unknown[] = [];
  return {
    disk: memoryDisk(),
    cleanupErrors,
    onCleanupError: (error) => cleanupErrors.push(error),
  };
}

export interface WriteSourceOptions {
  readonly database?: DatabaseOptions;
  readonly seal?: SealProvider;
  readonly attachments?: AttachmentOptions;
}

export async function openWriteSource(
  lifecycle: MatrixLifecycle,
  models: readonly ModelTarget[],
  options: WriteSourceOptions = {},
): Promise<JsailsDataSource> {
  const ordered = lastInFirstOut(lifecycle);
  const config = await matrixEngineConfig(ordered, options.database ?? {});
  await pushSchema({ config, models }, { environment: 'development' });
  const dataSource = new JsailsDataSource({
    config,
    models,
    ...(options.seal === undefined ? {} : { seal: options.seal }),
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
  });
  ordered.after(() => dataSource.close());
  return dataSource;
}

/** The change records a data source delivers, batch by batch. */
export interface ChangeRecorder {
  readonly batches: (readonly ChangeRecord[])[];
  readonly errors: unknown[];
  /** Every record delivered since the last `take`, and forget them. */
  take(): readonly ChangeRecord[];
  stop(): void;
}

/** Subscribe to `dataSource.changes` for `models` (every model of the data source by default). */
export function recordChanges(
  dataSource: JsailsDataSource,
  models: readonly ModelTarget[] = dataSource.models,
): ChangeRecorder {
  const batches: (readonly ChangeRecord[])[] = [];
  const errors: unknown[] = [];
  const scope = new Set(models);
  const stop = dataSource.changes.subscribe((records) => batches.push(records), {
    models: () => scope,
    onError: (error) => errors.push(error),
  });
  return {
    batches,
    errors,
    take: () => batches.splice(0).flat(),
    stop,
  };
}

/** The ledger origin of the engine's own transaction control (`COMMIT`, savepoints). */
const ENGINE_ORIGIN = 'engine';

/**
 * The SQL of every data statement `body` runs: the statement budgets count
 * what the write sends, not the transaction control around it, which
 * `transactionControlOf` reports.
 */
export async function statementsOf(body: () => Promise<unknown>): Promise<string[]> {
  const ledger = createQueryLedger({ detail: true });
  await withQueryLedger(ledger, body);
  return ledger.records
    .filter((record) => record.origin !== ENGINE_ORIGIN)
    .map((record) => record.sql);
}

/** The transaction control statements `body` runs. */
export async function transactionControlOf(body: () => Promise<unknown>): Promise<string[]> {
  const ledger = createQueryLedger({ detail: true });
  await withQueryLedger(ledger, body);
  return ledger.records
    .filter((record) => record.origin === ENGINE_ORIGIN)
    .map((record) => record.sql);
}

/** A record's shape for comparisons: `op collection key`. */
export function describeRecord(record: ChangeRecord): string {
  const key =
    record.key === undefined
      ? ''
      : ` ${typeof record.key === 'object' && !(record.key instanceof Uint8Array) ? JSON.stringify(record.key) : String(record.key)}`;
  const tenant = record.tenant === undefined ? '' : ` @${String(record.tenant)}`;
  return `${record.op} ${record.collection}${key}${tenant}`;
}
