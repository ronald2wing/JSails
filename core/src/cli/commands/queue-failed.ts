/**
 * The failed-job history commands. Each loads the runtime config (default
 * `jsails.runtime.js`) and works on its `failedJobs` history:
 *
 * ```sh
 * jsails queue:failed [--queue <name>] [--limit <n>] [--json]
 * jsails queue:retry <id...> | --all [--queue <name>] [--json]
 * jsails queue:forget <id...> | --all [--queue <name>] [--json]
 * ```
 *
 * `queue:failed` lists entries newest first and never prints payloads.
 * `queue:retry` claims each entry (removes it from the history, so a second
 * retry running at the same time finds nothing to send), then re-dispatches
 * its job and payload to the queue it was recorded on, through the same
 * neutral runtime `work` uses (so the payload is validated again), with the
 * dispatch options the job originally had (attempts, backoff, priority, ...;
 * never its delay or job id). A failed dispatch puts the entry back. A job
 * that ran as part of a chain or batch is retried on its own: the remaining
 * chain steps and the batch callbacks are not restored, and the output says
 * so. `queue:forget` deletes entries. A config without `failedJobs` fails with
 * a value-free error.
 *
 * With `--all`, `queue:retry` first snapshots the ids present when it starts,
 * reading pages of {@link MAX_FAILED_JOB_LIST_LIMIT} backwards through the
 * `beforeId` cursor, then retries them oldest first. A job that fails again
 * while the run is going is recorded under a new id outside the snapshot, so
 * it is not retried in the same run and cannot loop it, and a history larger
 * than one page is still covered entirely.
 */

import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { DEFAULT_RUNTIME_CONFIG_PATH } from '../../config-modules.js';
import { formatError } from '../../errors/inspect.js';
import { summarizeJobError } from '../../jobs/events.js';
import {
  MAX_FAILED_JOB_LIST_LIMIT,
  resolveFailedJobListLimit,
  retryFailedJob,
  type FailedJobHistory,
  type FailedJobRetryResult,
} from '../../jobs/failed-job-history.js';
import {
  FailedJobNotFoundError,
  type FailedJobEntry,
  type FailedJobMembership,
} from '../../jobs/failed-jobs.js';
import type { Awaitable } from '../../contracts/awaitable.js';
import type { ResolvedRuntimeConfig } from '../../jobs/runtime-config.js';
import type { JobsRuntime } from '../../jobs/runtime.js';
import { TAG_OPTION_KEY } from '../../jobs/tags.js';
import { installGlobals, usageFailure } from '../builtin-commands.js';
import { renderResult } from '../report.js';

/** The three history commands, by the suffix after `queue:`. */
export type QueueHistoryCommand = 'failed' | 'retry' | 'forget';

/** Parsed `queue:failed` arguments. */
export interface QueueFailedOptions {
  readonly queue?: string;
  readonly limit?: number;
  readonly json?: boolean;
}

/** Parsed `queue:retry` / `queue:forget` arguments: explicit ids or `--all`. */
export interface QueueSelectionOptions {
  readonly ids: readonly string[];
  readonly all: boolean;
  readonly queue?: string;
  readonly json?: boolean;
}

/** The result of {@link parseQueueHistoryArgs}. */
export type ParsedQueueHistoryArgs =
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'failed';
      readonly configPath: string;
      readonly options: QueueFailedOptions;
    }
  | {
      readonly kind: 'retry' | 'forget';
      readonly configPath: string;
      readonly options: QueueSelectionOptions;
    };

/** Dependency seam for the history commands; tests inject fakes. */
export interface QueueHistoryDeps {
  /** Load and validate the runtime config. */
  loadConfig(configPath: string): Promise<ResolvedRuntimeConfig>;
  /** Build a producer-side runtime bound to one queue, for re-dispatching. */
  createRuntime(config: ResolvedRuntimeConfig, queueName: string): Awaitable<JobsRuntime>;
  /** Write one output line. */
  stdout(text: string): void;
  /** Write one diagnostic line. */
  stderr(text: string): void;
}

