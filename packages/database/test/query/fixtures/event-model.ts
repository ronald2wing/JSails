/**
 * The model of the batch-walk suites: events with a millisecond timestamp
 * (indexed with the key, so a walk in timestamp order can read through the
 * index), a nullable rank, and a label. A plain table, so its rows are plain
 * objects.
 */

import { column, defineTable, type ModelTarget } from '../../../src/model/index.js';

/** A row of {@link Event}. */
export interface EventRow {
  readonly id: number;
  readonly at: Date;
  readonly rank: number | null;
  readonly label: string;
}

export const Event = defineTable({
  table: 'q_events',
  columns: {
    at: column.timestamp(),
    rank: column.integer({ nullable: true }),
    label: column.string(40),
  },
  indexes: [{ columns: ['at', 'id'] }],
});

export const EVENT_MODELS: readonly ModelTarget[] = Object.freeze([Event]);
