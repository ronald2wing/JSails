/**
 * The job catalog: the declared queues plus every job definition of an app,
 * checked together. A definition's queue must be declared (a type error when
 * the queue set is known statically, `jobs.undeclared_queue` otherwise),
 * and a name belongs to exactly one definition, so the producer can refuse a
 * call whose definition is not the registered one and a worker can tell an
 * unknown job from a known one.
 */

import type { z } from 'jsails/zod';

import type { QueueSet } from '../queues/queue-set.js';
import { isJobDefinition, jobSpec, type JobDefinition } from './define-job.js';
import { JobsErrors } from '../errors/jobs-errors.js';

/** The jobs and queues of one app. */
export interface JobCatalog<Q extends string = string> {
  readonly queues: QueueSet<Q>;
  /** Every definition, in declaration order. */
  readonly definitions: readonly JobDefinition<string, z.ZodType, Q>[];
  get(name: string): JobDefinition<string, z.ZodType, Q> | undefined;
}

/**
 * Check definitions against the declared queues.
 *
 * @throws `jobs.invalid_definition` for a value `defineJob` did not build,
 *   `jobs.duplicate_job` when two definitions share a name,
 *   `jobs.undeclared_queue` for a queue the set does not declare.
 */
export function createJobCatalog<Q extends string>(input: {
  readonly queues: QueueSet<Q>;
  readonly definitions: readonly JobDefinition<string, z.ZodType, NoInfer<Q>>[];
}): JobCatalog<Q> {
  const byName = new Map<string, JobDefinition<string, z.ZodType, Q>>();
  for (const definition of input.definitions) {
    if (!isJobDefinition(definition)) {
      throw new JobsErrors.Error('invalid_definition', { rule: 'not_built' });
    }
    const spec = jobSpec(definition);
    if (byName.has(spec.name)) {
      throw new JobsErrors.Error('duplicate_job', { job: spec.name });
    }
    if (!input.queues.has(spec.queue)) {
      throw new JobsErrors.Error('undeclared_queue', { job: spec.name, queue: spec.queue });
    }
    byName.set(spec.name, definition);
  }
  return Object.freeze({
    queues: input.queues,
    definitions: Object.freeze([...byName.values()]),
    get: (name: string) => byName.get(name),
  });
}