// The runtime config loader and the runtime load the queue adapter (BullMQ),
// which parsing, help, and usage errors never need.
const defaultDeps: QueueHistoryDeps = {
  async loadConfig(configPath) {
    const { loadResolvedRuntimeConfig } = await import('../../jobs/runtime-config.js');
    return loadResolvedRuntimeConfig(configPath);
  },
  async createRuntime(config, queueName) {
    const { JobsRuntimeImpl } = await import('../../jobs/runtime.js');
    return new JobsRuntimeImpl({
      registry: config.registry,
      adapter: config.adapter,
      queueName,
      prefix: config.prefix,
      concurrency: config.concurrency,
    });
  },
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

/** Usage text per command. */
export const QUEUE_HISTORY_USAGE: Readonly<Record<QueueHistoryCommand, string>> = Object.freeze({
  failed:
    'Usage: jsails queue:failed [--queue <name>] [--limit <1-' +
    `${MAX_FAILED_JOB_LIST_LIMIT}>] [--json] [--config <path>]`,
  retry: 'Usage: jsails queue:retry <id...> | --all [--queue <name>] [--json] [--config <path>]',
  forget: 'Usage: jsails queue:forget <id...> | --all [--queue <name>] [--json] [--config <path>]',
});

const LIMIT_PATTERN = /^\d{1,7}$/;

/** Parse the tokens after `queue:<command>`. Pure: never touches the filesystem. */
export function parseQueueHistoryArgs(
  command: QueueHistoryCommand,
  args: readonly string[],
): ParsedQueueHistoryArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        config: { type: 'string', short: 'c' },
        queue: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        ...(command === 'failed' ? { limit: { type: 'string' } } : { all: { type: 'boolean' } }),
      },
      allowPositionals: command !== 'failed',
      strict: true,
    });
  } catch (error) {
    return { kind: 'error', message: formatError(error) };
  }
  const values = parsed.values as Readonly<Record<string, string | boolean | undefined>>;
  if (values.help === true) return { kind: 'help' };

  const configPath =
    typeof values.config === 'string' ? values.config : DEFAULT_RUNTIME_CONFIG_PATH;
  const queue = typeof values.queue === 'string' ? values.queue : undefined;
  if (queue === '') return { kind: 'error', message: '--queue must not be empty' };
  const json = values.json === true;

  if (command === 'failed') {
    let limit: number | undefined;
    if (typeof values.limit === 'string') {
      const invalid = `--limit must be an integer between 1 and ${MAX_FAILED_JOB_LIST_LIMIT}`;
      if (!LIMIT_PATTERN.test(values.limit)) return { kind: 'error', message: invalid };
      limit = Number(values.limit);
      if (limit < 1 || limit > MAX_FAILED_JOB_LIST_LIMIT) {
        return { kind: 'error', message: invalid };
      }
    }
    return {
      kind: 'failed',
      configPath,
      options: {
        ...(queue === undefined ? {} : { queue }),
        ...(limit === undefined ? {} : { limit }),
        json,
      },
    };
  }

  const all = values.all === true;
  const ids = parsed.positionals;
  if (all && ids.length > 0) {
    return { kind: 'error', message: `pass ids or --all, not both` };
  }
  if (!all && ids.length === 0) {
    return { kind: 'error', message: `queue:${command} needs at least one id, or --all` };
  }
  if (!all && queue !== undefined) {
    return { kind: 'error', message: '--queue applies only with --all' };
  }
  if (ids.some((id) => id.trim() === '')) {
    return { kind: 'error', message: 'ids must not be empty' };
  }
  return {
    kind: command,
    configPath,
    options: { ids: [...new Set(ids)], all, ...(queue === undefined ? {} : { queue }), json },
  };
}

/** The configured history, or a value-free config error naming the fix. */
async function requireHistory(config: ResolvedRuntimeConfig): Promise<FailedJobHistory> {
  if (config.failedJobs === undefined) {
    const { RuntimeConfigError } = await import('../../jobs/runtime-config.js');
    throw new RuntimeConfigError(
      'invalid_config',
      'no failed-job history configured: set `failedJobs` in the runtime config ' +
        '(for example createDatabaseFailedJobHistory)',
    );
  }
  return config.failedJobs;
}

