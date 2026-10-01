/**
 * Database-backed failed-job history.
 *
 * {@link createDatabaseFailedJobHistory} stores each finally failed job as one
 * `jsails_failed_job` row through the injected TypeORM `DataSource`'s
 * repository: no raw SQL and no runtime DDL. The table must already exist (an
 * app adds {@link failedJobEntities} to its `JsailsDataSource` and runs
 * `db:push`); a missing table fails with a value-free
 * {@link FailedJobHistoryError} (`missing_table`) instead of being created.
 * The positive table check is cached per history.
 *
 * The data source is either caller-owned (`dataSource`, which must already be
 * initialized) or resolved lazily (`getDataSource`, initialized on first use
 * and destroyed again by `close()`), so a runtime config can construct the
 * history at import without connecting.
 *
 * Ids are the table's generated integer keys, rendered as decimal strings; an
 * id that is not one simply matches no entry. `take` claims an entry by the
 * row count its delete reports, so of two processes retrying one entry only
 * one receives it; on a driver that reports no count (sql.js, which is
 * in-process only) takes are serialized within the history instead.
 * `restore` re-inserts the row under its old key on drivers that accept an
 * explicit value for a generated key (MySQL, MariaDB, SQLite) and under a new
 * key elsewhere. Monitoring tags are stored in a
 * nullable JSON column, so a retried job keeps them. A payload that cannot be
 * serialized to JSON is stored as `null` so the failure itself is still
 * recorded; its retry then fails payload validation and the entry stays.
 */

import {
  IsNull,
  LessThan,
  Not,
  type DataSource,
  type FindOptionsWhere,
  type Repository,
} from 'typeorm';

import {
  failedJobRecordInputOf,
  FailedJobHistoryError,
  replayableJobOptions,
  resolveFailedJobCursor,
  resolveFailedJobListLimit,
  resolveFailedJobQueueFilter,
  validateFailedJobRecordInput,
  type FailedJobClearOptions,
  type FailedJobHistory,
  type FailedJobListOptions,
  type FailedJobRecordInput,
} from './failed-job-history.js';
import type { FailedJobEntry, FailedJobMembership } from './failed-jobs.js';
import {
  FAILED_JOB_MESSAGE_COLUMN_LENGTH,
  FAILED_JOB_NAME_COLUMN_LENGTH,
  FAILED_JOB_TABLE,
  JsailsFailedJob,
} from './failed-job-entity.js';

/** Options for {@link createDatabaseFailedJobHistory}. Supply exactly one source. */
export interface DatabaseFailedJobHistoryOptions {
  /** An initialized, caller-owned data source. `close()` leaves it open. */
  readonly dataSource?: DataSource;
  /**
   * Resolve the data source on first use, initializing it when needed. A
   * source this history initialized is destroyed by `close()`.
   */
  readonly getDataSource?: () => DataSource;
}

/** The decimal form of a generated integer key; anything else matches nothing. */
const ID_PATTERN = /^[1-9]\d{0,15}$/;

function parseId(id: string): number | undefined {
  return typeof id === 'string' && ID_PATTERN.test(id) ? Number(id) : undefined;
}

/** The payload to persist: the data itself when it round-trips through JSON, else `null`. */
function storablePayload(data: unknown): unknown {
  if (data === undefined) return null;
  try {
    return JSON.stringify(data) === undefined ? null : data;
  } catch {
    return null;
  }
}

/** Reject a value wider than its column, value-free. */
function assertFits(value: string | undefined, length: number): void {
  if (value !== undefined && value.length > length) {
    throw new FailedJobHistoryError('invalid_entry', 'failed-job record input is invalid');
  }
}

function toEntry(row: JsailsFailedJob): FailedJobEntry {
  return {
    id: String(row.id),
    queue: row.queue,
    name: row.name,
    data: row.payload ?? undefined,
    error: row.errorMessage,
    errorName: row.errorName,
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
    attempts: row.attempts,
    failedAt: row.failedAt instanceof Date ? row.failedAt : new Date(row.failedAt),
    ...(row.requestId === null ? {} : { requestId: row.requestId }),
    ...(isTagList(row.tags) ? { tags: row.tags } : {}),
    ...withOptions(replayableJobOptions(row.dispatchOptions)),
    ...(isMembership(row.membership) ? { membership: row.membership } : {}),
  };
}

