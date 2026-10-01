/**
 * The framework-owned entity for database-backed sessions.
 *
 * {@link JsailsSession} is the single source of truth for the `jsails_session`
 * table JSails reserves for persisted sessions. It is a plain Active Record
 * entity — a generated integer primary key plus four scalar columns — that the
 * portable schema model accepts, so an app registers it with its
 * `JsailsDataSource` and creates the table through the normal declarative
 * schema history (`db:push`), never through runtime DDL.
 *
 * `data` holds the JSON-serialized session (id, CSRF token, session data, and
 * the millisecond expiry), while `sessionId` and `expiresAt` are denormalized
 * scalar columns for lookup and expiry pruning. `createdAt` has no database
 * default and no `@CreateDateColumn`; the database store sets it from
 * application code on the first write.
 */

import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Table JSails reserves for database-backed sessions. */
export const SESSION_TABLE = 'jsails_session';

/** `jsails_session.sessionId` column width. */
export const SESSION_ID_COLUMN_LENGTH = 190;

@Entity(SESSION_TABLE)
// Every request resolves its session by `sessionId`, and `pruneExpired` scans
// by `expiresAt`; without these indexes both are full-table scans that grow
// with the session table.
@Index('jsails_session_session_id_unique', ['sessionId'], { unique: true })
@Index('jsails_session_expires_at', ['expiresAt'])
export class JsailsSession extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: SESSION_ID_COLUMN_LENGTH, nullable: false })
  sessionId!: string;

  @Column({ type: 'text', nullable: false })
  data!: string;

  @Column({ type: 'datetime', nullable: false })
  expiresAt!: Date;

  @Column({ type: 'datetime', nullable: false })
  createdAt!: Date;
}

/**
 * The entities an app must include in its `JsailsDataSource` `entities` list
 * when it persists sessions in the database.
 */
export const sessionEntities = Object.freeze([JsailsSession] as const);
