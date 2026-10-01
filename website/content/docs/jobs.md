---
title: Jobs
order: 18
section: Operating
---

# Background Jobs

JSails ships a provider-neutral job runtime: you define a job with a Zod schema
and a typed handler, bind the registry to a transport adapter, and drive it with
the `work` and `schedule` commands. The built-in transport is BullMQ over
Valkey/Redis, but the runtime itself never assumes a backend — a custom adapter
needs no connection URL at all.

## Defining a job

A job is a class with a static Zod schema and a typed `handle`. `ApplicationJob`
provides the job tools — `this.log`, `this.updateProgress`, `this.jobId`,
`this.attemptsMade`, `this.attemptsStarted`, `this.isFirstAttempt`, and
`this.dispatch`.

```ts
// jobs/send-email.job.ts
import { z } from 'zod';

const schema = z.object({ to: z.string(), subject: z.string() });

export default class SendEmailJob extends ApplicationJob<z.infer<typeof schema>> {
  static readonly jobName = 'sendEmail';
  static readonly schema = schema;

  async handle(data: z.infer<typeof schema>): Promise<void> {
    this.log(`send to ${data.to}`);
  }
}
```

`defineJob({ schema, handler })` remains as the inline shorthand for a simple
or test job:

```ts
import { defineJob } from 'jsails';
import { z } from 'zod';

export default defineJob({
  name: 'sendEmail',
  schema: z.object({ to: z.string() }),
  async handler(data, ctx) {
    await ctx.log(`send to ${data.to}`);
  },
});
```

### Where jobs live

The worker and the app autoload compiled modules from `jobs/`:

```text
jobs/
  send-email.job.ts             ← scanned; name sendEmail
  billing/
    send-invoice.job.ts         ← scanned; name billing.sendInvoice
  internal/
    dates.ts                    ← helper, never scanned
```

- One default-exported job class (or object) per `*.job.js` file.
- Subdirectories are scanned for `*.job.js`; helpers and tests can coexist
  without the suffix.
- `jobName` explicit, otherwise the camel-cased relative path
  (`billing/send-invoice` → `billing.sendInvoice`).
- `index.job.js`, `*.test.js`, `*.spec.js`, hidden files, and `_`-prefixed
  files are ignored.
- Duplicate names are a hard error.
- The loader sets the derived name on the class, so `SendEmailJob.dispatch(...)`
  works even when `static jobName` is omitted.

`jobs/` is autoloaded; there is no `jobs/index.ts` registry and no manual import.

## The runtime

`new JobsRuntimeImpl({ registry, adapter, queueName?, prefix?, concurrency? })`
binds the registry to a `JobsRuntimeAdapter` and owns job-level policy: payload
validation on enqueue and on processing, dispatch-option allowlisting, local
schedule validation, lazy and idempotent handles, and an idempotent `close`.

An adapter is `{ name, createProducer, createWorker, upsertSchedules? }`. When
`upsertSchedules` is absent, `runtime.upsertSchedules` throws an explicit
`JobsRuntimeError` instead of silently doing nothing. `validateJobsRuntimeAdapter`
checks an adapter's shape without invoking any factory.

`new BullMQAdapter({ redisUrl, onError?, queueFactory?, workerFactory? })` is
the built-in adapter and the default transport. A custom adapter needs **no
connection URL** — `JobsRuntimeImpl` never receives one.

## Configuring the runtime — `jsails.runtime.js`

The `work` and `schedule` commands load a compiled ESM config. The registry is
optional: when omitted, top-level job modules are autoloaded from `jobsDir`
(default `dist/jobs`, relative to the config file).

```js
// jsails.runtime.js  (default config for `work` / `schedule`)
export default {
  // Optional. Alternative to autoloading:
  // registry: createJobRegistry({ ... }),
  jobsDir: 'dist/jobs',
  // `adapter` is optional. Omit it to use the built-in BullMQ adapter, which
  // then requires a Valkey/Redis URL (valkeyUrl config key, or VALKEY_URL in
  // the environment). Supply a custom JobsRuntimeAdapter to target another
  // backend with no URL at all.
  valkeyUrl: process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379',
  schedules: [
    {
      id: 'digest',
      job: 'sendEmail',
      cron: '0 3 * * *',
      data: { to: 'ops@example.com', subject: 'digest' },
    },
  ],
  queueName: 'default',
  concurrency: 1,
  // extensions: [{ name: 'my-service', setup({ services }) { ... } }],
};
```

When `config.adapter` is present it is selected verbatim (identity preserved)
and no URL is read or validated. When it is absent, the URL is resolved
(`valkeyUrl` → `VALKEY_URL`, and it must be `redis://` or `rediss://`) and the
built-in `BullMQAdapter` is constructed from it — lazily, so no connection
opens at import.