/** An entry as printed: everything but the payload. */
function publicEntry(entry: FailedJobEntry): Record<string, unknown> {
  return {
    id: entry.id,
    queue: entry.queue ?? null,
    name: entry.name,
    attempts: entry.attempts,
    failedAt: entry.failedAt.toISOString(),
    error: {
      name: entry.errorName ?? 'Error',
      ...(entry.errorCode === undefined ? {} : { code: entry.errorCode }),
      message: entry.error,
    },
    ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
    ...(entry.tags === undefined ? {} : { tags: entry.tags }),
    ...(entry.membership === undefined ? {} : { membership: entry.membership }),
  };
}

function describeError(entry: FailedJobEntry): string {
  const code = entry.errorCode === undefined ? '' : ` [${entry.errorCode}]`;
  return `${entry.errorName ?? 'Error'}${code}: ${entry.error}`;
}

function renderEntryLines(entries: readonly FailedJobEntry[], queue: string | undefined): string[] {
  if (entries.length === 0) {
    return [
      queue === undefined ? 'No failed jobs recorded.' : `No failed jobs recorded for "${queue}".`,
    ];
  }
  const lines = [`Failed jobs (${entries.length}, newest first):`];
  for (const entry of entries) {
    const request = entry.requestId === undefined ? '' : `  request=${entry.requestId}`;
    const member = entry.membership === undefined ? '' : `  in=${entry.membership.join(',')}`;
    lines.push(
      `  #${entry.id}  ${entry.name}  queue=${entry.queue ?? '?'}  attempts=${entry.attempts}  ` +
        `failed=${entry.failedAt.toISOString()}${request}${member}`,
      `      ${describeError(entry)}`,
    );
  }
  return lines;
}

/** Close the history when it opened resources of its own (a lazily connected data source). */
async function closeHistory(history: FailedJobHistory | undefined): Promise<void> {
  if (history?.close !== undefined) await history.close();
}

/** `queue:failed`: list entries. Returns the exit code. */
export async function runQueueFailedCommand(
  configPath: string,
  options: QueueFailedOptions = {},
  deps: QueueHistoryDeps = defaultDeps,
): Promise<number> {
  const config = await deps.loadConfig(configPath);
  const history = await requireHistory(config);
  try {
    const limit = resolveFailedJobListLimit(options.limit);
    const entries = await history.list({
      limit,
      ...(options.queue === undefined ? {} : { queue: options.queue }),
    });
    const lines = renderResult(
      { entries: entries.map(publicEntry) },
      { json: options.json === true, render: () => renderEntryLines(entries, options.queue) },
    );
    for (const line of lines) deps.stdout(line);
  } finally {
    await closeHistory(history);
  }
  return 0;
}

/** One entry's outcome in a retry/forget run. */
interface EntryOutcome {
  readonly id: string;
  readonly ok: boolean;
  readonly name?: string;
  readonly queue?: string;
  readonly reason?: string;
  /** The id the entry is back under after a failed dispatch. */
  readonly restoredAs?: string;
  /** Set when a failed dispatch could not put the entry back either. */
  readonly restoreFailure?: string;
  /** The chain or batch a retried job belonged to and did not rejoin. */
  readonly membership?: readonly FailedJobMembership[];
}

/** Why a retried job runs on its own, for the operator. */
function describeMembership(membership: readonly FailedJobMembership[]): string {
  const parts = membership.map((member) =>
    member === 'chain'
      ? 'it was a chain step; the remaining steps were not dispatched'
      : 'it was a batch member; the batch callbacks will not run for it',
  );
  return `retried on its own: ${parts.join('; ')}`;
}

