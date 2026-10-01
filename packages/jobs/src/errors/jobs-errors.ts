/**
 * The package's error codes, `jobs.*`, in one registry. Each code's kind
 * decides how a failure is treated everywhere: an HTTP or CLI boundary reads
 * it, and the worker runtime retries a failed attempt only when its kind is
 * retryable (`isRetryableKind`), so a handler whose own dispatch is refused
 * as `invalid_payload` fails once instead of spending every attempt.
 *
 * Every message is fixed text plus context slots, and a slot holds only a
 * name declared in code (an option, job or queue name of a definition) or a
 * member of a fixed list, never a value that arrived at runtime: a payload, a
 * key, a dispatched job name or a stored envelope never reaches a message.
 * The bounds a value broke are in each code's suggestion and the docs.
 */

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

const JOBS_ERRORS = {
  invalid_definition: {
    kind: 'internal',
    message: 'the job definition fails its {rule} check',
    context: {
      rule: [
        'shape',
        'name',
        'schema',
        'queue',
        'handle',
        'command',
        'command_name',
        'command_args',
        'not_built',
        'reserved',
      ],
    },
    suggestion:
      'Declare jobs with defineJob or defineCommandJob: a name of letters and digits in segments joined by ".", ":", "_" or "-" (at most 128 characters, starting with a letter), a Zod schema, a lower-case queue name and a handle function; names starting with "jsails." are reserved; a command job needs a defineCommand command that needs only the environment, a job name, and string args',
  },
  duplicate_job: {
    kind: 'internal',
    message: 'two job definitions are named {job}',
    context: { job: 'identifier' },
    suggestion: 'Give every job of an app its own name',
  },
  undeclared_queue: {
    kind: 'internal',
    message: 'job {job} names queue {queue}, which is not declared',
    context: { job: 'identifier', queue: 'identifier' },
    suggestion: 'Declare the queue with defineQueues, or move the job to a declared queue',
  },
  unknown_option: {
    kind: 'invalid',
    message: 'the options have a field that is not an option',
    suggestion: 'Check the option names against the jobs documentation',
  },
  invalid_option: {
    kind: 'invalid',
    message: 'job option {option} is invalid',
    context: { option: 'identifier' },
    suggestion:
      'attempts is 1 to 25; delays, timeouts and key windows are whole milliseconds up to one year; priority is 0 to 2097152; a key is 1 to 512 characters and does not start with the reserved "jsails:"; tags are at most 32 strings of 1 to 128 characters; delayMs and runAt are exclusive; overlap ttlMs is 1000 to 3600000 ms; flow calls take no delayMs, runAt, key or keyWindowMs',
  },
  unknown_job: {
    kind: 'not_found',
    message: 'no job of that name is registered',
    suggestion: 'Register the job definition in the job catalog of every producer and worker',
  },
  invalid_payload: {
    kind: 'invalid',
    message: 'the job payload does not match the job schema',
  },
  payload_not_json: {
    kind: 'invalid',
    message:
      'a job payload must be plain JSON: objects, arrays, strings, finite numbers, booleans and null',
  },
  context_not_json: {
    kind: 'internal',
    message: 'a serialized execution context must be plain JSON',
  },
  invalid_envelope: {
    kind: 'invalid',
    message: 'the value is not a job envelope this process reads',
  },
  producer_closed: {
    kind: 'unavailable',
    message: 'the job producer is closed',
  },
  invalid_queue: {
    kind: 'internal',
    message: 'the queue declaration fails its {rule} check',
    context: { rule: ['shape', 'name', 'field', 'concurrency', 'retention', 'age', 'count'] },
    suggestion:
      'A queue name is lower-case letters, digits and hyphens (at most 63 characters, starting with a letter); concurrency is 1 to 1000; retention has completed and failed rules of an age up to one year and a count up to 10000000',
  },
  invalid_namespace: {
    kind: 'internal',
    message:
      'the app and environment names of a jobs namespace must be letters, digits, ".", "_" or "-"',
    suggestion: 'Each part is 1 to 64 characters and starts with a letter or digit',
  },
  invalid_delay: {
    kind: 'internal',
    message: 'a timer delay must be a non-negative safe integer of milliseconds',
  },
  command_threw: {
    kind: 'internal',
    message: 'the command run as a job threw',
  },
  command_usage: {
    kind: 'internal',
    message: 'the command run as a job was given invalid arguments',
    suggestion: "Pass the args the command's own options and positionals accept",
  },
  command_exit: {
    kind: 'internal',
    message: 'the command run as a job exited with a non-zero or invalid exit code',
  },
  unknown_queue: {
    kind: 'internal',
    message: 'the queue is not declared on this adapter',
  },
  adapter_closed: {
    kind: 'unavailable',
    message: 'the jobs adapter is closed',
  },
  invalid_worker: {
    kind: 'internal',
    message: 'worker option {option} is invalid',
    context: { option: 'identifier' },
    suggestion:
      'A worker needs at least one declared queue; concurrency is a positive integer; handlerGraceMs is 1 ms to one year; abortCollectMs is 0 to 60000 ms',
  },
  worker_aborted: {
    kind: 'aborted',
    message: 'the worker is shutting down',
  },
  attempt_timeout: {
    kind: 'timeout',
    message: 'the job attempt exceeded its timeoutMs',
    suggestion: 'Raise the job timeoutMs, or pass the attempt signal to the I/O the handler awaits',
  },
  processor_broke_contract: {
    kind: 'internal',
    message: 'the job processor threw or resolved with a value that is not an attempt outcome',
  },
  middleware_next_reused: {
    kind: 'internal',
    message: 'a job middleware called next() more than once',
    suggestion: 'Call next() at most once per attempt; the handler must not run twice',
  },
  middleware_next_late: {
    kind: 'internal',
    message: 'a job middleware called next() after it had settled',
    suggestion:
      'Await or return next() inside the middleware; a handler started later would run outside its attempt',
  },
  capability_missing: {
    kind: 'internal',
    message: 'the jobs adapter has no {capability} capability',
    context: { capability: ['flows', 'failedJobs', 'schedules', 'leases'] },
    suggestion:
      'Use an adapter that provides the capability (the memory adapter provides all four), or drop the feature that needs it: batches need flows, overlap needs leases, schedules need schedules',
  },
  invalid_flow: {
    kind: 'invalid',
    message: 'the chain or batch fails its {rule} check',
    context: {
      rule: [
        'shape',
        'empty',
        'too_many_steps',
        'too_many_items',
        'id',
        'chunked_id',
        'queue',
        'callback',
      ],
    },
    suggestion:
      'A chain has 1 to 100 steps; a batch has 1 to 1,000 children, or up to 100,000 with chunked and an id; a flow id is letters and digits joined by ".", ":", "_" or "-" (at most 128 characters); a batch queue is declared; callbacks are job calls',
  },
  flow_too_large: {
    kind: 'too_large',
    message: 'the chain or batch is larger than 262144 bytes once encoded',
    suggestion:
      'Keep the payloads of a chain, or the callbacks of a batch, under 256 KiB in all: store large data elsewhere and pass its id',
  },
  flow_item_refused: {
    kind: 'invalid',
    message: 'item {item} of the chain or batch was refused',
    context: { item: 'count' },
    suggestion:
      'Items are numbered from 0: the steps or children first, then the catch of a chain, or the then, catch and finally of a batch; the cause carries the refusal of that item',
  },
  flow_conflict: {
    kind: 'conflict',
    message:
      'a batch with this id was stored with a different number of items, or a key one of its children needs is taken',
    suggestion:
      'Reuse a batch id only to re-issue the same batch, and enqueue flow members only through the producer',
  },
  flow_missing: {
    kind: 'not_found',
    message: 'the batch record a finalizer needs is gone',
  },
  overlap_unavailable: {
    kind: 'unavailable',
    message: 'the lease store could not be reached for overlap control',
  },
  overlap_lost: {
    kind: 'unavailable',
    message: 'the job lost its overlap lease while it ran',
    suggestion:
      'Keep the lease store reachable; a handler that must not run twice also guards its writes in its own database',
  },
  invalid_schedule: {
    kind: 'internal',
    message: 'the schedule fails its {rule} check',
    context: {
      rule: [
        'shape',
        'id',
        'call',
        'options',
        'repeat',
        'interval',
        'cron',
        'cron_extension',
        'cron_day_conflict',
        'cron_never',
        'timezone',
        'overlap',
        'too_many',
      ],
    },
    suggestion:
      'A schedule id is letters and digits joined by ".", ":", "_" or "-" (at most 128 characters, starting with a letter); a schedule has exactly one of cron and everyMs; everyMs is 1 s to one year; a cron pattern has five or six fields with no L, W, # or H and restricts at most one of day-of-month and day-of-week; a time zone is an IANA name and only goes with cron; an app has at most 1,000 schedules',
  },
  duplicate_schedule: {
    kind: 'internal',
    message: 'two schedules are named {schedule}',
    context: { schedule: 'identifier' },
    suggestion: 'Give every schedule of an app its own id',
  },
  schedule_owner_mismatch: {
    kind: 'conflict',
    message: 'the schedules of this namespace were last reconciled by another app',
    suggestion:
      'Check that the app and environment name the right namespace; pass adopt: true to take the schedules over deliberately, after an app rename',
  },
  schedule_conflict: {
    kind: 'conflict',
    message:
      'other reconciles changed the schedules of this namespace every time this one tried to apply',
    suggestion:
      'Reconcile each namespace from one place at a time (the deploy step), then run the reconcile again',
  },
  missing_dependency: {
    kind: 'internal',
    message: 'the {dependency} package the jobs adapter needs is not installed',
    context: { dependency: ['bullmq'] },
    suggestion:
      'Install the package next to @jsails/jobs (npm install bullmq) to use the Valkey transport',
  },
  transport_failed: {
    kind: 'unavailable',
    message: 'the job transport could not complete the operation',
    suggestion:
      'Check that the Valkey server is reachable; the error cause carries the transport failure',
  },
  attempt_failed: {
    kind: 'internal',
    message: 'the job attempt failed and the job will be tried again',
    suggestion:
      'The attempt failure itself is reported by the jobs.failed signal; the job runs again after its backoff',
  },
  job_stalled: {
    kind: 'unavailable',
    message: 'the job lost its worker more often than the transport allows',
    suggestion:
      'A worker process stopped renewing the job lock (a crash, a blocked event loop, or a poisoned worker exiting); raise maxStalledCount only when such a job is safe to run again',
  },
} as const;

/**
 * The `jobs.*` codes. `JobsErrors.is(error, 'invalid_payload')` recognizes one
 * of them; `new JobsErrors.Error(code, context)` raises one.
 *
 * @public
 */
export const JobsErrors: ErrorRegistry<'jobs', typeof JOBS_ERRORS> = defineErrors(
  'jobs',
  JOBS_ERRORS,
);

/**
 * A code of {@link JobsErrors}, without its `jobs.` prefix.
 *
 * @public
 */
export type JobsErrorCode = keyof typeof JOBS_ERRORS;