The web process mounts the jobs plugin for dispatching. It autoloads the same
`dist/jobs` directory by default:

```js
// jsails.app.js
plugins: {
  use: [['jsails/jobs', { jobsDir: 'dist/jobs' }]],
}
```

`config.extensions` is an optional array of extension objects
(`{ name, setup({ services, configureHttp, configureMiddleware }) }`).
When declared, `work` and `schedule` run them through `runExtensions`, build a
`ServiceRegistry`, and open an ambient app scope (`withAppScope`) around every
processed job — handler and per-job middleware — so `facade()` calls resolve.
When `extensions` is absent or empty, no scope is opened and facades throw
`FacadeError('no_app_scope')` exactly as before. Extensions are closed on
teardown; the registry is borrowed by the runtime, never owned or closed by it.

## Schedules

Each schedule spec is `{ id, job, cron | interval | intervalMs, timezone?, data? }`
— exactly one of `cron`, `interval`, or `intervalMs` — and is validated locally
before any provider call.
Queue defaults are 3 attempts with exponential backoff (1000 ms); `MAX_ATTEMPTS`
is 25.

Scheduling is at-least-once. The runtime does not guarantee exactly-once
delivery, non-overlap, or catch-up, so make your handlers idempotent.

### The schedules file

Schedules are pure data, so the canonical file is JSON:

```json
[
  {
    "id": "digest",
    "job": "sendDigest",
    "cron": "0 3 * * *",
    "timezone": "UTC",
    "overlap": true,
    "description": "Nightly digest"
  },
  {
    "id": "poll",
    "job": "pollFeed",
    "interval": "@every_5_seconds",
    "overlap": true
  }
]
```

Save it as `jsails.schedules.json` next to `jsails.runtime.js`. When the runtime
config omits `schedules`, the loader auto-loads that one file; there is no
directory scan and no second convention. An explicit `schedules` array in
`jsails.runtime.js` always wins, which is the escape hatch for computed or
environment-specific schedules.

Each entry is a `ScheduleDefinition`:

- exactly one of `cron`, `interval`, or `intervalMs`;
- `cron` is a standard pattern or alias (`@minutely`, `@hourly`, `@daily`,
  `@weekly`, `@monthly`, `@yearly`);
- `interval` is a text interval alias such as `@every_3_minutes`; it always
  resolves to `intervalMs` and cannot carry a `timezone`;
- `intervalMs` is a raw elapsed interval in milliseconds;
- `timezone` is IANA and only valid with `cron`;
- `overlap` is `true` or `{ "key": "...", "ttlMs": 60000 }`;
- `data` is the job payload, validated against the job schema;
- `description` is a human-readable label shown by `jsails schedules`.

JSON is deliberate: the file cannot execute code, parses with the built-in
`JSON.parse`, has no YAML type coercion, and is easy for tools and agents to
generate and validate. Use inline `schedules` in `jsails.runtime.js` only when
a schedule must be computed.

### Cron aliases

The provider accepts the standard aliases:

| Alias | Meaning |
|---|---|
| `@minutely` | every minute |
| `@hourly` | top of every hour |
| `@daily` | midnight |
| `@weekly` | Sunday midnight |
| `@monthly` | 1st of the month |
| `@yearly` / `@annually` | January 1st |

Not supported: `@every_minute`, `@midnight`, `@reboot`, and free text like
`"every day at 3am"`. Use a cron pattern or an inline JS schedule if you need
computed cadence.

### Text interval aliases

The `interval` field accepts `@every_<n>_<unit>`:

| Text alias | Resolves to |
|---|---|
| `@every_5_seconds` | `intervalMs: 5000` |
| `@every_3_minutes` | `intervalMs: 180000` |
| `@every_7_minutes` | `intervalMs: 420000` |
| `@every_2_hours` | `intervalMs: 7200000` |
| `@every_5_hours` | `intervalMs: 18000000` |
| `@every_2_days` | `intervalMs: 172800000` |
| `@every_2_weeks` | `intervalMs: 1209600000` |

Units are `second`, `minute`, `hour`, `day`, or `week` (singular or plural).
These are **elapsed intervals**, not calendar schedules: `@every_2_hours` runs
two hours after registration, not at every even hour. `@every_60_minutes` is a
one-hour interval; use `@hourly` for the top of each hour. Months are rejected
because calendar months vary. `interval` cannot carry a `timezone`; use `cron`
for clock/calendar alignment.

Step patterns cover the common clock-aligned “every N minutes/hours” cases:

