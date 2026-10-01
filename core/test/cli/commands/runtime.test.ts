/**
 * Tests for the runtime commands: `schedule` over the runtime config (Valkey
 * URL precedence, scheme validation, `validateRuntimeConfig`) and `work` over
 * the application's worker role.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { CLI_SUITE_CONCURRENCY, runCli as spawnCli, type ProcessResult } from '../spawn-cli.js';

import {
  jobsRuntimeOptions,
  runScheduleCommand,
  runWorkCommand,
  type RuntimeDeps,
} from '../../../src/cli/commands/runtime.js';
import type { ShutdownSignal } from '../../../src/cli/shutdown.js';
import type { Application, CreateApplicationOptions } from '../../../src/app/application.js';
import type { ResolvedAppConfig } from '../../../src/app/config/index.js';
import { KernelStageErrors } from '../../../src/kernel/errors.js';
import { createLoadedApp } from '../../../src/kernel/load-app.js';
import { valkeyPlugin } from '../../../src/valkey/plugin.js';
import {
  assertRedisUrl,
  resolveRuntimeValkeyUrl,
  validateRuntimeConfig,
  RuntimeConfigError,
  type ResolvedRuntimeConfig,
} from '../../../src/jobs/runtime-config.js';
import { InMemoryFailedJobHistory } from '../../../src/jobs/failed-job-history.js';
import type { JobsRuntimeAdapter, JobsRuntime } from '../../../src/jobs/runtime.js';

/**
 * Tests for the jobs runtime CLI (`work` / `schedule`) and the runtime config
 * module. No live Valkey is ever contacted: lifecycle tests inject a fake
 * runtime controller or application through `runScheduleCommand` and `runWorkCommand`, and
 * subprocess tests run configs on the in-memory adapter or invalid shapes
 * that fail before any connection.
 */

// ---------------------------------------------------------------------------
// pure config resolution: precedence + URL validation
// ---------------------------------------------------------------------------

describe('resolveRuntimeValkeyUrl: precedence', () => {
  it('prefers config.valkeyUrl over env.VALKEY_URL', () => {
    assert.equal(
      resolveRuntimeValkeyUrl({ valkeyUrl: 'redis://a:6379' }, { VALKEY_URL: 'redis://b:6379' }),
      'redis://a:6379',
    );
  });

  it('falls back to env.VALKEY_URL when config.valkeyUrl is absent', () => {
    assert.equal(resolveRuntimeValkeyUrl({}, { VALKEY_URL: 'redis://c:6379' }), 'redis://c:6379');
  });

  it('ignores REDIS_URL; only VALKEY_URL names the connection', () => {
    assert.throws(
      () => resolveRuntimeValkeyUrl({}, { REDIS_URL: 'rediss://d:6379' }),
      /no Valkey URL configured/,
    );
  });

  it('throws a clear error when no URL is configured anywhere', () => {
    assert.throws(() => resolveRuntimeValkeyUrl({}, {}), /no Valkey URL configured/);
  });
});

