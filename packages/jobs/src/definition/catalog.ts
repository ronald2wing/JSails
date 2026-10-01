/**
 * The job catalog: the declared queues plus every job definition of an app,
 * checked together. A definition's queue must be declared (a type error when
 * the queue set is known statically, a {@link JobDefinitionError} otherwise),
 * and a name belongs to exactly one definition, so the producer can refuse a
 * call whose definition is not the registered one and a worker can tell an
 * unknown job from a known one.
 */

import type { z } from 'jsails/zod';

import type { QueueSet } from '../queues/queue-set.js';
import { isJobDefinition, jobSpec, type JobDefinition } from './define-job.js';
import { JobDefinitionError } from './definition-error.js';

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
 * @throws {JobDefinitionError} `invalid_definition` for a value `defineJob`
 *   did not build, `duplicate_job` when two definitions share a name,
 *   `unknown_queue` for a queue the set does not declare.
 */
export function createJobCatalog<Q extends string>(input: {
  readonly queues: QueueSet<Q>;
  readonly definitions: readonly JobDefinition<string, z.ZodType, NoInfer<Q>>[];
}): JobCatalog<Q> {
  const byName = new Map<string, JobDefinition<string, z.ZodType, Q>>();
  for (const definition of input.definitions) {
    if (!isJobDefinition(definition)) {
      throw new JobDefinitionError(
        'invalid_definition',
        'a catalog entry is not a job definition built by defineJob',
      );
    }
    const spec = jobSpec(definition);
    if (byName.has(spec.name)) {
      throw new JobDefinitionError('duplicate_job', 'two job definitions share one name', {
        context: { job: spec.name },
      });
    }
    if (!input.queues.has(spec.queue)) {
      throw new JobDefinitionError(
        'unknown_queue',
        'a job definition names a queue that is not declared',
        { context: { job: spec.name, queue: spec.queue } },
      );
    }
    byName.set(spec.name, definition);
  }
  return Object.freeze({
    queues: input.queues,
    definitions: Object.freeze([...byName.values()]),
    get: (name: string) => byName.get(name),
  });
}