| Intent | `cron` |
|---|---|
| every 2 minutes | `*/2 * * * *` |
| every 3 minutes | `*/3 * * * *` |
| every 5 minutes | `*/5 * * * *` |
| every 10 minutes | `*/10 * * * *` |
| every 15 minutes | `*/15 * * * *` |
| every 30 minutes | `*/30 * * * *` |
| every 2 hours | `0 */2 * * *` |
| every 3 hours | `0 */3 * * *` |
| every 4 hours | `0 */4 * * *` |
| every 6 hours | `0 */6 * * *` |
| every 8 hours | `0 */8 * * *` |
| every 12 hours | `0 */12 * * *` |

`*/n` means “every n-th value of that field”, not a rolling elapsed interval.
It is exact when `n` divides the field’s range (3 divides 60 minutes; 2, 3, 4,
6, 8, and 12 divide 24 hours). For a cadence that does not divide evenly — every
7 minutes, every 5 hours, every 2 days — use `interval`/`intervalMs` if the
exact elapsed interval matters, or accept the cron boundary behavior.

## Scheduling a CLI command

The scheduler's unit is a job, not a CLI command. That is deliberate: a worker
has no terminal, no prompts, and no app-config command registry. Reuse command
logic through an explicit adapter:

```ts
import { defineCommandJob } from 'jsails/jobs';
import { reportsCommand } from './commands/reports.js';

const reports = defineCommandJob(reportsCommand, {
  args: ['--force'],
  cwd: process.cwd(),
  configPath: 'jsails.runtime.js',
});

export default {
  registry: createJobRegistry({ reports }),
  schedules: [{ id: 'reports', job: 'reports', cron: '0 3 * * *' }],
};
```

- The command runs with `interactive: false`; a prompt fails the job instead of
  blocking a worker.
- `stdout` / `stderr` become job log lines by default; pass `stdout` / `stderr`
  callbacks to redirect them.
- A non-zero exit code throws a value-free `CommandJobError` (`command_exit`);
  a thrown command throws `command_threw`. The transport applies the normal
  retry policy.
- The job payload is `{ args?: string[] }`; scheduled `data.args` overrides the
  fixed `args`.
- `name` defaults to the command name. Register the returned definition under a
  registry key and schedule that key, as with any other job.

This keeps the scheduler provider-neutral and serializable. A command that
should be scheduled is a command plus a job adapter, not a second execution
path inside the worker.

## Running jobs

```sh
jsails work --config jsails.runtime.js      # worker + schedule registration
jsails schedule --config jsails.runtime.js  # one-shot registration, then exit
```

`work` starts a worker and registers schedules; `schedule` performs a one-shot
registration and exits. Both drive the selected adapter through the same neutral
contract, not a separate built-in path.

`queue` is a **read-only** dashboard over the same runtime config. It builds the
neutral runtime, reads the queue's normalized metrics
(`waiting`/`active`/`completed`/`failed`/`delayed`) through the producer's
optional `readCounts` capability, and prints them. It never starts a worker,
registers schedules, or dispatches a job; a transport without a countable queue
fails with a value-free error rather than printing zeros.

```sh
jsails queue --config jsails.runtime.js
jsails queue --json --config jsails.runtime.js
```

## Metrics and failed jobs

`new InMemoryJobMetrics(options?)` builds an in-memory aggregator that measures
completed and failed jobs by name via `snapshot()` and can `reset()` on its own
cadence. `recordCompleted` and `recordFailed` are synchronous; errors carry only
the message, never a payload or stack trace.

`new InMemoryFailedJobStore(options?)` holds a bounded ring buffer of value-free
`FailedJobEntry` records. `retry(id, dispatch)` calls an injected dispatch
function and removes the entry on success; on failure the entry stays. Both are
pure in-memory data structures with no external service dependency.

## Job middleware, chaining, and batching

`jsails/jobs` provides three built-in composition patterns — middleware,
chaining, and batching — that run on top of the neutral job runtime. All three
are **worker-side only**: they compose around the handler after payload
validation, and dispatch options carry the control descriptors.

### Per-job middleware

`composeMiddleware` wraps the handler with `JobMiddleware` functions registered
per job name via `new JobsRuntimeImpl({ middleware: { [jobName]: [mw, ...] } })`.
Middleware runs in declared order outermost-first on the worker; `next()` is
callable at most once, and returning without `next()` short-circuits the chain.
Errors propagate as `JobMiddlewareError` (codes `invalid_middleware` /
`middleware_threw`).

```js
// No import: these are projected globals in app code (see conventions.md).

const loggingMiddleware = async (ctx, next) => {
  console.log(`starting ${ctx.name} (${ctx.jobId})`);
  await next();
  console.log(`finished ${ctx.name}`);
};

const runtime = new JobsRuntimeImpl({
  registry,
  adapter,
  middleware: { sendEmail: [loggingMiddleware] },
});
```

### Chaining