function printOutcomes(
  verb: 'retried' | 'forgotten',
  outcomes: readonly EntryOutcome[],
  json: boolean,
  deps: QueueHistoryDeps,
): number {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (json) {
    deps.stdout(
      JSON.stringify({
        [verb]: outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.id),
        failed: failed.map((outcome) => ({
          id: outcome.id,
          reason: outcome.reason,
          ...(outcome.restoredAs === undefined ? {} : { restoredAs: outcome.restoredAs }),
          ...(outcome.restoreFailure === undefined
            ? {}
            : { restoreFailure: outcome.restoreFailure }),
        })),
        ...(verb === 'retried'
          ? {
              detached: outcomes
                .filter((outcome) => outcome.ok && outcome.membership !== undefined)
                .map((outcome) => ({ id: outcome.id, membership: outcome.membership })),
            }
          : {}),
      }),
    );
  } else {
    for (const outcome of outcomes) {
      if (outcome.ok) {
        const detail =
          outcome.name === undefined ? '' : ` (${outcome.name} on "${outcome.queue ?? '?'}")`;
        deps.stdout(`${verb === 'retried' ? 'Retried' : 'Forgot'} #${outcome.id}${detail}`);
        if (outcome.membership !== undefined) {
          deps.stdout(`  #${outcome.id} ${describeMembership(outcome.membership)}`);
        }
      } else if (outcome.restoreFailure !== undefined) {
        deps.stderr(
          `Could not retry #${outcome.id}: ${outcome.reason}; putting the entry back failed ` +
            `too (${outcome.restoreFailure}), so it is no longer in the history`,
        );
      } else {
        const restored =
          outcome.restoredAs === undefined || outcome.restoredAs === outcome.id
            ? ''
            : `; the entry is back as #${outcome.restoredAs}`;
        deps.stderr(
          `Could not ${verb === 'retried' ? 'retry' : 'forget'} #${outcome.id}: ` +
            `${outcome.reason}${restored}`,
        );
      }
    }
    if (outcomes.length === 0) deps.stdout('No failed jobs matched.');
  }
  return failed.length > 0 ? 1 : 0;
}

function describeThrown(error: unknown): string {
  if (error instanceof FailedJobNotFoundError) return 'not found';
  const summary = summarizeJobError(error);
  const code = summary.code === undefined ? '' : ` [${summary.code}]`;
  return `${summary.name}${code}: ${summary.message}`;
}

/**
 * The ids of every entry present now (optionally of one queue), newest first,
 * read page by page through the `beforeId` cursor. Collecting them before any
 * retry keeps entries recorded during the run out of it. A page that brings no
 * unseen id ends the walk, so a custom history that ignores the cursor still
 * terminates (after its first page).
 */
async function snapshotIds(
  history: FailedJobHistory,
  queue: string | undefined,
): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let beforeId: string | undefined;
  for (;;) {
    const page = await history.list({
      limit: MAX_FAILED_JOB_LIST_LIMIT,
      ...(queue === undefined ? {} : { queue }),
      ...(beforeId === undefined ? {} : { beforeId }),
    });
    const fresh = page.filter((entry) => !seen.has(entry.id));
    if (fresh.length === 0) return ids;
    for (const entry of fresh) {
      seen.add(entry.id);
      ids.push(entry.id);
    }
    if (page.length < MAX_FAILED_JOB_LIST_LIMIT) return ids;
    beforeId = page.at(-1)?.id;
  }
}

/** The dispatch options a retry sends: the recorded replay options plus the tags. */
function replayOptions(entry: FailedJobEntry): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = { ...entry.options };
  if (entry.tags !== undefined) options[TAG_OPTION_KEY] = entry.tags;
  return Object.keys(options).length === 0 ? undefined : options;
}

