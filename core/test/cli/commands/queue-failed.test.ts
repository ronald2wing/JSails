/**
 * Tests for the failed-job history commands (`queue:failed`, `queue:retry`,
 * `queue:forget`): argument parsing, output, retry/forget semantics through an
 * injected runtime, and the subprocess wiring against a fixture config.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  parseQueueHistoryArgs,
  runQueueFailedCommand,
  runQueueForgetCommand,
  runQueueHistory,
  runQueueRetryCommand,
  type ParsedQueueHistoryArgs,
  type QueueHistoryCommand,
  type QueueHistoryDeps,
} from '../../../src/cli/commands/queue-failed.js';
import { parseCommandArgs } from '../../../src/cli/command-args.js';
import { BUILTIN_COMMANDS } from '../../../src/cli/manifest.js';
import {
  InMemoryFailedJobHistory,
  MAX_FAILED_JOB_LIST_LIMIT,
  type FailedJobRecordInput,
} from '../../../src/jobs/failed-job-history.js';
import { validateRuntimeConfig } from '../../../src/jobs/runtime-config.js';
import type { JobsRuntime } from '../../../src/jobs/runtime.js';

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('../..', import.meta.url)), 'queue-failed-fixture-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function input(overrides: Partial<FailedJobRecordInput> = {}): FailedJobRecordInput {
  return {
    queue: 'default',
    name: 'ping',
    data: { secret: 'do-not-print' },
    error: { name: 'Error', code: 'io_failed', message: 'boom' },
    attempts: 3,
    failedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

interface Harness {
  readonly deps: QueueHistoryDeps;
  readonly history: InMemoryFailedJobHistory;
  readonly out: string[];
  readonly err: string[];
  readonly dispatched: Array<{ queue: string; name: string; data: unknown }>;
  /** Every dispatch attempt's payload, successful or not, in order. */
  readonly attempted: unknown[];
  /** Every dispatch attempt's options, in order. */
  readonly optionsSeen: unknown[];
  readonly closed: string[];
}

interface HarnessOptions {
  readonly failDispatch?: (name: string) => boolean;
  /** `false` configures no history; an instance replaces the default one. */
  readonly history?: false | InMemoryFailedJobHistory;
  /** Runs inside every dispatch attempt, before it succeeds or fails. */
  readonly onDispatch?: (history: InMemoryFailedJobHistory) => Promise<unknown>;
}

