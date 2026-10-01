/**
 * A third-party style registration: `testJobsAdapter` called at the top level
 * of a test file, for the reference driver. `suite.test.ts` runs it in its own
 * process and checks the tests it reports.
 */

import { testJobsAdapter } from '../../../src/testing/index.js';
import { createReferenceDriver } from '../reference-driver.js';

testJobsAdapter('reference', createReferenceDriver, { virtualTime: true });
