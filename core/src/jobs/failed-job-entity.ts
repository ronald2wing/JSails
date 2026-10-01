/**
 * The framework-owned entity for durable failed-job history.
 *
 * {@link JsailsFailedJob} maps the `jsails_failed_job` table: a generated
 * integer primary key plus scalar columns the portable schema model accepts.
 * An app that records failed jobs in its database adds
 * {@link failedJobEntities} to its `JsailsDataSource` entities, and `db:push`
 * creates the table through the normal declarative schema history; the
 * history never runs DDL itself.
 *
 * `payload` is a JSON column holding the job data as the worker received it
 * (`null` when the job had none). The error columns hold the value-free
 * summary the runtime reports: class name, optional code, and the message
 * already capped by `summarizeJobError`. `tags` holds the job's normalized
 * monitoring tags, or `null` when it had none. `dispatchOptions` holds the
 * options a retry replays (attempts, backoff, priority, ...) and `membership`
 * the chain or batch the job belonged to, each `null` when absent. `failedAt`
 * has no database default; the runtime sets it.
 */

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Table JSails reserves for failed-job history. */
export const FAILED_JOB_TABLE = 'jsails_failed_job';

/** Width of the `queue`, `name`, `errorName`, `errorCode`, and `requestId` columns. */
export const FAILED_JOB_NAME_COLUMN_LENGTH = 255;

/** Width of the `errorMessage` column: the capped message plus its ellipsis fits. */
export const FAILED_JOB_MESSAGE_COLUMN_LENGTH = 512;

@Entity(FAILED_JOB_TABLE)
export class JsailsFailedJob extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: FAILED_JOB_NAME_COLUMN_LENGTH, nullable: false })
  queue!: string;

  @Column({ type: 'varchar', length: FAILED_JOB_NAME_COLUMN_LENGTH, nullable: false })
  name!: string;

  @Column({ type: 'json', nullable: true })
  payload!: unknown;

  @Column({ type: 'varchar', length: FAILED_JOB_NAME_COLUMN_LENGTH, nullable: false })
  errorName!: string;

  @Column({ type: 'varchar', length: FAILED_JOB_NAME_COLUMN_LENGTH, nullable: true })
  errorCode!: string | null;

  @Column({ type: 'varchar', length: FAILED_JOB_MESSAGE_COLUMN_LENGTH, nullable: false })
  errorMessage!: string;

  @Column({ type: 'integer', nullable: false })
  attempts!: number;

  @Column({ type: 'datetime', nullable: false })
  failedAt!: Date;

  @Column({ type: 'varchar', length: FAILED_JOB_NAME_COLUMN_LENGTH, nullable: true })
  requestId!: string | null;

  @Column({ type: 'json', nullable: true })
  tags!: string[] | null;

  @Column({ type: 'json', nullable: true })
  dispatchOptions!: Record<string, unknown> | null;

  @Column({ type: 'json', nullable: true })
  membership!: string[] | null;
}

/**
 * The entities an app includes in its `JsailsDataSource` `entities` list when
 * it records failed jobs with the database history.
 */
export const failedJobEntities: readonly [typeof JsailsFailedJob] = Object.freeze([
  JsailsFailedJob,
] as const);
