/**
 * Failed jobs, as every transport serves them: the retry refusal rule, and
 * the checked list and prune options with the list order and cursor rule.
 *
 * Exported here for the package's adapters; the package barrel exports none
 * of it.
 */

export {
  checkedListOptions,
  checkedPruneOptions,
  compareFailed,
  DEFAULT_FAILED_LIST_LIMIT,
  isAfterCursor,
  MAX_FAILED_CURSOR_ID_LENGTH,
  MAX_FAILED_LIST_LIMIT,
  type FailedListOptions,
} from './list-options.js';
export { retryRefusal } from './retry-rule.js';