function harness(options: HarnessOptions = {}): Harness {
  const history =
    options.history instanceof InMemoryFailedJobHistory
      ? options.history
      : new InMemoryFailedJobHistory();
  const attempted: unknown[] = [];
  const optionsSeen: unknown[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const dispatched: Array<{ queue: string; name: string; data: unknown }> = [];
  const closed: string[] = [];
  const config = validateRuntimeConfig(
    {
      registry: { ping: { schema: {}, handler: async () => {} } },
      adapter: {
        name: 'fake',
        createProducer: () => ({ dispatch: async () => undefined, close: async () => undefined }),
        createWorker: () => ({ close: async () => undefined }),
      },
      ...(options.history === false ? {} : { failedJobs: history }),
    },
    {},
  );
  const deps: QueueHistoryDeps = {
    loadConfig: async () => config,
    createRuntime: (_config, queue) =>
      ({
        async dispatch(name: string, data: unknown, opts?: unknown) {
          attempted.push(data);
          optionsSeen.push(opts);
          await options.onDispatch?.(history);
          if (options.failDispatch?.(name) === true) throw new Error('transport down');
          dispatched.push({ queue, name, data });
          return { id: 'x' };
        },
        async close() {
          closed.push(queue);
        },
      }) as unknown as JobsRuntime,
    env: {},
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, history, out, err, dispatched, attempted, optionsSeen, closed };
}

/**
 * Parse `argv` as the dispatcher does (against the command's descriptor),
 * then check it as the command does; a dispatcher usage error is `error`.
 */
function parseArgv(
  command: QueueHistoryCommand,
  argv: readonly string[],
): ParsedQueueHistoryArgs | { readonly kind: 'help' } {
  const descriptor = BUILTIN_COMMANDS.find((entry) => entry.name === `queue:${command}`);
  assert.ok(descriptor);
  const parsed = parseCommandArgs(descriptor, argv, true);
  if (parsed.kind === 'help') return parsed;
  if (parsed.kind === 'usage') return { kind: 'error', message: parsed.message };
  return parseQueueHistoryArgs(command, parsed.values, parsed.positionals);
}

describe('parseQueueHistoryArgs', () => {
  it('parses queue:failed flags with defaults', () => {
    assert.deepEqual(parseArgv('failed', []), {
      kind: 'failed',
      configPath: 'jsails.runtime.js',
      options: { json: false },
    });
    assert.deepEqual(
      parseArgv('failed', ['--queue', 'mail', '--limit', '5', '--json', '--config', 'x.js']),
      { kind: 'failed', configPath: 'x.js', options: { queue: 'mail', limit: 5, json: true } },
    );
  });

  it('accepts -c for --config like the other config-reading commands', () => {
    assert.deepEqual(parseArgv('failed', ['-c', 'x.js']), {
      kind: 'failed',
      configPath: 'x.js',
      options: { json: false },
    });
    assert.deepEqual(parseArgv('forget', ['-c', 'x.js', '1']), {
      kind: 'forget',
      configPath: 'x.js',
      options: { ids: ['1'], all: false, json: false },
    });
  });

  it('rejects a bad limit, a positional, or an unknown flag for queue:failed', () => {
    for (const args of [
      ['--limit', '0'],
      ['--limit', '1001'],
      ['--limit', 'ten'],
      ['7'],
      ['--all'],
    ]) {
      assert.equal(parseArgv('failed', args).kind, 'error', args.join(' '));
    }
  });

  it('parses ids or --all for retry and forget', () => {
    assert.deepEqual(parseArgv('retry', ['3', '4', '3']), {
      kind: 'retry',
      configPath: 'jsails.runtime.js',
      options: { ids: ['3', '4'], all: false, json: false },
    });
    assert.deepEqual(parseArgv('forget', ['--all', '--queue', 'mail']), {
      kind: 'forget',
      configPath: 'jsails.runtime.js',
      options: { ids: [], all: true, queue: 'mail', json: false },
    });
  });

  it('requires exactly one of ids and --all, and --queue only with --all', () => {
    assert.equal(parseArgv('retry', []).kind, 'error');
    assert.equal(parseArgv('retry', ['1', '--all']).kind, 'error');
    assert.equal(parseArgv('forget', ['1', '--queue', 'mail']).kind, 'error');
    assert.equal(parseArgv('forget', ['--limit', '3', '1']).kind, 'error');
    assert.equal(parseArgv('retry', ['--help']).kind, 'help');
  });

  it('exits 2 on a usage error before loading any config', async () => {
    const h = harness();
    const usage: string[] = [];
    const code = await runQueueHistory(
      'retry',
      {
        usage: (message) => {
          usage.push(message);
          return 2;
        },
      },
      {},
      [],
      {
        ...h.deps,
        loadConfig: () => Promise.reject(new Error('config reached')),
      },
    );
    assert.equal(code, 2);
    assert.match(usage.join('\n'), /queue:retry needs at least one id/);
  });
});

describe('runQueueFailedCommand', () => {
  it('lists entries newest first without printing payloads', async () => {
    const h = harness();
    await h.history.record(input({ name: 'ping', requestId: 'req-1' }));
    await h.history.record(input({ queue: 'mail', name: 'ping' }));
    assert.equal(await runQueueFailedCommand('cfg', {}, h.deps), 0);
    const text = h.out.join('\n');
    assert.match(text, /Failed jobs \(2, newest first\):/);
    assert.ok(text.indexOf('#2') < text.indexOf('#1'));
    assert.match(
      text,
      /queue=default {2}attempts=3 {2}failed=2026-01-01T00:00:00.000Z {2}request=req-1/,
    );
    assert.match(text, /Error \[io_failed\]: boom/);
    assert.doesNotMatch(text, /do-not-print/);
  });

  it('prints JSON, filtered by queue and limit, still without payloads', async () => {
    const h = harness();
    await h.history.record(input({ queue: 'mail' }));
    await h.history.record(input({ queue: 'mail' }));
    await h.history.record(input());
    await runQueueFailedCommand('cfg', { queue: 'mail', limit: 1, json: true }, h.deps);
    assert.equal(h.out.length, 1);
    const parsed = JSON.parse(h.out[0] ?? '') as { entries: Array<Record<string, unknown>> };
    assert.equal(parsed.entries.length, 1);
    assert.deepEqual(parsed.entries[0], {
      id: '2',
      queue: 'mail',
      name: 'ping',
      attempts: 3,
      failedAt: '2026-01-01T00:00:00.000Z',
      error: { name: 'Error', code: 'io_failed', message: 'boom' },
    });
  });

  it('says so when nothing is recorded', async () => {
    const h = harness();
    await runQueueFailedCommand('cfg', { queue: 'mail' }, h.deps);
    assert.deepEqual(h.out, ['No failed jobs recorded for "mail".']);
  });

  it('fails value-free when no history is configured', async () => {
    const h = harness({ history: false });
    await assert.rejects(
      runQueueFailedCommand('cfg', {}, h.deps),
      /no failed-job history configured/,
    );
  });
});

describe('runQueueRetryCommand', () => {
  it('re-dispatches each id to its recorded queue and removes it', async () => {
    const h = harness();
    await h.history.record(input({ queue: 'mail', data: { n: 1 } }));
    await h.history.record(input({ data: { n: 2 } }));
    const code = await runQueueRetryCommand('cfg', { ids: ['1', '2'], all: false }, h.deps);
    assert.equal(code, 0);
    assert.deepEqual(h.dispatched, [
      { queue: 'mail', name: 'ping', data: { n: 1 } },
      { queue: 'default', name: 'ping', data: { n: 2 } },
    ]);
    assert.deepEqual(await h.history.list(), []);
    assert.deepEqual(h.out, ['Retried #1 (ping on "mail")', 'Retried #2 (ping on "default")']);
    assert.deepEqual(h.closed.sort(), ['default', 'mail']);
  });

  it('keeps an entry whose dispatch fails, reports an unknown id, and exits 1', async () => {
    const h = harness({ failDispatch: () => true });
    await h.history.record(input());
    const code = await runQueueRetryCommand(
      'cfg',
      { ids: ['1', '9'], all: false, json: true },
      h.deps,
    );
    assert.equal(code, 1);
    assert.ok(await h.history.get('1'));
    assert.deepEqual(JSON.parse(h.out[0] ?? ''), {
      retried: [],
      failed: [
        { id: '1', reason: 'Error: transport down', restoredAs: '1' },
        { id: '9', reason: 'not found' },
      ],
      detached: [],
    });
  });

  it('claims an entry before dispatching it, so a concurrent retry sends nothing', async () => {
    let concurrent: Promise<number> | undefined;
    const second = harness();
    const h = harness({
      onDispatch: async () => {
        // A second operator retries the same id while the first dispatch is out.
        concurrent ??= runQueueRetryCommand('cfg', { ids: ['1'], all: false }, second.deps);
        await concurrent;
      },
    });
    second.deps.loadConfig = h.deps.loadConfig;
    await h.history.record(input());

    assert.equal(await runQueueRetryCommand('cfg', { ids: ['1'], all: false }, h.deps), 0);
    assert.equal(await concurrent, 1);
    assert.equal(h.dispatched.length, 1);
    assert.equal(second.dispatched.length, 0);
    assert.deepEqual(second.err, ['Could not retry #1: not found']);
    assert.deepEqual(await h.history.list(), []);
  });

  it('reports an entry it could not put back after a failed dispatch', async () => {
    const h = harness({ failDispatch: () => true });
    await h.history.record(input());
    h.history.restore = () => Promise.reject(new Error('connection lost'));
    const code = await runQueueRetryCommand('cfg', { ids: ['1'], all: false }, h.deps);
    assert.equal(code, 1);
    assert.deepEqual(h.err, [
      'Could not retry #1: Error: transport down; putting the entry back failed too ' +
        '(Error: connection lost), so it is no longer in the history',
    ]);
  });

  it('replays the recorded dispatch options and tags, never the delay or job id', async () => {
    const h = harness();
    await h.history.record(
      input({
        options: { attempts: 5, priority: 2, delay: 1000, jobId: 'x' },
        tags: ['tenant:1'],
      }),
    );
    await h.history.record(input());
    assert.equal(await runQueueRetryCommand('cfg', { ids: ['1', '2'], all: false }, h.deps), 0);
    assert.deepEqual(h.optionsSeen, [
      { attempts: 5, priority: 2, __jsailsTags: ['tenant:1'] },
      undefined,
    ]);
  });

  it('says a retried chain step or batch member runs on its own', async () => {
    const h = harness();
    await h.history.record(input({ membership: ['chain'] }));
    await h.history.record(input({ membership: ['batch'] }));
    assert.equal(await runQueueRetryCommand('cfg', { ids: ['1', '2'], all: false }, h.deps), 0);
    assert.deepEqual(h.out, [
      'Retried #1 (ping on "default")',
      '  #1 retried on its own: it was a chain step; the remaining steps were not dispatched',
      'Retried #2 (ping on "default")',
      '  #2 retried on its own: it was a batch member; the batch callbacks will not run for it',
    ]);

    const json = harness();
    await json.history.record(input({ membership: ['chain'] }));
    await runQueueRetryCommand('cfg', { ids: ['1'], all: false, json: true }, json.deps);
    assert.deepEqual(JSON.parse(json.out[0] ?? ''), {
      retried: ['1'],
      failed: [],
      detached: [{ id: '1', membership: ['chain'] }],
    });
  });

  it('does not retry --all entries recorded while the run is going', async () => {
    // Each attempt fails and records a fresh failure, as a worker would for a
    // job that fails again straight away.
    const h = harness({
      failDispatch: () => true,
      onDispatch: (history) => history.record(input({ name: 'again' })),
    });
    await h.history.record(input({ data: { n: 1 } }));
    await h.history.record(input({ data: { n: 2 } }));
    const code = await runQueueRetryCommand('cfg', { ids: [], all: true }, h.deps);
    assert.equal(code, 1);
    assert.deepEqual(h.attempted, [{ n: 1 }, { n: 2 }]);
    assert.equal((await h.history.list()).length, 4);
  });

  it('covers a history larger than one listing page with --all', async () => {
    const total = MAX_FAILED_JOB_LIST_LIMIT * 2 + 5;
    const h = harness({
      failDispatch: () => true,
      history: new InMemoryFailedJobHistory({ maxEntries: total }),
    });
    for (let n = 1; n <= total; n += 1) await h.history.record(input({ data: { n } }));
    const code = await runQueueRetryCommand('cfg', { ids: [], all: true, json: true }, h.deps);
    assert.equal(code, 1);
    assert.equal(h.attempted.length, total);
    assert.deepEqual(h.attempted[0], { n: 1 }, 'oldest first');
    assert.deepEqual(h.attempted.at(-1), { n: total });
  });

  it('retries --all oldest first, scoped by --queue, and never loops on a failing entry', async () => {
    const h = harness({ failDispatch: (name) => name === 'stuck' });
    await h.history.record(input({ name: 'first' }));
    await h.history.record(input({ name: 'stuck' }));
    await h.history.record(input({ name: 'other', queue: 'mail' }));
    await h.history.record(input({ name: 'second' }));
    const code = await runQueueRetryCommand(
      'cfg',
      { ids: [], all: true, queue: 'default' },
      h.deps,
    );
    assert.equal(code, 1);
    assert.deepEqual(
      h.dispatched.map((entry) => entry.name),
      ['first', 'second'],
    );
    assert.deepEqual(
      (await h.history.list()).map((entry) => entry.name),
      ['other', 'stuck'],
    );
  });
});

describe('runQueueForgetCommand', () => {
  it('deletes ids and reports unknown ones', async () => {
    const h = harness();
    await h.history.record(input());
    await h.history.record(input());
    const code = await runQueueForgetCommand('cfg', { ids: ['1', '7'], all: false }, h.deps);
    assert.equal(code, 1);
    assert.deepEqual(h.out, ['Forgot #1']);
    assert.deepEqual(h.err, ['Could not forget #7: not found']);
    assert.deepEqual(
      (await h.history.list()).map((entry) => entry.id),
      ['2'],
    );
    assert.equal(h.dispatched.length, 0);
  });

  it('deletes everything, or one queue, with --all', async () => {
    const h = harness();
    await h.history.record(input({ queue: 'mail' }));
    await h.history.record(input());
    assert.equal(
      await runQueueForgetCommand('cfg', { ids: [], all: true, queue: 'mail', json: true }, h.deps),
      0,
    );
    assert.deepEqual(JSON.parse(h.out[0] ?? ''), { forgotten: 1 });
    await runQueueForgetCommand('cfg', { ids: [], all: true }, h.deps);
    assert.equal(h.out[1], 'Forgot 1 failed job(s).');
    assert.deepEqual(await h.history.list(), []);
  });
});

// ---------------------------------------------------------------------------
// subprocess: CLI wiring
// ---------------------------------------------------------------------------

const cliPath = fileURLToPath(new URL('../../../src/cli/bin.cjs', import.meta.url));
const historyModule = pathToFileURL(
  fileURLToPath(new URL('../../../src/jobs/failed-job-history.js', import.meta.url)),
).href;

function writeFixture(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'jsails.runtime.js'),
    `import { z } from 'zod';
import { InMemoryFailedJobHistory } from ${JSON.stringify(historyModule)};
const failedJobs = new InMemoryFailedJobHistory();
await failedJobs.record({
  queue: 'default',
  name: 'ping',
  data: { secret: 'do-not-print' },
  error: { name: 'Error', message: 'boom' },
  attempts: 2,
  failedAt: new Date('2026-01-01T00:00:00.000Z'),
});
export default {
  registry: { ping: { schema: z.object({ secret: z.string() }), handler: async () => {} } },
  adapter: {
    name: 'custom',
    createProducer: () => ({ dispatch: async () => ({ id: '1' }), close: async () => undefined }),
    createWorker: () => ({ close: async () => undefined }),
  },
  failedJobs,
};`,
  );
}

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });
}

describe('cli: queue history subprocess', () => {
  it('lists, retries, and forgets through the bin', () => {
    const dir = join(tmpRoot, 'wiring');
    writeFixture(dir);

    const listed = runCli(['queue:failed', '--json'], dir);
    assert.equal(listed.status, 0, listed.stderr);
    const parsed = JSON.parse(listed.stdout.trim()) as { entries: Array<{ id: string }> };
    assert.deepEqual(
      parsed.entries.map((entry) => entry.id),
      ['1'],
    );
    assert.doesNotMatch(listed.stdout, /do-not-print/);

    const retried = runCli(['queue:retry', '1'], dir);
    assert.equal(retried.status, 0, retried.stderr);
    assert.match(retried.stdout, /Retried #1 \(ping on "default"\)/);

    const forgotten = runCli(['queue:forget', '--all'], dir);
    assert.equal(forgotten.status, 0, forgotten.stderr);
    assert.match(forgotten.stdout, /Forgot 1 failed job\(s\)\./);
  });

  it('exits 2 with usage for a bad flag', () => {
    const dir = join(tmpRoot, 'usage');
    writeFixture(dir);
    const result = runCli(['queue:failed', '--limit', '0'], dir);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--limit must be an integer between 1 and 1000/);
  });
});
