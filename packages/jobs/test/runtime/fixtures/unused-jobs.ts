/**
 * A {@link Jobs} service for runtime tests whose handlers never dispatch:
 * every method rejects, so an unexpected dispatch fails the test.
 */

import type { Jobs } from '../../../src/definition/jobs-service.js';

function unused(): Promise<never> {
  return Promise.reject(new Error('not used'));
}

export const unusedJobs: Jobs = {
  dispatch: unused,
  dispatchByName: unused,
  chain: unused,
  batch: unused,
  batchStatus: unused,
  batchFailures: unused,
};
