---
title: Jobs
order: 18
section: Operating
---

# Background Jobs

JSails ships a provider-neutral job runtime: you define a job with a Zod schema
and a typed handler, bind the registry to a transport adapter, and drive it with
the `work` and `schedule` commands. The built-in transport is BullMQ over
Valkey, but the runtime itself never assumes a backend — a custom adapter
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
- `jobName` explicit, otherwise the relative path with each segment in
  camelCase (`billing/send-invoice` → `billing.sendInvoice`).
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

Every attempt runs in the execution context its dispatch carried (see
[Observability](/docs/observability#execution-context)): the dispatcher's
request id, a child span of its trace, its locale, and its tenant (see
[Tenancy](/docs/tenancy)). A job dispatched inside a request for tenant 1 runs
for tenant 1, on its first run and on every retry; a job dispatched with no
tenant runs with none, whichever context the worker happens to start it from
(a request whose dispatch pumped an in-process queue, the previous job). Only
the tenant id travels: a job dispatched inside `withoutTenantScope` does not
inherit the opt-out (a cross-tenant job calls `withoutTenantScope` in its
handler). A job dispatched with no tenant that works for one carries the id in
its payload and sets it in the handler:

```ts
import { defineJob } from 'jsails';
import { runWithTenant } from 'jsails/database';
import { z } from 'zod';

export default defineJob({
  name: 'tenantReport',
  schema: z.object({ tenantId: z.number() }),
  async handler(data) {
    await runWithTenant(data.tenantId, async () => {
      const projects = await Project.find();
      // ...
    });
  },
});
```

`new BullMQAdapter({ connections, onError?, removeOnComplete?, removeOnFail?, queueFactory?, workerFactory? })`
is the built-in adapter and the default transport. `connections` is the app's
Valkey connection provider (`valkeyToken` in `jsails/plugin-sdk`): producers
share its `command` connection, and each worker gets a dedicated `queue`
connection. A custom adapter needs **no
connection URL** — `JobsRuntimeImpl` never receives one.

### Retention, timeouts, and failures

- **Retention.** Finished jobs are trimmed by default: completed jobs are kept
  for one hour (at most 1000), failed jobs for seven days (at most 5000). The
  defaults apply to every queue, dispatch, and scheduled tick. Override them per
  queue with `removeOnComplete` / `removeOnFail` on `BullMQAdapter`, on
  `jsails.runtime.js`, or on `jobsPlugin(...)`, or per dispatch with the same
  option names. A value is `true` (remove at once), `false` (keep forever), a
  count, `{ count }`, or `{ age, count?, limit? }` (age in seconds); anything
  else is rejected. `keepLogs`, `stackTraceLimit` (at most 50), and `sizeLimit`
  are validated too.
- **Timeouts.** `defineJob({ ..., timeoutMs })`, `static timeoutMs` on an
  `ApplicationJob`, or the runtime-wide `jobTimeoutMs` bounds each attempt. An
  attempt past its timeout fails with `JobTimeoutError` (`timed_out`) and is
  retried like any other failure. The handler's `context.signal` (or
  `this.signal`) is aborted at the same moment: pass it to `fetch` and database
  calls so the abandoned work stops, since JavaScript cannot kill a running
  function. Middleware sees the same signal as `context.signal`; an overlap
  lock held by a timed-out attempt is not released (the handler may still be
  running) and expires after its `ttlMs` instead.
- **Request correlation.** A job dispatched while an HTTP request is being
  handled carries that request's `X-Request-Id` and trace in its context
  carrier. The handler reads the id as `context.requestId`
  (`this.context.requestId` in an `ApplicationJob`), and
  `currentContext()?.requestId` returns it for the whole run, so the job's logs
  and the jobs it dispatches carry the same id and trace. A job dispatched
  outside a request has no id and runs with none, even when the worker starts
  it while another request's job is in flight. A carrier that does not restore
  (malformed, or written by a newer carrier version) fails the job terminally
  with `context.invalid_carrier`, `context.invalid_value`, or
  `context.unsupported_carrier` before the handler runs (see
  [Observability](/docs/observability#execution-context)).
- **Shutdown.** `close()` lets in-flight jobs drain for `shutdownTimeoutMs`
  (default 30 s), then aborts their signals, and the worker stops instead of
  waiting on a hung handler. An attempt aborted this way is not a job failure:
  `onError.retryOn` and `discardOn` never see it, it emits no `jobFailed`,
  calls no `onJobFailed`, is never final for a batch, and is not recorded in
  the failed-job history. The adapter puts the job back in its queue without
  counting the attempt, so it runs again in full on the next worker, even when
  it was on its last attempt. The BullMQ adapter moves it back to the wait
  list under its lock; if that move fails, BullMQ's stalled-job check returns
  it instead. The processor rejects with an error for which
  `isJobAttemptInterrupted(error)` is true, and a custom adapter must requeue
  such a job the same way.
- **Terminal failures.** An unknown job name, an invalid payload, an error for
  which `onError.retryOn` returns `false`, and a thrown `UnrecoverableJobError`
  (or BullMQ's own `UnrecoverableError`) fail the job at once: the remaining attempts are not spent. (Before this,
  `retryOn` returning `false` only skipped the retry signal.) A custom adapter
  reads this with `isJobErrorNonRetryable(error)`.
- **Failure reporting.** Every failed attempt emits `jobFailed` with
  `final` and an `error` summary (`name`, `code`, message truncated to 500
  characters — never the payload or the stack), and `jobRetried` when another
  attempt will follow. The runtime also logs one line per failed attempt to
  stderr; pass `onJobFailed: (failure) => ...` to route it elsewhere, or
  `onJobFailed: false` to silence it. `jobPushed` carries the provider's job id.
  A job that fails for the last time is also recorded in the optional
  `failedJobs` history (see [Failed-job history](#failed-job-history)).

## The worker — `jobsPlugin` in the app config

The worker is part of the application. `jobsPlugin(...)` in `jsails.app.js`
gives the web process its dispatch service and registers two lifecycle units:
`jobs.producer` (web and worker roles; its drain closes the dispatch runtime
after the HTTP server stopped taking requests) and `jobs.worker` (worker role).
`jsails work` creates the application for the worker role and starts its
units, so job handlers run with the same plugins and services as the web
process (facades resolve, `services.get(...)` works).

```js
// jsails.app.js
import { jobsPlugin } from 'jsails/jobs';

export default {
  extensions: [
    jobsPlugin({
      jobsDir: 'dist/jobs', // default; relative to the app root
      // adapter: a custom JobsRuntimeAdapter; omit it for BullMQ over the
      // app's Valkey (valkeyPlugin, or VALKEY_URL).
      schedules: [
        {
          id: 'digest',
          job: 'sendEmail',
          cron: '0 3 * * *',
          data: { to: 'ops@example.com', subject: 'digest' },
        },
      ],
      concurrency: 1,
      // Optional: finished-job retention (defaults shown) and execution bounds.
      // removeOnComplete: { age: 3600, count: 1000 },
      // removeOnFail: { age: 604800, count: 5000 },
      // jobTimeoutMs: 600000,
      // shutdownTimeoutMs: 30000,
      // overlapLeases, failedJobs: see below.
    }),
  ],
};
```

Starting `jobs.worker` registers the declared `schedules` (else the app root's
`jsails.schedules.json`) without pruning, then starts processing. Its drain lets in-flight jobs finish within the plugin's
`shutdownTimeoutMs` (default 30 s), inside the application's own
`shutdownTimeoutMs` deadline; when that deadline passes, or a second SIGINT or
SIGTERM arrives, the unit is aborted: in-flight attempts go back to their queue
without spending an attempt (see Shutdown above).

Both units declare the adapter's **reach** on the `jobs` transport. The
in-memory adapter's is `process`: a job dispatched there only reaches a worker
of the same adapter instance in the same process, so the kernel refuses a
process that runs only the web role or only the worker role over it
(`kernel.adapter_not_shared`), instead of losing every job. Run both roles in
one process with `jsails serve --with worker`, or use the BullMQ adapter
(reach `shared`). A custom adapter declares `reach` itself; one that does not is
not checked.

## The runtime config — `jsails.runtime.js`

The inspection and maintenance commands (`schedule`, `queue`, `schedules`,
`queue:failed`, `queue:retry`, `queue:forget`, and `console --runtime-config`)
load a compiled ESM runtime config. It opens no plugin. The registry is
optional: when omitted, every `*.job.js` module under `jobsDir` (default
`dist/jobs`, relative to the config file; subdirectories included) is
autoloaded.

```js
// jsails.runtime.js
export default {
  // Optional. Alternative to autoloading:
  // registry: createJobRegistry({ ... }),
  jobsDir: 'dist/jobs',
  // `adapter` is optional. Omit it to use the built-in BullMQ adapter, which
  // then requires a Valkey URL (valkeyUrl config key, or VALKEY_URL in
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
  // prefix: 'my-app:production', // default: <package.json name>:<mode>
  // Optional: the failed-job history `jsails queue:failed` reads (see below).
  // failedJobs: createDatabaseFailedJobHistory({ getDataSource: () => dataSource }),
};
```

When `config.adapter` is present it is selected verbatim (identity preserved)
and no URL is read or validated. When it is absent, the URL is resolved
(`valkeyUrl` → `VALKEY_URL`, and it must be `redis://` or `rediss://`) and the
built-in `BullMQAdapter` is constructed from it — lazily, so no connection
opens at import. An `extensions` key is refused (`invalid_config`): plugins,
and the worker, live in the app config.

## Schedules

Each schedule spec is `{ id, job, cron | interval | intervalMs, timezone?, data? }`
— exactly one of `cron`, `interval`, or `intervalMs` — and the whole list,
cron patterns included, is validated locally before any provider call, so one
bad entry never leaves a half-registered list.

Registration reconciles: after upserting the declared schedules,
`upsertSchedules` removes provider schedules whose ids are no longer declared,
so a renamed or deleted schedule stops firing after the next
`jsails schedule` run (`work` registers with `prune: false`). Pass `upsertSchedules(list, { prune: false })` when a caller
registers only part of a queue's schedules. Pruning needs an adapter that can
list and remove schedules (the built-in one can).
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

Save it as `jsails.schedules.json` next to `jsails.runtime.js`, in the app
root. When the runtime config omits `schedules`, the loader auto-loads that one
file, and so does `jobsPlugin`'s worker when its `schedules` option is omitted;
there is no directory scan and no second convention. An explicit `schedules`
array always wins, which is the escape hatch for computed or
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

Step patterns cover the common clock-aligned "every N minutes/hours" cases:

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

`*/n` means "every n-th value of that field", not a rolling elapsed interval.
It is exact when `n` divides the field's range (3 divides 60 minutes; 2, 3, 4,
6, 8, and 12 divide 24 hours). For a cadence that does not divide evenly — every
7 minutes, every 5 hours, every 2 days — use `interval`/`intervalMs` if the
exact elapsed interval matters, or accept the cron boundary behavior.

## Scheduling a CLI command

The scheduler's unit is a job, not a CLI command. That is deliberate: a worker
has no terminal and no prompts. Reuse command
logic through an explicit adapter:

```ts
import { defineCommand } from 'jsails';
import { createJobRegistry, defineCommandJob } from 'jsails/jobs';

// The command `jsails reports` runs, usually imported from commands/reports.ts.
const reportsCommand = defineCommand({
  summary: 'Rebuild the nightly reports',
  options: { force: { type: 'boolean', summary: 'Rebuild reports that are current' } },
  needs: 'environment',
  run(context) {
    context.stdout(context.values.force === true ? 'rebuilding all' : 'rebuilding stale');
  },
});

const reports = defineCommandJob(reportsCommand, { name: 'reports', args: ['--force'] });

export default {
  registry: createJobRegistry({ reports }),
  schedules: [{ id: 'reports', job: 'reports', cron: '0 3 * * *' }],
};
```

- The command is a `defineCommand` value that needs only the environment
  (`invalid_command` otherwise): the worker has already assembled its app, so
  there is no stage to open. Its arguments are parsed against its own options,
  as the CLI does; a usage error throws `command_usage`.
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
jsails work                                 # the app's worker role (jsails.app.js)
jsails serve --with worker                  # web and worker roles in one process
jsails schedule --config jsails.runtime.js  # one-shot registration, then exit
```

`work` creates the application for the worker role and starts its units:
`jobsPlugin`'s worker registers the declared schedules without removing any. An
app that registers no unit for the worker role fails with `kernel.no_units`.
The first SIGINT or SIGTERM drains under the app's `shutdownTimeoutMs`; a
second one aborts what is still draining. `schedule` performs a one-shot
registration that also removes provider
schedules no longer declared, then exits. Only `schedule` prunes, because during
a rolling deploy a worker of the previous release can start after the new
release registered its schedules, and pruning on worker start would delete
them: run `jsails schedule` once per release instead, after the previous
release's workers have stopped. Until then, a worker of the previous release
that starts still writes its own definitions: it puts back a schedule the new
release removed, and overwrites one the new release changed (its cron, interval
or data) with the old definition. Running `jsails schedule` after the rollout
restores the new release's set. Nothing runs it for you: neither `jsails work`
nor `jamal deploy` does. Both drive the selected
adapter through the same neutral contract, not a separate built-in path.
`schedule` reconciles even when the config declares no schedules, so deleting
the last schedule removes it from the queue (and connects to the transport to
do so); an adapter without scheduling support is only asked when schedules are
declared.

The queue's Valkey key prefix defaults to `<package.json name>:<mode>`, with
characters outside `[A-Za-z0-9._-]` replaced, where the mode is `NODE_ENV`
when it is `development` or `test` and `production` otherwise (unset
included), so two apps sharing a Valkey never consume each other's jobs. A
staging deployment runs in the `production` mode: when it shares a Valkey with
production, give it its own `prefix`. The
runtime config looks the name up from its own directory upwards and the `jobs`
plugin from the app root upwards, never from the working directory. The web
process and the worker both run `jobsPlugin`, so they always agree; set
`prefix` in both `jobsPlugin({ prefix })` and the runtime config to choose one
explicitly, so the inspection commands read the same queue.

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
completed and failed jobs by name. `snapshot()` returns the per-job summary and
clears the counters; `peek()` returns the same summary without clearing them, so
a dashboard and an exporter can share one collector. `reset()` clears on the
consumer's own cadence. `recordCompleted` and `recordFailed` are synchronous; errors carry only
the message, never a payload or stack trace.

`new InMemoryFailedJobStore(options?)` holds a bounded ring buffer of value-free
`FailedJobEntry` records. `retry(id, dispatch)` takes the entry out before it
calls the injected dispatch function, so two concurrent retries cannot both
send it, and puts it back when the dispatch fails. Both are
pure in-memory data structures with no external service dependency.

## Failed-job history

A job that fails for the last time, because its attempts are spent or its error
is non-retryable, can be recorded in a **failed-job history**. You can then list
it, retry it, or forget it from the CLI. Retried attempts are not recorded, and
neither is a job that later succeeds. No history is kept unless
`jobsPlugin({ failedJobs })` sets one for the worker; the CLI reads the
runtime config's `failedJobs`, so set the same history in both. The plugin
never closes the history it is given; `jsails schedule` and the `queue:*`
commands close the runtime config's.

Each entry holds an id, the queue, the job name, the payload as the worker
received it, the attempt count, the failure time, the originating request id
and monitoring tags (when there were any), the dispatch options a retry replays
(`attempts`, `backoff`, `priority`, `lifo`, and the retention options; never
`delay` or `jobId`), whether the job ran as a chain step or a batch member, and
the error summary the runtime already reports: class,
`code`, and the message truncated to 500 characters. Stacks and causes are never
stored. **The payload is stored as given, without redaction.** Keep secrets out
of job payloads: pass an id, and load the secret inside the handler.

### Storing the history in the database

The database history writes one row per failure to the framework-owned
`jsails_failed_job` table. Add `failedJobEntities` to your data source, so that
`db:push` creates the table like any other declared model:

```js
// jsails.database.js
import { JsailsDataSource } from 'jsails/database';
import { failedJobEntities } from 'jsails/jobs';

export default new JsailsDataSource({
  // ...connection options
  entities: [/* your models */, ...failedJobEntities],
});
```

```js
// failed-jobs.js, imported by jsails.app.js (jobsPlugin({ failedJobs }))
// and by jsails.runtime.js (failedJobs)
import { createDatabaseFailedJobHistory } from 'jsails/jobs';
import dataSource from './jsails.database.js';

export const failedJobs = createDatabaseFailedJobHistory({ getDataSource: () => dataSource });
```

`getDataSource` connects on first use, so importing the config opens no
connection, and `close()` destroys the connection again. A `dataSource` passed
directly must already be initialized, and the history leaves it open. If the
table is missing, the history fails with `FailedJobHistoryError`
(`missing_table`); it never creates the table. A payload that cannot be
serialized to JSON is stored as `null`. The failure itself is still recorded,
but a retry of that entry fails payload validation. Monitoring tags, the
replayed dispatch options, and the chain/batch membership are stored in
nullable JSON columns (`tags`, `dispatchOptions`, `membership`), so a retried
job keeps them; run `db:push` after upgrading to add the two newer columns.

If the history rejects a record (the database is down, say), the worker logs
one line to stderr. The job still fails with its own error, and the transport
handles it as usual.

### Keeping the history in memory

`new InMemoryFailedJobHistory({ maxEntries?, maxAgeMs? })` keeps entries in
memory, up to 1000 by default, evicting the oldest first. Its `store` is an
`InMemoryFailedJobStore`, so the same entries can feed the jobs dashboard.
Memory is per process: the entries vanish on restart, and a separate
`jsails queue:*` process cannot see them. Use the memory history for tests and
single-process tools.

### The CLI

```sh
jsails queue:failed [--queue <name>] [--limit <n>] [--json]
jsails queue:retry <id...> | --all [--queue <name>] [--json]
jsails queue:forget <id...> | --all [--queue <name>] [--json]
```

All three read `failedJobs` from `jsails.runtime.js` (or the file given with
`--config` / `-c`). If no history is configured, they fail with an error that says so.

- `queue:failed` lists entries newest first: 50 by default, at most 1000. It
  never prints payloads, in either format.
- `queue:retry` first claims each entry, removing it from the history so a
  second `queue:retry` running at the same time finds nothing to send, then
  re-dispatches its job and payload to the queue it was recorded on with the
  recorded dispatch options and tags. It uses the same runtime and adapter as
  `work`, so the payload is validated again. A dispatch that fails puts the
  entry back (in `--json`, under `failed` with `restoredAs`); if putting it back
  fails too, the command says the entry is no longer in the history (in
  `--json`, `restoreFailure`). With `--all`, the command first collects the ids
  of every entry present when it starts, then retries them oldest first. A job
  that fails again during the run is recorded under a new id and waits for the
  next run, so a job that keeps failing cannot loop the command. A retried job
  still runs at least once, so handlers must be idempotent.
- A retry cannot rejoin a chain or batch. A chain step is retried alone (the
  steps after it are not dispatched) and a batch member is retried outside its
  batch (the batch's callbacks do not run for it). `queue:failed` marks such
  entries `in=chain` or `in=batch`, and `queue:retry` prints a note for each
  one it sent (in `--json`, under `detached`).
- `queue:forget` deletes entries without running them. `--all` deletes every
  entry, or every entry of one `--queue`.

The commands exit with 1 when any id was not found or could not be retried, and
with 2 on a usage error.

In code, `retryFailedJob(history, id, dispatch)` does the same retry as
`queue:retry`: it claims the entry with `take`, dispatches it, and puts it back
with `restore` when the dispatch fails. It rejects with `FailedJobNotFoundError`
when the entry is gone (or another retry claimed it) and otherwise resolves
`{ status: 'dispatched', entry }`, `{ status: 'restored', entry, dispatchError }`
(the entry is back, possibly under a new id), or
`{ status: 'lost', entry, dispatchError, restoreError }`. A custom backend
implements `FailedJobHistory`: `record`, `list`, `get`, `remove`, `take`,
`restore`, `clear`, and optionally `close`. `take(id)` removes and returns an
entry, and when several callers take one id at once only the one whose removal
took effect receives it. Its `list` takes `{ queue?, limit?, beforeId? }` and returns entries
newest first; `beforeId` returns only entries recorded before that id, so ids
must increase with recording order.

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
`duplicate_next`).

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

A failure is recorded only on an item's final attempt, so an item that fails
once and succeeds on a retry counts as a success, and the batch never settles
while a retry is pending.

`InMemoryBatchCoordinator` is in-process (an unsettled batch is dropped after
`ttlMs`, default one day). A deployment with separate producer and worker
processes uses `new SharedBatchCoordinator(cache)`, typically a namespace of
the app cache (`services.get(cacheToken).cache('batches')`). Each item is
recorded with one atomic `add` of its own key, so concurrent workers never lose
an update and a redelivered item is counted once; the process that created the
batch counts the recorded items with `getMany` and polls the shared progress
(`pollIntervalMs`, default 1 s) so its callbacks fire even when only workers
record. The store is a cache, so give batches one with room: an evicted record
leaves its batch unsettled until the TTL. Batch callbacks run with no ambient
tenant. Its `register` resolves once the batch is stored and rejects when the
store write fails, so the batch's `dispatch()` rejects without sending a job. A
background write that fails (a record, a removal) goes to the `onError` option,
which by default logs one value-free line, and never becomes an unhandled
rejection.

## Task scheduling and overlap control

`jsails/jobs` provides a `ScheduleDefinition.overlap` option to prevent
concurrent runs of the same scheduled job. The overlap descriptor rides in the
scheduled job's dispatch options under the reserved `OVERLAP_OPTION_KEY`.

The worker enforces it automatically when you pass a lease store as
`jobsPlugin({ overlapLeases })` (or, for a hand-built runtime, as below):

```js
import { ValkeyLeaseStore } from '@jsails/cache';
import { createValkeyConnections, defaultAppPrefix } from 'jsails/plugin-sdk';

// The leases' connections are the config's own, like the store itself.
const valkeyUrl = process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379';
const connections = createValkeyConnections(valkeyUrl, {
  // The app's default prefix: the app name above this file's directory and
  // the mode NODE_ENV gives.
  appPrefix: defaultAppPrefix(import.meta.dirname, process.env),
  name: 'jsails-work',
});

export default {
  registry,
  valkeyUrl,
  overlapLeases: new ValkeyLeaseStore({ connections }),
  schedules: [{ id: 'digest', job: 'sendDigest', cron: '0 3 * * *', overlap: true }],
};
```

A custom runtime uses `new JobsRuntimeImpl({ registry, adapter, overlapLeases: leases })`.
`createOverlapMiddleware(leases)` remains available for a custom runtime or an
explicit per-job middleware stack; when `overlapLeases` is set the runtime detects
an already-registered overlap middleware and does not wrap twice.

The caller owns the store; the runtime never closes it.

The lease store lives in `@jsails/cache` and is a separate contract from
`CacheStore`, whose entries may be evicted at any time. Two stores ship:
`MemoryLeaseStore` (single-process, never evicts a live lease) and
`ValkeyLeaseStore` (multi-process; one Lua script per operation, on a server
whose `maxmemory-policy` should be `noeviction`). The overlap middleware holds
its lease through `withLease`: it is renewed every `ttlMs / 3` while the run
lasts, so a run longer than its TTL keeps it, and it is released by its token
and fence, so a finished run never frees the lease of the run after it. A run
whose attempt was abandoned (a handler timeout) keeps its lease until the TTL
rather than let the next run overlap the one still running.

```js
// No import: these are projected globals in app code (see conventions.md).

const leases = new MemoryLeaseStore();

const runtime = new JobsRuntimeImpl({
  registry,
  adapter,
  overlapLeases: leases,
  schedules: [{ id: 'digest', job: 'sendDigest', cron: '0 3 * * *', overlap: true }],
});

// Read-only schedule list — names and metadata only, never payloads or data.
const schedules = await runtime.listSchedules();

// Pause the named schedules (removes their repeatable jobs from the provider).
await runtime.pauseSchedules(['digest']);
```

Two limits are worth noting:

- Pause is non-durable by default. `pauseSchedules` removes the repeatable job, but the next `work` start re-registers every schedule from config through `upsertSchedules`, so a paused schedule resumes automatically on process restart. There is no separate `resumeSchedules` call — resume by re-calling `upsertSchedules`.
- The memory lease store works only within a single process. Competing workers each have their own in-memory map and cannot see each other's leases. Use `ValkeyLeaseStore` for multi-process deployments.

## Running jobs without Valkey

`new MemoryJobsAdapter()` runs jobs in the current process: attempts and
backoff, terminal failures, delays, `jobId` deduplication (while that job
exists, as in BullMQ), concurrency,
pause/resume, queue counts, and interval schedules. Nothing is durable, the
producer and the worker must share the adapter instance, and cron schedules are
rejected, as is a schedule interval longer than 2147483647 ms (Node would fire
such a timer after 1 ms and run the schedule in a tight loop). A longer delay
or retry backoff is held in steps instead, so it never fires early. A job that
`close()` aborted at its drain deadline goes back to the head of the queue
without spending an attempt, for the next worker on the same adapter. It suits
development,
tests, and single-process tools;
`await adapter.drain()` resolves once every queued job has finished.

```ts
import { JobsRuntimeImpl, MemoryJobsAdapter } from 'jsails/jobs';

const adapter = new MemoryJobsAdapter();
const runtime = new JobsRuntimeImpl({ registry, adapter });
await runtime.startWorker();
await runtime.dispatch('sendEmail', { to: 'a@example.com', subject: 'hi' });
await adapter.drain();
```

To assert what code under test enqueues without running anything, provide a
dispatch recorder in place of the jobs service:

```ts
import { createFakeJobs } from 'jsails/jobs';

const jobs = createFakeJobs({ registry }); // validates like the runtime
await signUp(user, { jobs });
jobs.assertDispatched('sendEmail', (payload) => payload.to === user.email);
jobs.assertNotDispatched('chargeCard');
```

## The `@jsails/jobs` package

`jsails/jobs` moves to `@jsails/jobs`. The package already holds the new
definition API, the job envelope, declared queues, the in-memory transport,
the Valkey transport, the worker runtime, chains and batches, overlap
control, the failed-job store and schedules; `jsails work` keeps running the
old `jobsPlugin` worker described above until the package ships its plugin.

### Typed definitions and calls

`defineJob` is the one definition form. A definition's only operation is
`with(payload, options?)`, which returns an inert, typed call; nothing runs
until a `Jobs` service dispatches it. The call's payload is typed by the
schema's input, the handler receives the schema's output, and there is no
generated register or ambient dispatcher.

```ts
import { defineJob, type Jobs } from '@jsails/jobs';
import { z } from 'zod';

async function renderReport(id: string, format: 'pdf' | 'csv', signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return `${id}.${format}`;
}

export const SendReport = defineJob({
  name: 'reports.send',
  schema: z.object({ reportId: z.string(), format: z.enum(['pdf', 'csv']).default('pdf') }),
  queue: 'reports',
  attempts: 5,
  backoff: { type: 'exponential', delayMs: 2_000 },
  key: (payload) => `report:${payload.reportId}`,
  async handle(payload, ctx) {
    await renderReport(payload.reportId, payload.format, ctx.signal);
  },
});

export async function requestReport(jobs: Jobs, reportId: string): Promise<void> {
  await jobs.dispatch(SendReport.with({ reportId }), { delayMs: 60_000, tags: ['reports'] });
}
```

A wrong payload, an unknown option, or a queue the app does not declare is a
compile error, and the same checks run again at dispatch for untyped callers:
`jobs.dispatchByName(name, payload)` validates the payload with the job's
schema at runtime. Dispatch options are `attempts`, `backoff`, `timeoutMs`,
`priority`, `delayMs` or `runAt` (at most one year ahead), `key`,
`keyWindowMs`, and `tags`; anything else is refused with a value-free
`unknown_option` error.

### Idempotency keys

A key deduplicates every dispatch of the same key on the same queue for its
window (`keyWindowMs`, one day by default), whatever happened to the first
job: running, completed, failed, or already evicted by retention. A duplicate
dispatch enqueues nothing and returns the first job's id with
`deduplicated: true`. Any string of up to 512 characters is a key, colons and
non-ASCII text included. A definition's `key` function computes the key from
the parsed payload; a dispatch `key` overrides it.

### Declared queues

An app declares its queues once, each with its own concurrency and
retention. `default` is always present, so a definition without `queue`
always has a home; a definition whose queue is not declared is refused when
the job catalog is built.

```ts
import { createJobCatalog, defineJob, defineQueues, jobsNamespace } from '@jsails/jobs';
import { z } from 'zod';

const queues = defineQueues({
  mail: { concurrency: 10, retention: { failed: { age: '30d', count: 10_000 } } },
  reports: { concurrency: 2 },
});

const Welcome = defineJob({
  name: 'mail.welcome',
  schema: z.object({ userId: z.string() }),
  queue: 'mail',
  handle: () => undefined,
});

export const catalog = createJobCatalog({ queues, definitions: [Welcome] });
export const namespace = jobsNamespace('shop', 'production'); // 'shop:production'
```

Retention bounds settled jobs by `age` (`'500ms'`, `'30s'`, `'15m'`, `'1h'`,
`'7d'`, or milliseconds) and `count`, whichever is reached first; completed
jobs default to one hour or 1,000 jobs, failed jobs to seven days or 100,000.
The failed jobs a queue retains are its failed-job list. The namespace
`<app>:<environment>` keeps two apps, or two environments of one app, apart
on a shared transport.

### The envelope

A transport stores one framework-owned value per job, the envelope: the job
name, the payload exactly as dispatched, the resolved options, and metadata a
caller can never supply (the key and its window, tags, the serialized
execution context, the run time, the dispatch time). Every field is plain
JSON, so a payload holding a `Date`, a `Map`, `undefined` or a non-finite
number is refused at dispatch with `payload_not_json`; pass an ISO string or
a number instead and let the schema transform it in the handler. Dispatch
validates and stores a copy of the payload taken when it is called, so
changing the object afterwards changes nothing that was enqueued.

The execution context is captured at each dispatch from the ambient one
(`serializeContext()` from `jsails/context`): the request id, the trace, and
every propagating context key, the current tenant included. A context value
that cannot be encoded rejects the dispatch with its `context.*` code rather
than enqueueing a job that would run without it.

The envelope is versioned, and its decoder tells an envelope of a newer
version apart from a malformed one, so a worker of an older release can leave
the job for a newer worker instead of failing it, and a rolling deploy or a
rollback does not spend retries.

### The in-memory transport

`memoryJobs()` keeps every job in the process. It is the transport for
development and tests, and it holds the same contract a shared transport
does: windowed keys, attempt counting, retention, delays of any length, and
all four capabilities (`flows`, `failedJobs`, `schedules` and `leases`). Its
schedules fire while at least one of its workers runs, so a process that only
dispatches never fires one. Two hooks exist for tests: `redeliver(id)`
delivers a retained job again under the same id, as a shared transport does
after a lost lock, and `evictCompleted(queue)` evicts a queue's completed
jobs at once, as retention eventually would.
Delays, retry backoffs and release delays wait on `setLongTimeout` (a
repeating wait uses `setLongInterval`), which splits a wait into chunks a Node
timer can hold, so a 30-day delay fires once, after 30 days, instead of at
once. Because it is process-local, the memory transport
cannot serve a web process and a worker process that run apart.

```ts
import { setLongTimeout } from '@jsails/jobs';

const DAY_MS = 86_400_000;

const reminder = setLongTimeout(() => {
  console.log('thirty days later');
}, 30 * DAY_MS);

reminder.cancel();
```

### The Valkey transport

`valkeyJobs()` from `@jsails/jobs/valkey` is the shared transport: producers
and workers in any number of processes share one app environment's jobs on a
Valkey server, through BullMQ. `bullmq` is an optional peer, so install it
next to the package (`npm install bullmq`); importing the subpath loads
nothing, and building the adapter without BullMQ installed rejects with
`jobs.missing_dependency`.

```ts
import { createJobCatalog, createProducer, defineJob, defineQueues, jobsNamespace } from '@jsails/jobs';
import { valkeyJobs } from '@jsails/jobs/valkey';
import { createValkeyConnections } from 'jsails/plugin-sdk';
import { z } from 'zod';

const Welcome = defineJob({
  name: 'mail.welcome',
  schema: z.object({ userId: z.string() }),
  queue: 'mail',
  handle: () => undefined,
});

const queues = defineQueues({ mail: { concurrency: 10 } });
const catalog = createJobCatalog({ queues, definitions: [Welcome] });
const namespace = jobsNamespace('shop', 'production');
const connections = createValkeyConnections(process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379', {
  appPrefix: namespace,
  name: 'shop',
});

const adapter = await valkeyJobs({ connections })({ namespace, queues: queues.declarations });
export const jobs = createProducer({ catalog, adapter });
```

The options are checked when `valkeyJobs` is called, so a bad one fails at
assembly: `connections` (required: the app's Valkey provider, `valkeyToken`
or `createValkeyConnections`), `lockDurationMs` (how long a worker's lock on
a job lasts before it is renewed, 30 s by default), `maxStalledCount` (how
often a job may lose its worker, 1 by default), `scheduleSyncMs` (how often a
worker process looks for schedule changes made elsewhere, 5 s by default),
and `onError` (failures no caller awaits, value-free; a process warning by
default). Building the adapter loads BullMQ, takes the provider's `command`
connection for dispatches and scripts, and waits until every declared queue
is ready, so an unreachable server fails the app at assembly. Each worker
queue gets its own dedicated `queue`-role connection, closed with the
worker; the provider belongs to the app and is never closed by the adapter.
Every key lives under `<namespace>:jobs`.

It holds the contract the memory transport holds, with what a server-side
store adds:

- a key deduplicates on its queue for its window after the first job
  completed, failed or was evicted by retention;
- a worker renews its lock while a job runs; when a worker process dies, its
  jobs run again on another worker once their lock lapses, and a job that
  loses its worker more than `maxStalledCount` times fails for good with
  `jobs.job_stalled` (a chain step's catch fires, a batch child is counted
  failed) without running its handler again;
- what a final outcome writes besides settling the job (a chain's next step,
  a batch record, a fired catch) is written just before BullMQ settles it,
  while the lock is held; each of those writes is keyed or idempotent, so a
  crash between the two runs the job again and stores nothing twice;
- a batch that is not chunked stores every child in one transaction, or
  none: a failed enqueue leaves no child to run, and `batchStatus` does not
  report it until it is stored;
- chunked batches resume by id: a producer that dies while it enqueues a
  batch of up to 100,000 children (stored in chunks of 1,000) issues it
  again and no child runs twice; `batchStatus` costs one read at any size;
- a batch id issued again once its status expired (seven days after it
  settled) starts a new batch, whatever jobs of the earlier one the queues
  still keep;
- schedules fire in every process that runs a worker (a producer-only
  process never fires), each fire keyed, so two workers enqueue a slot once;
  a reconcile or a pause made elsewhere reaches a worker within
  `scheduleSyncMs`;
- `adapter.close()` stops every worker, one still starting included, and
  waits for every schedule fire already on its way before it closes the
  queues, so nothing it started reaches the server after it resolves.

Run Valkey with persistence (AOF) and `maxmemory-policy noeviction`, as
BullMQ requires: an evicted key is a lost job or a lost deduplication window.
The transport runs on one Valkey server (with replicas if you like); Valkey
Cluster is not supported.

### The worker runtime

`startRuntimeWorker` runs the jobs of a catalog over any adapter. The
processor it hands the adapter decodes the envelope, looks the job up,
restores the dispatcher's execution context, validates the payload again
with the worker's schema, runs the job's middleware and handler under the
attempt's abort signal, and reports exactly one outcome per attempt:

- `completed`, also when a handler resolves after its attempt was aborted
  (its effect happened, so running it again would duplicate it);
- `failed`, retryable or not, decided by the error's kind (`isRetryableKind`
  from `jsails/errors`): a refused payload, an unknown job or a malformed
  envelope fails for good, an unexpected error or a timeout is retried;
- `discarded`, when the job's `onError` returns `'discard'`;
- `released`, which spends no attempt: a shutdown, or a job this worker's
  release does not know yet (a newer envelope or context version, a name
  missing from its catalog, or a chain step or batch finalizer whose next
  step or callback names a queue missing from it, left before anything
  runs), released again after 500 ms doubling to 60 s, and failed with
  `jobs.unknown_job` (or `jobs.unknown_queue`) after ten releases.

A handler sees `ctx.actor` (`{ kind: 'system', reason: 'job:<name>' }`),
`ctx.requestId` and `ctx.trace` of the restored context (the attempt is a
child span of the dispatcher's trace), and `ctx.meta`, the envelope's
metadata without the raw context carrier.

A definition's `middleware` wraps its handler, the first entry outermost,
and the whole chain runs inside the attempt: its job stays held, under its
timeout and grace, until every part of the chain settled, also when a
middleware neither awaits nor returns `next()`. `next()` runs the rest of the
chain once and only while its middleware runs; a second call
(`jobs.middleware_next_reused`) or a later one, from a timer say
(`jobs.middleware_next_late`), runs nothing and fails the attempt. A failure
of the handler or of an inner middleware fails the attempt even when an
outer middleware resolves; a middleware may throw its own error instead, and
`onError` returning `'discard'` is how a job ends on a failure without a
retry.

```ts
import {
  createJobCatalog,
  createProducer,
  defineJob,
  defineQueues,
  MemoryJobsAdapter,
  startRuntimeWorker,
} from '@jsails/jobs';
import { z } from 'zod';

const Ping = defineJob({
  name: 'ping',
  schema: z.object({ at: z.string() }),
  timeoutMs: 10_000,
  handle: (payload, ctx) => {
    console.log(`ping ${payload.at} (attempt ${ctx.attempt})`);
  },
});

const catalog = createJobCatalog({ queues: defineQueues({}), definitions: [Ping] });
const adapter = new MemoryJobsAdapter({
  namespace: 'shop:development',
  queues: catalog.queues.declarations,
});
const jobs = createProducer({ catalog, adapter });
const worker = await startRuntimeWorker({ catalog, adapter, jobs, handlerGraceMs: 30_000 });

await jobs.dispatch(Ping.with({ at: new Date().toISOString() }));
await worker.drain({ deadlineMs: 25_000 });
jobs.close();
await adapter.close();
```

`drain()` stops fetching and waits for the attempts in flight, which can
still dispatch; with `deadlineMs` it aborts whatever still runs then.
`abort()` stops fetching, aborts every attempt, and waits at most
`abortCollectMs` (one second by default) for them to report: a cooperative
handler's job comes back released, its attempts unchanged. Both are bounded
and idempotent, and an `abort()` (or a poisoning) while a drain waits ends
that drain too, deadline or not, as soon as the abort returns.

An adapter never gives a job back while its handler still runs, so a job
never runs twice at once. A handler that ignores its abort signal for longer
than `handlerGraceMs` (30 s by default) after a timeout or a shutdown
poisons the worker: it stops fetching, releases its other attempts, and
calls `onPoisoned`. The default, `exitPoisonedProcess`, writes one line to
stderr and ends the process with exit code 75 (through the host's `SIGTERM`
handler when there is one), so its supervisor starts a fresh one; a shared
transport's lock then lapses and the stuck job is delivered again, once. A
host whose shutdown path then reports success (sets `process.exitCode` to 0
or calls `process.exit(0)`) still exits with 75; an exit code of its own that
signals a failure stands.

### Chains

`jobs.chain(steps, options?)` runs its steps one after another: each step is
enqueued once the one before it completed, or was discarded by its
`onError`. Every step, and the catch, is validated before the first one is
enqueued; a refused item rejects the call with `jobs.flow_item_refused`,
whose `item` is its index (steps first, then the catch) and whose cause is
the item's own error, and nothing is enqueued.

```ts
import { defineJob, type Jobs } from '@jsails/jobs';
import { z } from 'zod';

const Charge = defineJob({
  name: 'orders.charge',
  schema: z.object({ orderId: z.string() }),
  handle: () => undefined,
});
const Ship = defineJob({
  name: 'orders.ship',
  schema: z.object({ orderId: z.string() }),
  handle: () => undefined,
});
const Refund = defineJob({
  name: 'orders.refund',
  schema: z.object({ orderId: z.string() }),
  handle: () => undefined,
});

export async function fulfil(jobs: Jobs, orderId: string): Promise<string> {
  const handle = await jobs.chain([Charge.with({ orderId }), Ship.with({ orderId })], {
    id: `order-${orderId}`,
    catch: Refund.with({ orderId }),
  });
  return handle.chain;
}
```

The remaining steps travel in the step's envelope, so a chain survives a
producer restart and needs no transport capability. The worker builds the
next step itself, keyed `jsails:chain:<id>:<step>`, and the transport stores
it in the same operation that settles the step, so a step delivered twice
never forks the chain, a retried step continues it, and a step whose handler
completed is never failed because its next step could not be enqueued. A chain has 1 to 100 steps,
and its first envelope, which carries every later step, is at most 256 KiB
(`jobs.flow_too_large`). The chain id defaults to a random UUID.

A step that fails for good stops the chain and enqueues the catch once,
keyed `jsails:chain:<id>:catch`, in the same operation that records the
failure; its failed record is marked so. Retrying that record returns
`'not_retryable'` unless `force: true` is passed, and a forced retry
continues the chain without firing the catch again: every later step
carries the mark, however long after the first failure it fails. A step that
overlap control skipped stops the chain and fires no catch, unless its
definition says `onSkip: 'continue'`.

Chain steps, batch children and callbacks take the job options and `tags`
only: `delayMs`, `runAt`, `key` and `keyWindowMs` are refused with
`jobs.invalid_option`, because the worker builds these follow-ups and the
keys belong to the flow. Flow and schedule keys start with `jsails:`, a
prefix no dispatch key may use (`jobs.invalid_option`), so no job of the app
can take one and swallow a step, a child or a callback. A handler reads its place in a flow from
`ctx.meta.flow`: `{ kind: 'chain', id, step, remaining }` or
`{ kind: 'batch', id, index }`, never the other steps' payloads.

### Batches

`jobs.batch(items, options?)` enqueues its children together and, once every
child has a final outcome, runs `then` when none failed or `catch` when one
did, and then `finally`. Each callback runs once, keyed
`jsails:batch:<id>:<then|catch|finally>`, and lives in the transport, so it
still fires after the producer that started the batch is gone. The
finalizer hands its callbacks to the transport together, in the operation
that completes it, so a finalizer that failed enqueued none, and retrying
it, however late, enqueues each one once. `finally` is
enqueued after `then` or `catch` but does not wait for it to finish: work
that must follow `then` belongs in `then`. Batches need an adapter with the
`flows` capability (`jobs.capability_missing` otherwise).

```ts
import { defineJob, type Jobs } from '@jsails/jobs';
import { z } from 'zod';

const Resize = defineJob({
  name: 'images.resize',
  schema: z.object({ imageId: z.string() }),
  handle: () => undefined,
});
const Publish = defineJob({
  name: 'albums.publish',
  schema: z.object({ albumId: z.string() }),
  handle: () => undefined,
});
const Notify = defineJob({
  name: 'albums.notify',
  schema: z.object({ albumId: z.string() }),
  handle: () => undefined,
});

export async function processAlbum(jobs: Jobs, albumId: string, imageIds: string[]): Promise<void> {
  const batch = await jobs.batch(
    imageIds.map((imageId) => Resize.with({ imageId })),
    { id: `album-${albumId}`, then: Publish.with({ albumId }), finally: Notify.with({ albumId }) },
  );
  const status = await jobs.batchStatus(batch.id);
  console.log(`${status?.completed ?? 0} of ${batch.total} resized`);
  for (const failure of await jobs.batchFailures(batch.id, { limit: 10 })) {
    console.log(`image ${failure.index} failed: ${failure.error.code ?? failure.error.kind}`);
  }
}
```

A batch has 1 to 1,000 children, or up to 100,000 with `chunked: true`,
which lets the transport store them over several operations and therefore
needs an `id` (`jobs.invalid_flow` with rule `chunked_id`), so a call that
failed half-way can be issued again with the same id. Re-issuing an id with
the same number of children returns the first batch with
`deduplicated: true`; another number is `jobs.flow_conflict`, and so is a new
batch one of whose child keys another job holds. Every child is
validated before any is enqueued, and the callbacks are at most 256 KiB in
all. The callbacks run on the batch's `queue` (a declared queue, `default`
when omitted).

A discarded child counts as completed. A child's first final outcome is
recorded once: retrying it before the batch settled re-opens it, so the
batch waits for the retry; retrying it after the batch settled changes no
count and is counted in `retriedAfterSettlement`. `batchStatus(id)` returns
`total`, `completed`, `failed`, `skipped`, `pending`, `settled` and
`retriedAfterSettlement`, and stays readable for at least seven days after
the batch settled; `batchFailures(id, { limit })` lists the failed children
by index, at most 100 at a time.

### Overlap control

A definition's `overlap` keeps two runs with the same key from running at
once: a run whose key is held is `skipped` (reason `overlap`), spends no
attempt, and never advances a chain unless `onSkip: 'continue'`. The key is
the job name by default, a fixed string, or a function of the parsed
payload; the lease lasts `ttlMs` (1 s to 1 h, five minutes by default) and is
renewed every third of it while the attempt runs, then released before a
chain's next step is enqueued. A renewal that fails is tried again at the
next third: the lease counts as lost only when the store refuses a renewal,
or when none succeeded within `ttlMs` of the last request it confirmed.

```ts
import { defineJob } from '@jsails/jobs';
import { z } from 'zod';

export const SyncTenant = defineJob({
  name: 'tenants.sync',
  schema: z.object({ tenantId: z.string() }),
  overlap: { key: (payload) => `tenant:${payload.tenantId}`, ttlMs: 60_000 },
  onSkip: 'continue',
  handle: () => undefined,
});
```

Overlap needs an adapter with the `leases` capability: `createProducer` and
`startRuntimeWorker` refuse a catalog with an overlap job otherwise
(`jobs.capability_missing`). A lease store that cannot be reached fails the
attempt retryably with `jobs.overlap_unavailable`; a lease lost while the
handler runs aborts its signal with `jobs.overlap_lost`, with the same grace
as a timeout. Overlap is a scheduling guard, not a lock: a handler whose
writes must never interleave also guards them in its own database.

### Failed jobs

A job that failed for good stays in its transport's failed set, within the
queue's failed retention, and the adapter's `failedJobs` capability reads and
changes it. `list({ queue, limit, before })` is newest first (50 by default,
at most 1,000), and the next page starts `before` the `failedAt` and `id` of
the last entry, a cursor that still works once that job is pruned. `retry`
moves a failed job back to waiting, with the same id, envelope and a fresh
attempt count, in one atomic operation, and answers `'retried'`,
`'not_found'`, `'not_failed'` or `'not_retryable'` (a chain step whose catch
fired, without `force`).

```ts
import type { JobsAdapter } from '@jsails/jobs';

export async function retryMailFailures(adapter: JobsAdapter): Promise<number> {
  const failed = adapter.capabilities.failedJobs;
  if (failed === undefined) return 0;
  let retried = 0;
  for (const job of await failed.list({ queue: 'mail', limit: 100 })) {
    if ((await failed.retry(job.id)) === 'retried') retried += 1;
  }
  await failed.prune({ olderThanMs: 30 * 86_400_000 });
  return retried;
}
```

`get(id)` reads one, `remove(id)` deletes one, and `prune({ olderThanMs })`
deletes those that failed before then. A definition with
`onFinalFailure: 'drop'` keeps no failed record at all: the transport deletes
the job in the same operation that settles it, for a payload that must not
linger.

### Schedules

`schedule(id, call, options)` declares one recurring job, and
`reconcileSchedules(adapter, schedules, { app, by })` makes the transport's
stored schedules match the declared ones: it validates every schedule first,
then stores the new and changed ones and removes the ones no longer
declared in one compare-and-set on the stored set, and answers which ids it
`upserted`, `pruned` and left `unchanged`. Schedules need the `schedules` capability, and the `leases`
capability when one has overlap control.

```ts
import { defineJob, reconcileSchedules, schedule, type JobsAdapter } from '@jsails/jobs';
import { z } from 'zod';

const Digest = defineJob({
  name: 'mail.digest',
  schema: z.object({ period: z.string() }),
  handle: () => undefined,
});
const Cleanup = defineJob({
  name: 'storage.cleanup',
  schema: z.null(),
  handle: () => undefined,
});

const schedules = [
  schedule('daily-digest', Digest.with({ period: 'day' }), {
    cron: '0 8 * * 1-5',
    timezone: 'Europe/Paris',
  }),
  schedule('cleanup', Cleanup.with(null), { everyMs: 15 * 60_000, overlap: true }),
];

export async function syncSchedules(adapter: JobsAdapter): Promise<void> {
  const result = await reconcileSchedules(adapter, schedules, { app: 'shop', by: 'deploy' });
  console.log(`stored ${result.upserted.length}, removed ${result.pruned.length}`);
}
```

An app has at most 1,000 schedules, each with exactly one of `everyMs` (1 s
to one year) and `cron`. The transport fires each one, enqueueing a fresh job
keyed `jsails:schedule:<id>:<fire time>`, so two firing processes still
fire it once; a fire carries no execution context of the deploy that reconciled. An
`everyMs` schedule fires every interval after it was first stored, or after
its interval last changed; a reconcile that changes nothing keeps its
rhythm. Fire times missed while nothing fired come as one fire when firing
resumes.

`pauseSchedules(adapter, ids)` and `resumeSchedules(adapter, ids)` change
the stored pause flag, which no reconcile resets, so a schedule an operator
paused stays paused across releases; resuming skips the fire times missed
while it was paused. Each reconcile records the app and `by` that ran it;
a reconcile by another app is refused with `jobs.schedule_owner_mismatch`
unless `adopt: true` is passed, the deliberate path after an app rename. A
reconcile that raced another one finds the stored set changed, applies
nothing, and reads it again, so two apps deploying into one namespace at
once never overwrite each other unnoticed; one that loses five such races
in a row gives up with `jobs.schedule_conflict`.

#### Cron patterns and time zones

A cron pattern has the five classic fields (minute, hour, day of month,
month, day of week) with an optional leading seconds field, month and day
names, ranges, steps, lists, `?` in either day field, and the lower-case
aliases (`@yearly`, `@monthly`, `@weekly`, `@daily`, `@hourly`,
`@weekdays` and the rest). The `L`,
`W`, `#` and `H` extensions are refused (rule `cron_extension`), and so is a
pattern that restricts both the day of month and the day of week (rule
`cron_day_conflict`), because that is where cron implementations disagree; a
pattern that would not fire within eight years is refused too (rule
`cron_never`). Errors never echo the pattern.

A cron schedule fires on the occurrences after it was stored, in its
`timezone`, an IANA name (`UTC` by default; refused on an `everyMs`
schedule). A wall time that a daylight-saving change skips fires when the
gap ends, and one that occurs twice fires once, at its first occurrence;
an elapsed cadence that ignores the clock belongs in `everyMs`.
`CRON_FIRE_CASES` from `@jsails/jobs/testing` lists the fire times every
transport must agree on.

### Failures and signals

A failed attempt is stored as a value-free summary: the error's `code` (for
a framework error), its `kind`, its class name, and the stack frames
without the message line. The message, the cause, and the payload are not
stored, because that is where personal data and secrets end up; a worker
started with `storeErrorMessages: true` also keeps each error's message, up
to 1,000 characters. The summaries are what the `failedJobs` capability
lists.

Given a `signals` bus, the worker emits one signal per settled attempt:
`jobCompleted` (`discarded` holds the summary of a discarded failure),
`jobSkipped`, `jobReleased` (with its reason and delay), and `jobFailed`
(with the summary, `retryable`, and `final` for the last attempt, plus
`failedJob`, the `id` and `queue` of the record a final failure left in the
failed set, absent when `onFinalFailure: 'drop'` kept none or the queue's
failed retention evicted it at once). An
observer's error stays with the bus; a bus that throws surfaces as an
uncaught exception rather than being dropped.

### Errors

Every failure of the package is a `jobs.*` code of `JobsErrors`, with a
message built from declared values only. `JobsErrors.is(error, code)` tests
one:

| Code | Kind | Raised when |
| --- | --- | --- |
| `jobs.invalid_definition` | internal | a definition is malformed, or its name starts with the reserved `jsails.`; `rule` names the check |
| `jobs.duplicate_job` | internal | two definitions share a name |
| `jobs.undeclared_queue` | internal | a definition names a queue the app does not declare |
| `jobs.unknown_option` | invalid | an option object has a field that is not an option |
| `jobs.invalid_option` | invalid | a dispatch option is invalid; `option` names it |
| `jobs.unknown_job` | not_found | no definition has the name, or a skewed job ran out of releases |
| `jobs.invalid_payload` | invalid | the job's schema refuses the payload |
| `jobs.payload_not_json` | invalid | the payload is not plain JSON |
| `jobs.context_not_json` | internal | the serialized context is not plain JSON |
| `jobs.invalid_envelope` | invalid | a stored value is not a valid envelope |
| `jobs.producer_closed` | unavailable | a dispatch after the producer closed |
| `jobs.invalid_queue` | internal | a queue declaration is malformed; `rule` names the check |
| `jobs.invalid_namespace` | internal | an app or environment name could break the namespace |
| `jobs.invalid_delay` | internal | a long timer's delay is not a non-negative safe integer |
| `jobs.command_threw` | internal | a command job's command threw (its error is the cause) |
| `jobs.command_exit` | internal | a command job's command exited non-zero |
| `jobs.unknown_queue` | internal | an adapter is asked about a queue it was not given |
| `jobs.adapter_closed` | unavailable | an adapter is used after it closed |
| `jobs.invalid_worker` | internal | a worker option is invalid; `option` names it |
| `jobs.worker_aborted` | aborted | the reason of an attempt's signal on shutdown |
| `jobs.attempt_timeout` | timeout | the reason of an attempt's signal past its `timeoutMs` |
| `jobs.processor_broke_contract` | internal | a processor returned something that is not an outcome |
| `jobs.middleware_next_reused` | internal | a middleware called `next` twice |
| `jobs.middleware_next_late` | internal | a middleware called `next` after it settled |
| `jobs.capability_missing` | internal | the adapter lacks the capability a feature needs; `capability` names it |
| `jobs.invalid_flow` | invalid | a chain or batch is malformed; `rule` names the check |
| `jobs.flow_too_large` | too_large | a chain's first envelope or a batch's callbacks exceed 256 KiB |
| `jobs.flow_item_refused` | invalid | an item of a chain or batch was refused; `item` is its index, the cause its error |
| `jobs.flow_conflict` | conflict | a batch id is re-issued with another number of children, or a child's key is taken |
| `jobs.flow_missing` | not_found | the batch record a finalizer needs is gone |
| `jobs.overlap_unavailable` | unavailable | the lease store could not be reached |
| `jobs.overlap_lost` | unavailable | the reason of an attempt's signal when its overlap lease was lost |
| `jobs.invalid_schedule` | internal | a schedule is malformed; `rule` names the check |
| `jobs.duplicate_schedule` | internal | two schedules share an id |
| `jobs.schedule_owner_mismatch` | conflict | another app reconciled the namespace's schedules last |
| `jobs.schedule_conflict` | conflict | other reconciles changed the stored schedules before each of five applies |
| `jobs.missing_dependency` | internal | the Valkey transport is built without `bullmq` installed |
| `jobs.transport_failed` | unavailable | the Valkey server did not complete an operation (the transport error is the cause) |
| `jobs.attempt_failed` | internal | the marker a Valkey job keeps for an attempt that failed and will run again |
| `jobs.job_stalled` | unavailable | a Valkey job lost its worker more often than `maxStalledCount` allows |

## Next steps

- [Testing](/docs/testing) — the in-process `createTestApp` surface and the native
  `node:test` suite.
- [CLI](/docs/cli) — `work`, `schedule`, and `queue` commands.