`createJobChain(runtime, steps)` builds a sequential pipeline: the
`chainMiddleware`, registered on every chained job, enqueues step N+1 only after
step N's handler succeeds. The chain descriptor rides in dispatch options under
the reserved `CHAIN_OPTION_KEY`. Chaining is at-least-once: a retried step
re-runs the handler and continues on success — handlers must be idempotent.
`JobChainError` (codes `empty_chain` / `invalid_step`) rejects a malformed chain.

```js
// No import: these are projected globals in app code (see conventions.md).

const runtime = new JobsRuntimeImpl({
  registry,
  adapter,
  middleware: { stepA: [chainMiddleware], stepB: [chainMiddleware], stepC: [chainMiddleware] },
});

const chain = createJobChain(runtime, [
  { job: 'stepA', data: { file: 'report.csv' } },
  { job: 'stepB', data: {} },
  { job: 'stepC', data: {} },
]);
await chain.dispatch();
```

### Batching

`createJobBatch(runtime, coordinator, items, callbacks?)` fans out N jobs, each
carrying a `BatchDescriptor` under the reserved `BATCH_OPTION_KEY`. The per-job
`createBatchMiddleware(coordinator)` records every item's outcome into an
**injectable** `BatchCoordinator`; when all items settle, `then` (all ok) /
`catch` (any failed) / `finally` (always) fire once, in that order. Recording
is idempotent per item index; settlement is single-fire; callback errors are
swallowed. `JobBatchError` (codes `empty_batch` / `invalid_item`) rejects a
malformed batch.

```js
// No import: these are projected globals in app code (see conventions.md).

const coordinator = new InMemoryBatchCoordinator();

const runtime = new JobsRuntimeImpl({
  registry,
  adapter,
  middleware: { processItem: [createBatchMiddleware(coordinator)] },
});

const batch = await createJobBatch(
  runtime,
  coordinator,
  [
    { job: 'processItem', data: { id: 1 } },
    { job: 'processItem', data: { id: 2 } },
  ],
  {
    then: (summary) => console.log('all done', summary),
    catch: (failed) => console.error('some failed', failed),
  },
);
```

The built-in coordinator is in-process. A deployment with separate producer and worker processes must supply a coordinator backed by shared storage, or callbacks will not fire.

## Task scheduling and overlap control

`jsails/jobs` provides a `ScheduleDefinition.overlap` option to prevent
concurrent runs of the same scheduled job. The overlap descriptor rides in the
scheduled job's dispatch options under the reserved `OVERLAP_OPTION_KEY`.

The runtime enforces it automatically when you pass a mutex store:

```js
import { ValkeyMutexStore } from '@jsails/cache';

export default {
  registry,
  valkeyUrl: process.env.VALKEY_URL,
  overlapMutex: new ValkeyMutexStore({ valkeyUrl: process.env.VALKEY_URL }),
  schedules: [{ id: 'digest', job: 'sendDigest', cron: '0 3 * * *', overlap: true }],
};
```

A custom runtime uses `new JobsRuntimeImpl({ registry, adapter, overlapMutex: mutex })`.
`createOverlapMiddleware(mutex)` remains available for a custom runtime or an
explicit per-job middleware stack; when `overlapMutex` is set the runtime detects
an already-registered overlap middleware and does not wrap twice.

The caller owns the store; the runtime never closes it.

The mutex store itself lives in `@jsails/cache`. It is a separate contract from
`CacheStore`: a cache is pure data whose `set` always overwrites, while a mutex
needs an atomic "acquire only when absent" operation. Two stores ship:
`MemoryMutexStore` (single-process; in-memory `Map` with expiry) and
`ValkeyMutexStore` (multi-process via atomic `SET NX PX`).

```js
// No import: these are projected globals in app code (see conventions.md).

const mutex = new MemoryMutexStore();

const runtime = new JobsRuntimeImpl({
  registry,
  adapter,
  overlapMutex: mutex,
  schedules: [{ id: 'digest', job: 'sendDigest', cron: '0 3 * * *', overlap: true }],
});

// Read-only schedule list — names and metadata only, never payloads or data.
const schedules = await runtime.listSchedules();

// Pause the named schedules (removes their repeatable jobs from the provider).
await runtime.pauseSchedules(['digest']);
```

Two limits are worth noting:

- Pause is non-durable by default. `pauseSchedules` removes the repeatable job, but the next `work` start re-registers every schedule from config through `upsertSchedules`, so a paused schedule resumes automatically on process restart. There is no separate `resumeSchedules` call — resume by re-calling `upsertSchedules`.
- The memory mutex works only within a single process. Competing workers each have their own in-memory map and cannot see each other's locks. Use `ValkeyMutexStore` for multi-process deployments.

## Next steps

- [Testing](/docs/testing) — the in-process `createTestApp` surface and the native
  `node:test` suite.
- [CLI](/docs/cli) — `work`, `schedule`, and `queue` commands.
