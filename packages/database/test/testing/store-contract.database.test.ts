/**
 * The store contract harness on the run's driver, with the sample
 * key-value store: upsert, uniqueness, four concurrent writers, expiry with
 * a sweep, removal, and rollback with a test transaction.
 */

import { storeContract } from '../../src/testing/index.js';
import { createSampleStore, SAMPLE_CONTRACT } from './fixtures/sample-store.js';

void storeContract(
  'the sample key-value store',
  ({ dataSource, clock }) => createSampleStore(dataSource, clock),
  SAMPLE_CONTRACT,
);