/** `queue:retry`: claim entries, re-dispatch them, and put back the ones that failed to send. */
export async function runQueueRetryCommand(
  configPath: string,
  options: QueueSelectionOptions,
  deps: QueueHistoryDeps = defaultDeps,
): Promise<number> {
  const config = await deps.loadConfig(configPath);
  const history = await requireHistory(config);
  const runtimes = new Map<string, JobsRuntime>();
  const runtimeFor = async (queueName: string): Promise<JobsRuntime> => {
    let runtime = runtimes.get(queueName);
    if (runtime === undefined) {
      runtime = await deps.createRuntime(config, queueName);
      runtimes.set(queueName, runtime);
    }
    return runtime;
  };
  const outcomes: EntryOutcome[] = [];
  const retryOne = async (id: string): Promise<void> => {
    let result: FailedJobRetryResult;
    try {
      result = await retryFailedJob(history, id, async (found) =>
        (await runtimeFor(found.queue ?? config.queueName)).dispatch(
          found.name,
          found.data,
          replayOptions(found),
        ),
      );
    } catch (error) {
      outcomes.push({ id, ok: false, reason: describeThrown(error) });
      return;
    }
    const { entry } = result;
    if (result.status === 'dispatched') {
      outcomes.push({
        id,
        ok: true,
        name: entry.name,
        queue: entry.queue ?? config.queueName,
        ...(entry.membership === undefined ? {} : { membership: entry.membership }),
      });
    } else if (result.status === 'restored') {
      outcomes.push({
        id,
        ok: false,
        reason: describeThrown(result.dispatchError),
        restoredAs: entry.id,
      });
    } else {
      outcomes.push({
        id,
        ok: false,
        reason: describeThrown(result.dispatchError),
        restoreFailure: describeThrown(result.restoreError),
      });
    }
  };
  try {
    if (options.all) {
      const snapshot = await snapshotIds(history, options.queue);
      // Oldest first, so jobs go back out in the order they originally failed.
      for (const id of snapshot.reverse()) await retryOne(id);
    } else {
      for (const id of options.ids) await retryOne(id);
    }
  } finally {
    const errors: unknown[] = [];
    for (const runtime of runtimes.values()) {
      await runtime.close().catch((error: unknown) => errors.push(error));
    }
    await closeHistory(history).catch((error: unknown) => errors.push(error));
    if (errors.length > 0) throw errors[0];
  }
  return printOutcomes('retried', outcomes, options.json === true, deps);
}

/** `queue:forget`: delete entries without running them. */
export async function runQueueForgetCommand(
  configPath: string,
  options: QueueSelectionOptions,
  deps: QueueHistoryDeps = defaultDeps,
): Promise<number> {
  const config = await deps.loadConfig(configPath);
  const history = await requireHistory(config);
  try {
    if (options.all) {
      const removed = await history.clear(
        options.queue === undefined ? {} : { queue: options.queue },
      );
      const scope = options.queue === undefined ? '' : ` from "${options.queue}"`;
      deps.stdout(
        options.json === true
          ? JSON.stringify({ forgotten: removed })
          : `Forgot ${removed} failed job(s)${scope}.`,
      );
      return 0;
    }
    const outcomes: EntryOutcome[] = [];
    for (const id of options.ids) {
      const removed = await history.remove(id);
      outcomes.push(removed ? { id, ok: true } : { id, ok: false, reason: 'not found' });
    }
    return printOutcomes('forgotten', outcomes, options.json === true, deps);
  } finally {
    await closeHistory(history);
  }
}

/**
 * The `queue:failed` / `queue:retry` / `queue:forget` entry point: parse the
 * tokens, install the globals the config may reference, run, and report a
 * failure as one value-free line. Returns the exit code (2 for usage errors).
 */
export async function runQueueHistoryCli(
  command: QueueHistoryCommand,
  args: readonly string[],
  deps: QueueHistoryDeps = defaultDeps,
): Promise<number> {
  const parsed = parseQueueHistoryArgs(command, args);
  if (parsed.kind === 'help') {
    deps.stdout(QUEUE_HISTORY_USAGE[command]);
    return 0;
  }
  if (parsed.kind === 'error') {
    return usageFailure(`queue:${command}: ${parsed.message}`);
  }
  try {
    // The runtime config and the jobs it autoloads may reference framework
    // globals (`defineJob`, models) by bare name.
    await installGlobals(dirname(resolve(parsed.configPath)));
    switch (parsed.kind) {
      case 'failed':
        return await runQueueFailedCommand(parsed.configPath, parsed.options, deps);
      case 'retry':
        return await runQueueRetryCommand(parsed.configPath, parsed.options, deps);
      case 'forget':
        return await runQueueForgetCommand(parsed.configPath, parsed.options, deps);
    }
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }
}
