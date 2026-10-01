/**
 * The jobs of the spawned two-process tests, shared by the test process and
 * the worker process so both build the same catalog. Every run is reported
 * through `report`. `hang` never settles in the worker process (`role:
 * 'doomed'`), so the test can kill that process mid-attempt; in any other
 * role it completes like the rest.
 */

import { z } from 'zod';

import { createJobCatalog, type JobCatalog } from '../../../src/definition/catalog.js';
import { defineJob } from '../../../src/definition/define-job.js';
import { defineQueues } from '../../../src/queues/queue-set.js';

/** One handler run, as a process reports it. */
export interface RunReport {
  readonly type: 'ran';
  readonly name: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly payload: unknown;
  readonly pid: number;
}

/** The queues of both processes. */
export const PROCESS_QUEUES = defineQueues({ default: { concurrency: 4 } });

/** The catalog of a process in `role`, reporting every run to `report`. */
export function processCatalog(
  role: 'doomed' | 'healthy',
  report: (run: RunReport) => void,
): JobCatalog<'default'> {
  const reporting = (name: string) =>
    defineJob({
      name,
      schema: z.unknown(),
      handle: (payload, context) => {
        report({
          type: 'ran',
          name,
          jobId: context.jobId,
          attempt: context.attempt,
          payload,
          pid: process.pid,
        });
        return Promise.resolve();
      },
    });
  const Hang = defineJob({
    name: 'hang',
    schema: z.unknown(),
    handle: (payload, context) => {
      report({
        type: 'ran',
        name: 'hang',
        jobId: context.jobId,
        attempt: context.attempt,
        payload,
        pid: process.pid,
      });
      return role === 'doomed' ? new Promise<void>(() => undefined) : Promise.resolve();
    },
  });
  return createJobCatalog({
    queues: PROCESS_QUEUES,
    definitions: [reporting('echo'), reporting('on-then'), reporting('on-catch'), Hang],
  });
}
