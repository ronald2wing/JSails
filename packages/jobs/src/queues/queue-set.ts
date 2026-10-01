/**
 * Declared queues. An app names its queues once, each with its own
 * concurrency and retention, and a job definition's `queue` must be one of
 * them: the name is checked by the type of the queue set and again when the
 * job catalog is built. Every set has a `default` queue, declared or not, so a
 * definition without `queue` always has a home.
 *
 * Retention is how long settled jobs stay in the transport: completed jobs
 * for inspection, failed jobs as the failed-job list (there is no second
 * failed-job store). Whichever of `age` and `count` is reached first evicts.
 * An idempotency key does not depend on retention: it holds for its own
 * window after the job is evicted.
 *
 * The transport namespace `<app>:<environment>` keeps two apps, or two
 * environments of one app, apart on a shared transport.
 */

import type { QueueDeclaration, RetentionRule } from '../contract/index.js';
import { MAX_JOB_DELAY_MS } from '../envelope/job-options.js';
import { JobsErrors } from '../errors/jobs-errors.js';

/** A duration: milliseconds, or a whole number with a unit (`'500ms'`, `'30s'`, `'15m'`, `'1h'`, `'7d'`). */
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`;

/** One retention bound pair as an app writes it. */
export interface RetentionOptions {
  /** Evict settled jobs older than this. */
  readonly age?: Duration;
  /** Keep at most this many settled jobs; `0` evicts at once. */
  readonly count?: number;
}

/** One queue as an app declares it. */
export interface QueueOptions {
  /** Attempts in flight at once per worker process. Defaults to 1. */
  readonly concurrency?: number;
  readonly retention?: {
    readonly completed?: RetentionOptions;
    readonly failed?: RetentionOptions;
  };
}

/** The name every queue set contains. */
export const DEFAULT_QUEUE = 'default';

/** The most concurrent attempts one queue may run per worker process. */
export const MAX_QUEUE_CONCURRENCY = 1_000;

/** The most settled jobs a retention rule may keep. */
export const MAX_RETAINED_JOBS = 10_000_000;

/** Retention a queue gets unless it states its own. */
export const DEFAULT_RETENTION: QueueDeclaration['retention'] = Object.freeze({
  completed: Object.freeze({ ageMs: 3_600_000, count: 1_000 }),
  failed: Object.freeze({ ageMs: 7 * 86_400_000, count: 100_000 }),
});

const QUEUE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const NAMESPACE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DURATION = /^(\d{1,15})(ms|s|m|h|d)$/;
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

type QueueRule = 'shape' | 'name' | 'field' | 'concurrency' | 'retention' | 'age' | 'count';

/** The declared queues of an app, `default` always among them. */
export interface QueueSet<Q extends string = string> {
  /** Every queue name, `default` first. */
  readonly names: readonly Q[];
  /** Every queue, normalized, in {@link names} order. */
  readonly declarations: readonly QueueDeclaration[];
  has(name: string): name is Q;
  get(name: string): QueueDeclaration | undefined;
}

/** Whether `name` is a valid queue name: lower-case kebab, starting with a letter, at most 63 characters. */
export function isQueueName(name: unknown): name is string {
  return typeof name === 'string' && QUEUE_NAME.test(name);
}

/** Milliseconds of a {@link Duration}, or `undefined` when it is not one. */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const match = DURATION.exec(value);
  if (match === null) return undefined;
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  return Number.isSafeInteger(ms) ? ms : undefined;
}

function invalid(rule: QueueRule): Error {
  return new JobsErrors.Error('invalid_queue', { rule });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (!Object.keys(value).every((key) => keys.includes(key))) throw invalid('field');
}

function retentionRule(value: unknown, fallback: RetentionRule): RetentionRule {
  if (value === undefined) return fallback;
  if (!isRecord(value)) throw invalid('retention');
  knownKeys(value, ['age', 'count']);
  let ageMs = fallback.ageMs;
  if (value.age !== undefined) {
    const parsed = parseDuration(value.age);
    if (parsed === undefined || parsed > MAX_JOB_DELAY_MS) {
      throw invalid('age');
    }
    ageMs = parsed;
  }
  let count = fallback.count;
  if (value.count !== undefined) {
    if (
      typeof value.count !== 'number' ||
      !Number.isSafeInteger(value.count) ||
      value.count < 0 ||
      value.count > MAX_RETAINED_JOBS
    ) {
      throw invalid('count');
    }
    count = value.count;
  }
  return Object.freeze({ ageMs, count });
}

function declaration(name: string, value: unknown): QueueDeclaration {
  if (!isRecord(value)) throw invalid('shape');
  knownKeys(value, ['concurrency', 'retention']);
  let concurrency = 1;
  if (value.concurrency !== undefined) {
    if (
      typeof value.concurrency !== 'number' ||
      !Number.isSafeInteger(value.concurrency) ||
      value.concurrency < 1 ||
      value.concurrency > MAX_QUEUE_CONCURRENCY
    ) {
      throw invalid('concurrency');
    }
    concurrency = value.concurrency;
  }
  let retention = DEFAULT_RETENTION;
  if (value.retention !== undefined) {
    if (!isRecord(value.retention)) throw invalid('retention');
    knownKeys(value.retention, ['completed', 'failed']);
    retention = Object.freeze({
      completed: retentionRule(value.retention.completed, DEFAULT_RETENTION.completed),
      failed: retentionRule(value.retention.failed, DEFAULT_RETENTION.failed),
    });
  }
  return Object.freeze({ name, concurrency, retention });
}

/**
 * Declare an app's queues. `default` is added with the defaults unless it is
 * declared.
 *
 * @throws `jobs.invalid_queue` for a name that is not lower-case kebab (at
 *   most 63 characters) or a declaration out of bounds.
 */
export function defineQueues<const M extends Readonly<Record<string, QueueOptions>>>(
  queues: M,
): QueueSet<(keyof M & string) | typeof DEFAULT_QUEUE> {
  if (!isRecord(queues)) throw invalid('shape');
  const declared = new Map<string, QueueDeclaration>();
  declared.set(DEFAULT_QUEUE, declaration(DEFAULT_QUEUE, queues[DEFAULT_QUEUE] ?? {}));
  for (const name of Object.keys(queues)) {
    if (name === DEFAULT_QUEUE) continue;
    if (!isQueueName(name)) {
      throw invalid('name');
    }
    declared.set(name, declaration(name, queues[name]));
  }
  type Name = (keyof M & string) | typeof DEFAULT_QUEUE;
  const names = Object.freeze([...declared.keys()]) as readonly Name[];
  const declarations = Object.freeze([...declared.values()]);
  return Object.freeze({
    names,
    declarations,
    has: (name: string): name is Name => declared.has(name),
    get: (name: string) => declared.get(name),
  });
}

/**
 * The transport namespace of one app environment: `<app>:<environment>`.
 *
 * @throws `jobs.invalid_namespace` when a part is empty, longer than 64
 *   characters, or holds anything but letters, digits, `.`, `_` and `-`.
 */
export function jobsNamespace(app: string, environment: string): string {
  if (!NAMESPACE_PART.test(app) || !NAMESPACE_PART.test(environment)) {
    throw new JobsErrors.Error('invalid_namespace');
  }
  return `${app}:${environment}`;
}
