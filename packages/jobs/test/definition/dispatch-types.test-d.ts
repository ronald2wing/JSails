/**
 * Type tests, checked by the test build and never executed: a call's payload
 * is the schema input, a handler's payload is the schema output, and a wrong
 * payload, an unknown option, an undeclared queue, or a command job over
 * anything but a named `defineCommand` command that needs only the
 * environment is a compile error. Each `@ts-expect-error` fails the build if
 * the line below it stops being an error.
 */

import { defineCommand } from 'jsails/kernel';
import { z } from 'zod';

import type { JobHandle } from '../../src/contract/index.js';
import { createJobCatalog } from '../../src/definition/catalog.js';
import { defineCommandJob } from '../../src/definition/command-job.js';
import { defineJob, type JobCall } from '../../src/definition/define-job.js';
import type { Jobs } from '../../src/definition/jobs-service.js';
import { defineQueues } from '../../src/queues/queue-set.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(_proof?: T): void {}

const schema = z.object({
  id: z.string(),
  count: z.string().transform((value) => Number(value)),
  format: z.enum(['pdf', 'csv']).default('pdf'),
});

export const Report = defineJob({
  name: 'report',
  schema,
  queue: 'reports',
  handle(_payload) {
    expectType<Equal<typeof _payload, { id: string; count: number; format: 'pdf' | 'csv' }>>();
  },
});

expectType<Equal<typeof Report.name, 'report'>>();
expectType<Equal<typeof Report.queue, 'reports'>>();

export const call = Report.with({ id: 'a', count: '3' });
expectType<Equal<typeof call, JobCall<'report', typeof schema>>>();
expectType<
  Equal<typeof call.payload, { id: string; count: string; format?: 'pdf' | 'csv' | undefined }>
>();

// @ts-expect-error a payload missing a required field
Report.with({ count: '3' });
// @ts-expect-error a payload field of the wrong type (the input of `count` is a string)
Report.with({ id: 'a', count: 3 });
// @ts-expect-error an unknown dispatch option
Report.with({ id: 'a', count: '3' }, { attemps: 3 });
// @ts-expect-error a BullMQ option name is not a dispatch option
Report.with({ id: 'a', count: '3' }, { jobId: 'x' });
// @ts-expect-error runAt is a Date
Report.with({ id: 'a', count: '3' }, { runAt: 1_700_000_000_000 });

export const Defaulted = defineJob({
  name: 'defaulted',
  schema: z.null(),
  handle: () => undefined,
});
expectType<Equal<typeof Defaulted.queue, 'default'>>();

export async function dispatching(jobs: Jobs): Promise<JobHandle> {
  await jobs.dispatch(Report.with({ id: 'a', count: '1' }), { delayMs: 5, key: 'k', tags: ['t'] });
  // @ts-expect-error dispatch takes a call, not a name and a payload
  await jobs.dispatch('report', { id: 'a' });
  // @ts-expect-error an unknown option on dispatch itself
  await jobs.dispatch(Report.with({ id: 'a', count: '1' }), { queue: 'other' });
  return jobs.dispatchByName('report', { anything: true });
}

const queues = defineQueues({ reports: { concurrency: 2 }, mail: {} });
expectType<Equal<(typeof queues.names)[number], 'reports' | 'mail' | 'default'>>();

export const catalog = createJobCatalog({ queues, definitions: [Report, Defaulted] });

const Stray = defineJob({
  name: 'stray',
  schema: z.null(),
  queue: 'billing',
  handle: () => undefined,
});
// @ts-expect-error a definition on a queue the set does not declare
createJobCatalog({ queues, definitions: [Report, Stray] });

defineJob({
  name: 'bad-key',
  schema,
  // @ts-expect-error a key function receives the parsed payload, whose count is a number
  key: (payload: { count: string }) => payload.count,
  handle: () => undefined,
});

defineJob({
  name: 'bad-handler',
  schema,
  // @ts-expect-error the handler payload is the schema output
  handle: (payload: { count: string }) => void payload,
});

const reports = defineCommand({ summary: 'Run the reports', run: () => 0 });
export const Command = defineCommandJob(reports, { name: 'reports.run', queue: 'mail' });
// @ts-expect-error a command carries no name, so the job names it
defineCommandJob(reports, {});
// @ts-expect-error only a command that needs the environment alone runs as a job
defineCommandJob(defineCommand({ summary: 'Serve', needs: 'app', run: () => 0 }), { name: 'x' });
// @ts-expect-error the old structural shape is no command
defineCommandJob({ name: 'reports', run: () => 0 }, { name: 'reports' });
expectType<Equal<typeof Command.name, 'reports.run'>>();
expectType<Equal<typeof Command.queue, 'mail'>>();
Command.with({ args: ['--force'] });
// @ts-expect-error command job args are strings
Command.with({ args: [1] });
