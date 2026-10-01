/**
 * A dispatch recorder for tests: a {@link JobsService} that records every
 * dispatch instead of enqueuing it, plus assertions over what was dispatched.
 *
 * Provide it where the app resolves the jobs service (for example
 * `services.provide(jobsToken, fake)`), run the code under test, then assert:
 *
 * ```ts
 * const jobs = createFakeJobs({ registry });
 * await signUp(user, { jobs });
 * jobs.assertDispatched('sendWelcomeEmail', (payload) => payload.to === user.email);
 * jobs.assertNotDispatched('chargeCard');
 * ```
 *
 * With a `registry`, a dispatch is validated exactly as the runtime validates
 * it (known job, payload schema, option allowlist), so a test fails on a
 * dispatch production would reject.
 */

import { AssertionError } from 'node:assert';

import type { JobsService } from './plugin.js';
import { validateJobOptions } from './queue.js';
import { JobNotRegisteredError, validatePayload, type JobRegistry } from './registry.js';

/** One recorded dispatch. */
export interface FakeDispatch {
  readonly name: string;
  /** The payload after schema parsing (as the worker would receive it). */
  readonly payload: unknown;
  readonly options: unknown;
}

/** Options accepted by {@link createFakeJobs}. */
export interface FakeJobsOptions {
  /** Validate dispatches against this registry, like the runtime does. */
  readonly registry?: JobRegistry;
}

/** The recorder returned by {@link createFakeJobs}. */
export interface FakeJobs extends JobsService {
  /** Every dispatch, in order. */
  readonly dispatched: readonly FakeDispatch[];
  /** The dispatches of one job, in order. */
  dispatchesOf(name: string): readonly FakeDispatch[];
  /** Fail unless `name` was dispatched (with a payload matching `predicate`, when given). */
  assertDispatched(name: string, predicate?: (payload: unknown) => boolean): void;
  /** Fail unless `name` was dispatched exactly `times` times. */
  assertDispatchedTimes(name: string, times: number): void;
  /** Fail if `name` was dispatched. */
  assertNotDispatched(name: string): void;
  /** Fail if anything was dispatched. */
  assertNothingDispatched(): void;
  /** Forget every recorded dispatch. */
  clear(): void;
}

/** Build a dispatch recorder; see the module comment. */
export function createFakeJobs(options: FakeJobsOptions = {}): FakeJobs {
  const dispatched: FakeDispatch[] = [];
  const { registry } = options;
  const dispatchesOf = (name: string): readonly FakeDispatch[] =>
    dispatched.filter((entry) => entry.name === name);

  return {
    dispatched,
    dispatchesOf,
    dispatch(name, payload, opts) {
      let parsed = payload;
      if (registry !== undefined) {
        const definition = registry[name];
        if (definition === undefined) {
          return Promise.reject(new JobNotRegisteredError(name));
        }
        try {
          parsed = validatePayload(definition.schema, name, payload);
          validateJobOptions(opts);
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
      dispatched.push({ name, payload: parsed, options: opts });
      return Promise.resolve({ id: String(dispatched.length), name });
    },
    assertDispatched(name, predicate) {
      const matches = dispatchesOf(name).filter(
        (entry) => predicate === undefined || predicate(entry.payload),
      );
      if (matches.length === 0) {
        throw new AssertionError({
          message:
            predicate === undefined
              ? `expected job "${name}" to be dispatched`
              : `expected job "${name}" to be dispatched with a matching payload`,
        });
      }
    },
    assertDispatchedTimes(name, times) {
      const actual = dispatchesOf(name).length;
      if (actual !== times) {
        throw new AssertionError({
          message: `expected job "${name}" to be dispatched ${times} time(s)`,
          actual,
          expected: times,
          operator: 'strictEqual',
        });
      }
    },
    assertNotDispatched(name) {
      if (dispatchesOf(name).length > 0) {
        throw new AssertionError({ message: `expected job "${name}" not to be dispatched` });
      }
    },
    assertNothingDispatched() {
      if (dispatched.length > 0) {
        throw new AssertionError({
          message: 'expected no job to be dispatched',
          actual: dispatched.map((entry) => entry.name),
          expected: [],
          operator: 'deepStrictEqual',
        });
      }
    },
    clear() {
      dispatched.length = 0;
    },
  };
}
