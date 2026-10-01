/**
 * The change feed: key-only records of committed writes (`ChangeRecord`),
 * coalesced per commit, and `ds.changes.subscribe`, scoped by a model
 * set and delivered after the outermost commit.
 */

export {
  type ChangeFeed,
  type ChangeListener,
  type ChangeSubscriptionOptions,
  type Unsubscribe,
} from './change-feed.js';
export {
  type ChangeKey,
  type ChangeOp,
  type ChangeRecord,
  type ChangeTenant,
} from './change-record.js';