describe('assertRedisUrl: explicit scheme validation', () => {
  it('accepts redis:// and rediss:// and returns the URL', () => {
    assert.equal(assertRedisUrl('redis://127.0.0.1:6379'), 'redis://127.0.0.1:6379');
    assert.equal(assertRedisUrl('rediss://:pw@host:6380/1'), 'rediss://:pw@host:6380/1');
  });

  it('rejects non-redis schemes', () => {
    assert.throws(() => assertRedisUrl('http://example.com'), /redis:\/\/ or rediss:\/\//);
    assert.throws(() => assertRedisUrl('postgres://x:5432'), /redis:\/\/ or rediss:\/\//);
  });

  it('rejects an empty or malformed URL', () => {
    assert.throws(() => assertRedisUrl(''), /non-empty/);
    assert.throws(() => assertRedisUrl('   '), /non-empty/);
    assert.throws(() => assertRedisUrl('not a url'), /valid redis:\/\/ or rediss:\/\//);
  });

  it('never echoes the URL (which may embed a password) in errors', () => {
    assert.throws(
      () => assertRedisUrl('http://user:supersecret-password@example.com'),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeConfigError);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// config shape validation (registry never executed, adapter never constructed)
// ---------------------------------------------------------------------------

/** A minimal custom adapter that satisfies the contract but never connects. */
function customAdapter(): JobsRuntimeAdapter {
  return {
    name: 'custom',
    createProducer: () => ({
      dispatch: async () => undefined,
      close: async () => undefined,
    }),
    createWorker: () => ({ close: async () => undefined }),
  };
}

describe('validateRuntimeConfig', () => {
  it('validates the registry without executing handlers, selecting the builtin adapter', () => {
    let executed = false;
    const resolved = validateRuntimeConfig(
      {
        registry: {
          ping: {
            schema: {},
            handler: async () => {
              executed = true;
            },
          },
        },
        valkeyUrl: 'redis://127.0.0.1:6379',
      },
      {},
      packageDir('validate-defaults', 'shop'),
    );
    assert.equal(resolved.valkeyUrl, 'redis://127.0.0.1:6379');
    assert.equal(resolved.adapter.name, 'bullmq');
    assert.equal(resolved.queueName, 'default');
    // No NODE_ENV runs in the production mode, as a plugin's setup sees it.
    assert.equal(resolved.prefix, 'shop:production');
    assert.equal(resolved.concurrency, 1);
    assert.deepEqual(resolved.schedules, []);
    assert.equal(executed, false, 'a handler must never run during validation');
  });

  it('defaults the prefix per app and mode, so neither shares a queue', () => {
    const raw = { registry: {}, valkeyUrl: 'redis://127.0.0.1:6379' };
    const shop = packageDir('prefix-shop', '@acme/shop');
    const blog = packageDir('prefix-blog', 'blog');
    const nested = join(shop, 'config', 'jobs');
    mkdirSync(nested, { recursive: true });

    const prefixes = [
      validateRuntimeConfig(raw, { NODE_ENV: 'production' }, shop).prefix,
      validateRuntimeConfig(raw, { NODE_ENV: 'development' }, shop).prefix,
      validateRuntimeConfig(raw, { NODE_ENV: 'production' }, blog).prefix,
      validateRuntimeConfig(raw, { NODE_ENV: 'production' }, nested).prefix,
    ];
    assert.deepEqual(prefixes, [
      'acme-shop:production',
      'acme-shop:development',
      'blog:production',
      'acme-shop:production',
    ]);
    assert.ok(!prefixes.includes('bull'));
    assert.equal(
      validateRuntimeConfig({ ...raw, prefix: 'explicit' }, { NODE_ENV: 'production' }, shop)
        .prefix,
      'explicit',
    );
  });

  it('rejects a config that is not an object', () => {
    assert.throws(() => validateRuntimeConfig('nope', {}), /default-export an object/);
    assert.throws(() => validateRuntimeConfig(null, {}), /default-export an object/);
  });

  it('rejects a missing or structurally invalid registry', () => {
    assert.throws(
      () => validateRuntimeConfig({ valkeyUrl: 'redis://h:6379' }, {}),
      /config\.registry must be an object/,
    );
    assert.throws(
      () =>
        validateRuntimeConfig(
          { registry: { broken: { schema: {}, handler: undefined } }, valkeyUrl: 'redis://h:6379' },
          {},
        ),
      /must define a schema and a handler/,
    );
  });

  it('applies queueName/prefix/concurrency defaults and validates overrides', () => {
    const resolved = validateRuntimeConfig(
      {
        registry: { p: { schema: {}, handler: async () => {} } },
        valkeyUrl: 'redis://h:6379',
        queueName: 'mailer',
        prefix: 'custom',
        concurrency: 3,
      },
      {},
    );
    assert.equal(resolved.queueName, 'mailer');
    assert.equal(resolved.prefix, 'custom');
    assert.equal(resolved.concurrency, 3);

    assert.throws(
      () =>
        validateRuntimeConfig(
          {
            registry: { p: { schema: {}, handler: async () => {} } },
            valkeyUrl: 'redis://h',
            concurrency: 0,
          },
          {},
        ),
      /positive integer/,
    );
  });

  it('requires schedules to be an array when present', () => {
    assert.throws(
      () =>
        validateRuntimeConfig(
          {
            registry: { p: { schema: {}, handler: async () => {} } },
            valkeyUrl: 'redis://h',
            schedules: {},
          },
          {},
        ),
      /config\.schedules must be an array/,
    );
  });

  it('preserves a custom adapter identity and requires no URL', () => {
    const adapter = customAdapter();
    const resolved = validateRuntimeConfig(
      {
        registry: { p: { schema: {}, handler: async () => {} } },
        adapter,
      },
      {},
    );

    assert.equal(resolved.adapter, adapter, 'the custom adapter identity is preserved');
    assert.equal(resolved.valkeyUrl, undefined, 'a custom adapter resolves no URL');
  });

  it('does not read or validate a URL when a custom adapter is supplied', () => {
    const adapter = customAdapter();
    // A poison URL that would fail builtin validation is ignored entirely.
    const resolved = validateRuntimeConfig(
      {
        registry: { p: { schema: {}, handler: async () => {} } },
        adapter,
        valkeyUrl: 'http://user:sup3rsecret@example.com',
      },
      {},
    );

    assert.equal(resolved.adapter, adapter);
    assert.equal(resolved.valkeyUrl, undefined);
  });

  it('rejects a malformed adapter without invoking its factories', () => {
    let created = false;
    const makeRegistry = () => ({
      p: {
        schema: {},
        handler: async () => {
          created = true;
        },
      },
    });

    assert.throws(
      () => validateRuntimeConfig({ registry: makeRegistry(), adapter: null }, {}),
      /config\.adapter is invalid/,
    );
    assert.throws(
      () => validateRuntimeConfig({ registry: makeRegistry(), adapter: {} }, {}),
      /non-empty name/,
    );
    assert.throws(
      () =>
        validateRuntimeConfig(
          { registry: makeRegistry(), adapter: { name: 'x', createWorker: () => undefined } },
          {},
        ),
      /createProducer/,
    );
    assert.throws(
      () =>
        validateRuntimeConfig(
          { registry: makeRegistry(), adapter: { name: 'x', createProducer: () => undefined } },
          {},
        ),
      /createWorker/,
    );
    assert.throws(
      () =>
        validateRuntimeConfig(
          {
            registry: makeRegistry(),
            adapter: {
              name: 'x',
              createProducer: () => undefined,
              createWorker: () => undefined,
              upsertSchedules: 1,
            },
          },
          {},
        ),
      /upsertSchedules/,
    );

    assert.equal(created, false, 'adapter factories must never run during validation');
  });
});

// ---------------------------------------------------------------------------
// lifecycle: fake runtime controller injected through runScheduleCommand and runWorkCommand
// ---------------------------------------------------------------------------

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('../..', import.meta.url)), 'runtime-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

/** A directory holding a `package.json` that names the app `name`. */
function packageDir(dirName: string, name: string): string {
  const dir = emptyDir(dirName);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
  return dir;
}

function emptyDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, content: string, filename = 'jsails.runtime.js'): string {
  const path = join(dir, filename);
  writeFileSync(path, content);
  return path;
}

interface FakeRuntimeState {
  creates: number;
  upserted: unknown[][];
  upsertOptions: unknown[];
  workerStarts: number;
  closes: number;
}

interface FakeDeps {
  deps: RuntimeDeps;
  state: FakeRuntimeState;
  configs: ResolvedRuntimeConfig[];
}

function makeFakeDeps(): FakeDeps {
  const state: FakeRuntimeState = {
    creates: 0,
    upserted: [],
    upsertOptions: [],
    workerStarts: 0,
    closes: 0,
  };
  const configs: ResolvedRuntimeConfig[] = [];

  const runtime: JobsRuntime = {
    async dispatch() {
      return undefined;
    },
    async startWorker() {
      state.workerStarts += 1;
    },
    async pauseQueue() {},
    async resumeQueue() {},
    async upsertSchedules(schedules, options) {
      state.upserted.push([...schedules]);
      state.upsertOptions.push(options);
    },
    async listSchedules() {
      return [];
    },
    async pauseSchedules() {},
    async abort() {},
    async close() {
      state.closes += 1;
    },
  };

  const deps: RuntimeDeps = {
    createRuntime: (config) => {
      state.creates += 1;
      configs.push(config);
      return runtime;
    },
  };

  return { deps, state, configs };
}

function makeSignal(events?: string[]) {
  let disposed = 0;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const signal: ShutdownSignal = {
    promise,
    abort: new AbortController().signal,
    dispose: () => {
      events?.push('dispose');
      disposed += 1;
    },
  };
  return {
    signal,
    resolve: () => resolve(),
    disposeCount: () => disposed,
  };
}

const REGISTRY_CONFIG = (schedules: string): string => `export default {
  registry: { sendEmail: { schema: {}, handler: async () => {} } },
  valkeyUrl: 'redis://127.0.0.1:6379',
  queueName: 'mailer',
  prefix: 'custom',
  concurrency: 2,
  schedules: ${schedules},
};`;

/** A config whose failed-job history counts its closes on a global array. */
const HISTORY_CONFIG = (key: string): string => `export default {
  registry: { sendEmail: { schema: {}, handler: async () => {} } },
  valkeyUrl: 'redis://127.0.0.1:6379',
  failedJobs: {
    record: async () => ({}),
    list: async () => [],
    get: async () => undefined,
    remove: async () => false,
    take: async () => undefined,
    restore: async (entry) => entry,
    clear: async () => 0,
    close: async () => {
      (globalThis.${key} ??= []).push(1);
    },
  },
};`;

function historyCloses(key: string): unknown {
  return (globalThis as Record<string, unknown>)[key];
}

const ONE_SCHEDULE = `[{ id: 'nightly', job: 'sendEmail', cron: '0 3 * * *' }]`;

describe('runScheduleCommand: schedule (one-shot)', () => {
  it('creates the runtime, registers schedules, and closes it', async () => {
    const dir = emptyDir('schedule-lifecycle');
    const configPath = writeConfig(dir, REGISTRY_CONFIG(ONE_SCHEDULE));
    const fake = makeFakeDeps();

    const code = await runScheduleCommand(configPath, fake.deps);

    assert.equal(code, 0);
    assert.equal(fake.state.creates, 1);
    assert.equal(fake.configs[0]?.queueName, 'mailer');
    assert.equal(fake.configs[0]?.prefix, 'custom');
    assert.equal(fake.configs[0]?.concurrency, 2);
    assert.equal(fake.configs[0]?.adapter.name, 'bullmq');
    assert.equal(fake.state.upserted.length, 1);
    assert.equal(fake.state.upserted[0]?.length, 1);
    assert.deepEqual(fake.state.upsertOptions, [undefined], 'schedule prunes undeclared ones');
    assert.equal(fake.state.workerStarts, 0, 'schedule never starts a worker');
    assert.equal(fake.state.closes, 1, 'the runtime must be closed after registration');
  });

  it('reconciles an empty schedule list so a removed last schedule is pruned', async () => {
    const dir = emptyDir('schedule-empty');
    const configPath = writeConfig(dir, REGISTRY_CONFIG('[]'));
    const fake = makeFakeDeps();

    const code = await runScheduleCommand(configPath, fake.deps);

    assert.equal(code, 0);
    assert.equal(fake.state.creates, 1);
    assert.deepEqual(fake.state.upserted, [[]], 'the empty list still reaches the runtime');
    assert.equal(fake.state.workerStarts, 0);
    assert.equal(fake.state.closes, 1, 'the runtime is still closed');
  });

  it('skips registration for an adapter without scheduling when none are declared', async () => {
    const dir = emptyDir('schedule-unsupported');
    const configPath = writeConfig(
      dir,
      `export default {
  registry: { sendEmail: { schema: {}, handler: async () => {} } },
  adapter: { name: 'plain', createProducer: () => undefined, createWorker: () => undefined },
};`,
    );
    const fake = makeFakeDeps();

    const code = await runScheduleCommand(configPath, fake.deps);

    assert.equal(code, 0);
    assert.equal(fake.state.upserted.length, 0, 'an adapter that cannot schedule is not asked');
    assert.equal(fake.state.closes, 1);
  });

  it('passes the job and shutdown timeouts to the jobs runtime', async () => {
    const dir = emptyDir('schedule-timeouts');
    const configPath = writeConfig(
      dir,
      `export default {
  registry: { sendEmail: { schema: {}, handler: async () => {} } },
  valkeyUrl: 'redis://127.0.0.1:6379',
  jobTimeoutMs: 120000,
  shutdownTimeoutMs: 5000,
};`,
    );
    const fake = makeFakeDeps();

    await runScheduleCommand(configPath, fake.deps);

    const config = fake.configs[0];
    assert.ok(config !== undefined);
    const options = jobsRuntimeOptions(config);
    assert.equal(options.jobTimeoutMs, 120000);
    assert.equal(options.shutdownTimeoutMs, 5000);
    assert.equal(options.adapter, config.adapter);
    assert.equal(options.queueName, config.queueName);
    assert.equal('failedJobs' in options, false, 'no history configured, none passed');
  });

  it('passes the configured failed-job history to the jobs runtime by identity', () => {
    const history = new InMemoryFailedJobHistory();
    const config = validateRuntimeConfig(
      {
        registry: { ping: { schema: {}, handler: async () => {} } },
        valkeyUrl: 'redis://127.0.0.1:6379',
        failedJobs: history,
      },
      {},
    );
    assert.equal(jobsRuntimeOptions(config).failedJobs, history);
  });

  it('closes the failed-job history after the runtime', async () => {
    const dir = emptyDir('schedule-history-close');
    const configPath = writeConfig(dir, HISTORY_CONFIG('scheduleHistoryCloses'));
    const fake = makeFakeDeps();

    await runScheduleCommand(configPath, fake.deps);

    assert.equal(fake.state.closes, 1);
    assert.deepEqual(historyCloses('scheduleHistoryCloses'), [1]);
  });
});

/** A fake application for `work`, recording what the command did with it. */
function makeFakeApp(
  options: {
    units?: readonly string[];
    dedicatedUnits?: readonly string[];
    startError?: Error;
  } = {},
) {
  const events: string[] = [];
  const created: (CreateApplicationOptions | undefined)[] = [];
  const closeSignals: (AbortSignal | undefined)[] = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const deps: RuntimeDeps = {
    createRuntime: () => {
      throw new Error('work builds no runtime from the runtime config');
    },
    createApplication: async (_source, createOptions) => {
      events.push('create');
      created.push(createOptions);
      return {
        units: options.units ?? ['jobs.producer', 'jobs.worker'],
        dedicatedUnits: options.dedicatedUnits ?? ['jobs.worker'],
        start: async () => {
          events.push('start');
          if (options.startError !== undefined) throw options.startError;
          markStarted();
        },
        close: async (closeOptions?: { signal?: AbortSignal }) => {
          events.push('close');
          closeSignals.push(closeOptions?.signal);
        },
      } as unknown as Application;
    },
  };
  return { deps, events, created, closeSignals, started };
}

/** The app `work` is handed; the fake application factory never reads it. */
const FAKE_SOURCE = {} as unknown as ResolvedAppConfig;

describe('runWorkCommand: work (the worker role)', () => {
  it('creates the app for the worker role, starts it, and closes it under the abort signal', async () => {
    const fake = makeFakeApp();
    const sig = makeSignal(fake.events);
    const pending = runWorkCommand(FAKE_SOURCE, {
      ...fake.deps,
      waitForShutdown: () => {
        fake.events.push('signal-install');
        return sig.signal;
      },
    });
    await fake.started;
    assert.deepEqual(fake.created, [{ roles: ['worker'], purpose: 'worker' }]);
    assert.ok(!fake.events.includes('close'), 'the app stays open while working');

    sig.resolve();
    assert.equal(await pending, 0);
    assert.deepEqual(fake.events, ['signal-install', 'create', 'start', 'close', 'dispose']);
    assert.deepEqual(fake.closeSignals, [sig.signal.abort]);
  });

  it('refuses an app with no unit for the worker role before starting anything', async () => {
    const fake = makeFakeApp({ units: [], dedicatedUnits: [] });
    const sig = makeSignal();
    await assert.rejects(
      runWorkCommand(FAKE_SOURCE, {
        ...fake.deps,
        waitForShutdown: () => sig.signal,
      }),
      (error: unknown) => KernelStageErrors.is(error, 'no_units'),
    );
    assert.ok(!fake.events.includes('start'));
    assert.equal(fake.closeSignals.length, 1, 'the app is closed');
    assert.equal(sig.disposeCount(), 1);
  });

  it('refuses a worker whose only unit is a connection every role runs, before it connects', async () => {
    const dir = packageDir('work-valkey-only', 'work-valkey-only');
    const sig = makeSignal();
    let created: Application | undefined;
    await assert.rejects(
      runWorkCommand(
        // Nothing listens on port 1: starting the valkey unit would fail to
        // connect, so the refusal must come before any unit starts.
        createLoadedApp(
          { rootDir: dir, plugins: { use: [valkeyPlugin({ url: 'redis://127.0.0.1:1' })] } },
          { cwd: dir },
        ),
        {
          createRuntime: () => {
            throw new Error('unused');
          },
          createApplication: async (source, options) => {
            const { createApplication } = await import('../../../src/app/application.js');
            created = await createApplication(source, options);
            return created;
          },
          waitForShutdown: () => sig.signal,
        },
      ),
      (error: unknown) =>
        KernelStageErrors.is(error, 'no_units') && error.context.role === 'worker',
    );
    assert.deepEqual(created?.units, ['valkey']);
    assert.deepEqual(created?.dedicatedUnits, []);
    assert.equal(sig.disposeCount(), 1);
  });

  it('closes the app and disposes the signal when a unit fails to start', async () => {
    const fake = makeFakeApp({ startError: new Error('worker failed to start') });
    const sig = makeSignal();
    await assert.rejects(
      runWorkCommand(FAKE_SOURCE, {
        ...fake.deps,
        waitForShutdown: () => sig.signal,
      }),
      /worker failed to start/,
    );
    assert.equal(fake.closeSignals.length, 1);
    assert.equal(sig.disposeCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// subprocess: real CLI help / default paths / bad configs
// ---------------------------------------------------------------------------

function runCli(args: string[], cwd: string): Promise<ProcessResult> {
  return spawnCli(args, { cwd });
}

// Subprocess configs use the in-memory adapter: `schedule` reconciles even
// an empty list, and the default suite must not contact a Valkey server.
const memoryAdapterUrl = pathToFileURL(
  fileURLToPath(new URL('../../../src/jobs/memory-adapter.js', import.meta.url)),
).href;

const VALID_CONFIG = `import { MemoryJobsAdapter } from ${JSON.stringify(memoryAdapterUrl)};
export default {
  registry: { ping: { schema: {}, handler: async () => {} } },
  adapter: new MemoryJobsAdapter(),
};`;

describe('cli: work/schedule subprocess', { concurrency: CLI_SUITE_CONCURRENCY }, () => {
  it('prints work and schedule in help', async () => {
    const result = await runCli(['--help'], emptyDir('help'));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ {2}work\s/m);
    assert.match(result.stdout, /^ {2}schedule\s/m);
    const schedule = await runCli(['schedule', '--help'], emptyDir('schedule-help'));
    assert.match(schedule.stdout, /jsails\.runtime\.js/);
  });

  it('schedule defaults to jsails.runtime.js', async () => {
    const dir = emptyDir('default-runtime');
    writeConfig(dir, VALID_CONFIG);
    const result = await runCli(['schedule'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Registered 0 schedule/);
  });

  it('schedule ignores jsails.database.js (the database config is not the runtime default)', async () => {
    const dir = emptyDir('runtime-missing');
    writeFileSync(join(dir, 'jsails.database.js'), 'export default {};\n');
    const result = await runCli(['schedule'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load runtime config/);
  });

  it('accepts a runtime config without a registry when jobsDir is empty', async () => {
    const dir = emptyDir('autoload-empty');
    writeConfig(
      dir,
      `import { MemoryJobsAdapter } from ${JSON.stringify(memoryAdapterUrl)};
export default { adapter: new MemoryJobsAdapter() };`,
    );
    const result = await runCli(['schedule'], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Registered 0 schedule/);
  });

  it('rejects a TypeScript runtime config with a compile hint', async () => {
    const dir = emptyDir('ts-runtime');
    const result = await runCli(['schedule', '--config', 'jsails.runtime.ts'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /compile it to JavaScript first/);
  });

  it('rejects an invalid URL scheme without echoing the password', async () => {
    const dir = emptyDir('bad-url');
    writeConfig(
      dir,
      `export default {
  registry: { ping: { schema: {}, handler: async () => {} } },
  valkeyUrl: 'http://user:supersecret-password@example.com',
};`,
    );
    const result = await runCli(['schedule'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /redis:\/\/ or rediss:\/\//);
    assert.doesNotMatch(result.stderr, /supersecret-password/);
  });

  it('accepts a .mjs runtime config', async () => {
    const dir = emptyDir('mjs-runtime');
    writeConfig(dir, VALID_CONFIG, 'jsails.runtime.mjs');
    const result = await runCli(['schedule', '--config', 'jsails.runtime.mjs'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Registered 0 schedule/);
  });
});

// ---------------------------------------------------------------------------
// the runtime config opens no plugin
// ---------------------------------------------------------------------------

describe('runScheduleCommand: schedule opens no plugin', () => {
  it('refuses a runtime config that still declares extensions, pointing at the app config', async () => {
    const dir = emptyDir('with-ext');
    const configPath = writeConfig(
      dir,
      `export default {
  registry: { sendEmail: { schema: {}, handler: async () => {} } },
  valkeyUrl: 'redis://127.0.0.1:6379',
  extensions: [{ name: 'x', setup() {} }],
};`,
    );
    const fake = makeFakeDeps();
    await assert.rejects(
      runScheduleCommand(configPath, fake.deps),
      (error: unknown) =>
        error instanceof RuntimeConfigError &&
        error.code === 'invalid_config' &&
        /app config/.test(error.message),
    );
    assert.equal(fake.state.creates, 0);
  });
});