function withOptions(
  options: Record<string, unknown> | undefined,
): { options: Record<string, unknown> } | Record<string, never> {
  return options === undefined ? {} : { options };
}

function isTagList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((tag) => typeof tag === 'string');
}

function isMembership(value: unknown): value is FailedJobMembership[] {
  return Array.isArray(value) && value.every((member) => member === 'chain' || member === 'batch');
}

/** Build a {@link FailedJobHistory} over the `jsails_failed_job` table. */
export function createDatabaseFailedJobHistory(
  options: DatabaseFailedJobHistoryOptions,
): FailedJobHistory {
  const hasSource = options?.dataSource !== undefined;
  const hasGetter = options?.getDataSource !== undefined;
  if (hasSource === hasGetter) {
    throw new FailedJobHistoryError(
      'missing_data_source',
      'createDatabaseFailedJobHistory requires exactly one of dataSource or getDataSource',
    );
  }

  let resolved: DataSource | undefined;
  let resolving: Promise<DataSource> | undefined;
  let ownsInitialization = false;
  // The table does not disappear under a running worker, so one successful
  // check is enough for the history's lifetime.
  let tableExists = false;

  async function resolveDataSource(): Promise<DataSource> {
    if (resolved !== undefined) return resolved;
    resolving ??= (async () => {
      const source =
        options.getDataSource !== undefined ? options.getDataSource() : options.dataSource;
      if (source === undefined || source === null) {
        throw new FailedJobHistoryError(
          'missing_data_source',
          'the failed-job history has no data source',
        );
      }
      if (options.getDataSource !== undefined && !source.isInitialized) {
        await source.initialize();
        ownsInitialization = true;
      }
      if (!source.isInitialized) {
        throw new FailedJobHistoryError(
          'missing_data_source',
          'the failed-job history data source must be initialized',
        );
      }
      resolved = source;
      return source;
    })();
    try {
      return await resolving;
    } finally {
      resolving = undefined;
    }
  }

  async function repository(): Promise<Repository<JsailsFailedJob>> {
    const dataSource = await resolveDataSource();
    if (!tableExists) {
      const queryRunner = dataSource.createQueryRunner();
      try {
        await queryRunner.connect();
        if (!(await queryRunner.hasTable(FAILED_JOB_TABLE))) {
          throw new FailedJobHistoryError(
            'missing_table',
            `the failed-job table does not exist; add failedJobEntities to the data source and run db:push`,
          );
        }
        tableExists = true;
      } finally {
        await queryRunner.release();
      }
    }
    return dataSource.getRepository(JsailsFailedJob);
  }

  /** The row values for a validated input; `id` re-uses a key on restore. */
  function rowValues(input: FailedJobRecordInput, id?: number): Partial<JsailsFailedJob> {
    const valid = validateFailedJobRecordInput(input);
    assertFits(valid.queue, FAILED_JOB_NAME_COLUMN_LENGTH);
    assertFits(valid.name, FAILED_JOB_NAME_COLUMN_LENGTH);
    assertFits(valid.requestId, FAILED_JOB_NAME_COLUMN_LENGTH);
    return {
      ...(id === undefined ? {} : { id }),
      queue: valid.queue,
      name: valid.name,
      payload: storablePayload(valid.data),
      errorName: valid.error.name.slice(0, FAILED_JOB_NAME_COLUMN_LENGTH),
      errorCode:
        valid.error.code === undefined
          ? null
          : valid.error.code.slice(0, FAILED_JOB_NAME_COLUMN_LENGTH),
      errorMessage: valid.error.message.slice(0, FAILED_JOB_MESSAGE_COLUMN_LENGTH),
      attempts: valid.attempts,
      failedAt: valid.failedAt,
      requestId: valid.requestId ?? null,
      tags: valid.tags === undefined ? null : [...valid.tags],
      dispatchOptions: valid.options === undefined ? null : { ...valid.options },
      membership: valid.membership === undefined ? null : [...valid.membership],
    };
  }

  async function record(input: FailedJobRecordInput): Promise<FailedJobEntry> {
    const values = rowValues(input);
    const repo = await repository();
    return toEntry(await repo.save(repo.create(values)));
  }

  async function list(listOptions: FailedJobListOptions = {}): Promise<readonly FailedJobEntry[]> {
    const limit = resolveFailedJobListLimit(listOptions.limit);
    const queue = resolveFailedJobQueueFilter(listOptions.queue);
    const cursor = resolveFailedJobCursor(listOptions.beforeId);
    const before = cursor === undefined ? undefined : parseId(cursor);
    if (cursor !== undefined && before === undefined) return [];
    const where: FindOptionsWhere<JsailsFailedJob> = {
      ...(queue === undefined ? {} : { queue }),
      ...(before === undefined ? {} : { id: LessThan(before) }),
    };
    const repo = await repository();
    const rows = await repo.find({
      where,
      order: { id: 'DESC' },
      take: limit,
    });
    return rows.map(toEntry);
  }

  async function get(id: string): Promise<FailedJobEntry | undefined> {
    const key = parseId(id);
    if (key === undefined) return undefined;
    const repo = await repository();
    const row = await repo.findOneBy({ id: key });
    return row === null ? undefined : toEntry(row);
  }

  async function remove(id: string): Promise<boolean> {
    const key = parseId(id);
    if (key === undefined) return false;
    const repo = await repository();
    // Not every driver reports `affected` (sql.js reports none), so existence
    // is read first; a reported count still decides.
    if (!(await repo.existsBy({ id: key }))) return false;
    const result = await repo.delete({ id: key });
    return typeof result.affected === 'number' ? result.affected > 0 : true;
  }

  // Serializes takes on a driver that reports no affected-row count.
  let takeChain: Promise<unknown> = Promise.resolve();

  async function take(id: string): Promise<FailedJobEntry | undefined> {
    const key = parseId(id);
    if (key === undefined) return undefined;
    const repo = await repository();
    const claim = async (): Promise<FailedJobEntry | undefined> => {
      const row = await repo.findOneBy({ id: key });
      if (row === null) return undefined;
      const result = await repo.delete({ id: key });
      // With a reported count, only the caller whose delete removed the row
      // holds the entry; without one, the serialization below stands in.
      if (typeof result.affected === 'number' && result.affected < 1) return undefined;
      return toEntry(row);
    };
    const next = takeChain.then(claim, claim);
    takeChain = next.catch(() => undefined);
    return next;
  }

  async function restore(entry: FailedJobEntry): Promise<FailedJobEntry> {
    const key = parseId(entry.id);
    const values = rowValues(failedJobRecordInputOf(entry), key);
    const repo = await repository();
    if (key !== undefined && (await repo.existsBy({ id: key }))) {
      const existing = await repo.findOneByOrFail({ id: key });
      return toEntry(existing);
    }
    return toEntry(await repo.save(repo.create(values)));
  }

  async function clear(clearOptions: FailedJobClearOptions = {}): Promise<number> {
    const queue = resolveFailedJobQueueFilter(clearOptions.queue);
    const repo = await repository();
    // Counted first because not every driver reports `affected`.
    // `Repository.delete` refuses empty criteria, so clearing every queue
    // matches every row by a non-null id.
    const count = await repo.countBy(queue === undefined ? {} : { queue });
    if (count > 0) {
      await repo.delete(queue === undefined ? { id: Not(IsNull()) } : { queue });
    }
    return count;
  }

  async function close(): Promise<void> {
    const source = resolved;
    resolved = undefined;
    tableExists = false;
    if (source !== undefined && ownsInitialization && source.isInitialized) {
      ownsInitialization = false;
      await source.destroy();
    }
  }

  return { record, list, get, remove, take, restore, clear, close };
}
