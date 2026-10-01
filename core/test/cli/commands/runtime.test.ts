/**
 * Tests for the runtime config resolution behind `work`/`schedule`: Valkey URL
 * precedence, scheme validation, and `validateRuntimeConfig`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { CLI_SUITE_CONCURRENCY, runCli as spawnCli, type ProcessResult } from '../spawn-cli.js';

import {
  jobsRuntimeOptions,
  runRuntimeCommand,
  type RuntimeDeps,
} from '../../../src/cli/commands/runtime.js';
import type { ShutdownSignal } from '../../../src/cli/shutdown.js';
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
 * runtime controller through `runRuntimeCommand`, and subprocess tests run
 * configs on the in-memory adapter or invalid shapes that fail before any
 * connection.
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
    assert.equal(resolved.prefix, 'shop:development');
    assert.equal(resolved.concurrency, 1);
    assert.deepEqual(resolved.schedules, []);
    assert.equal(executed, false, 'a handler must never run during validation');
  });

  it('defaults the prefix per app and environment, so neither shares a queue', () => {
    const raw = { registry: {}, valkeyUrl: 'redis://127.0.0.1:6379' };
    const shop = packageDir('prefix-shop', '@acme/shop');
    const blog = packageDir('prefix-blog', 'blog');
    const nested = join(shop, 'config', 'jobs');
    mkdirSync(nested, { recursive: true });

    const prefixes = [
      validateRuntimeConfig(raw, { NODE_ENV: 'production' }, shop).prefix,
      validateRuntimeConfig(raw, { NODE_ENV: 'staging' }, shop).prefix,
      validateRuntimeConfig(raw, { NODE_ENV: 'production' }, blog).prefix,
      validateRuntimeConfig(raw, { NODE_ENV: 'production' }, nested).prefix,
    ];
    assert.deepEqual(prefixes, [
      'acme-shop:production',
      'acme-shop:staging',
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
// lifecycle: fake runtime controller injected through runRuntimeCommand
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
  started: Promise<void>;
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
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  const runtime: JobsRuntime = {
    async dispatch() {
      return undefined;
    },
    async startWorker() {
      state.workerStarts += 1;
      markStarted();
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

  return { deps, state, configs, started };
}

function makeSignal() {
  let disposed = 0;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const signal: ShutdownSignal = {
    promise,
    dispose: () => {
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

describe('runRuntimeCommand: schedule (one-shot)', () => {
  it('creates the runtime, registers schedules, and closes it', async () => {
    const dir = emptyDir('schedule-lifecycle');
    const configPath = writeConfig(dir, REGISTRY_CONFIG(ONE_SCHEDULE));
    const fake = makeFakeDeps();

    const code = await runRuntimeCommand('schedule', configPath, fake.deps);

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

    const code = await runRuntimeCommand('schedule', configPath, fake.deps);

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

    const code = await runRuntimeCommand('schedule', configPath, fake.deps);

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

    await runRuntimeCommand('schedule', configPath, fake.deps);

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

    await runRuntimeCommand('schedule', configPath, fake.deps);

    assert.equal(fake.state.closes, 1);
    assert.deepEqual(historyCloses('scheduleHistoryCloses'), [1]);
  });
});

describe('runRuntimeCommand: work (signal + close lifecycle)', () => {
  it('registers schedules, starts the worker, then closes on signal', async () => {
    const dir = emptyDir('work-lifecycle');
    const configPath = writeConfig(dir, REGISTRY_CONFIG(ONE_SCHEDULE));
    const fake = makeFakeDeps();
    const sig = makeSignal();

    const pending = runRuntimeCommand('work', configPath, {
      ...fake.deps,
      waitForShutdown: () => sig.signal,
    });

    // Wait until the worker has started before firing the shutdown signal.
    await fake.started;

    assert.equal(fake.state.upserted.length, 1, 'schedules registered before the worker starts');
    // A worker of an older release must not delete schedules a newer one added.
    assert.deepEqual(fake.state.upsertOptions, [{ prune: false }]);
    assert.equal(fake.state.workerStarts, 1);
    assert.equal(fake.state.closes, 0, 'runtime stays open while running');

    sig.resolve();
    const code = await pending;

    assert.equal(code, 0);
    assert.equal(fake.state.closes, 1, 'runtime closed exactly once on shutdown');
    assert.equal(sig.disposeCount(), 1, 'signal listeners disposed on shutdown');
  });

  it('never reconciles an empty schedule list on start, which would prune', async () => {
    const dir = emptyDir('work-empty-schedules');
    const configPath = writeConfig(dir, REGISTRY_CONFIG('[]'));
    const fake = makeFakeDeps();
    const sig = makeSignal();

    const pending = runRuntimeCommand('work', configPath, {
      ...fake.deps,
      waitForShutdown: () => sig.signal,
    });
    await fake.started;
    sig.resolve();

    assert.equal(await pending, 0);
    assert.deepEqual(fake.state.upserted, [], 'only `jsails schedule` removes schedules');
  });

  it('closes the failed-job history on shutdown', async () => {
    const dir = emptyDir('work-history-close');
    const configPath = writeConfig(dir, HISTORY_CONFIG('workHistoryCloses'));
    const fake = makeFakeDeps();
    const sig = makeSignal();

    const pending = runRuntimeCommand('work', configPath, {
      ...fake.deps,
      waitForShutdown: () => sig.signal,
    });
    await fake.started;
    assert.equal(historyCloses('workHistoryCloses'), undefined, 'history open while running');

    sig.resolve();
    assert.equal(await pending, 0);
    assert.equal(fake.state.closes, 1);
    assert.deepEqual(historyCloses('workHistoryCloses'), [1]);
  });

  it('disposes signal listeners and never creates a runtime when config is invalid', async () => {
    const dir = emptyDir('work-bad-config');
    const configPath = writeConfig(
      dir,
      `export default { valkeyUrl: 'http://user:secret@example.com' };`,
    );
    const sig = makeSignal();
    const fake = makeFakeDeps();

    await assert.rejects(
      runRuntimeCommand('work', configPath, {
        ...fake.deps,
        waitForShutdown: () => sig.signal,
      }),
      /redis:\/\/|rediss:\/\//,
    );
    assert.equal(fake.state.creates, 0, 'no runtime created on config failure');
    assert.equal(sig.disposeCount(), 0, 'no signal listeners installed on config failure');
  });

  it('disposes the signal and closes the runtime when worker startup fails', async () => {
    const dir = emptyDir('work-startup-fail');
    const configPath = writeConfig(dir, REGISTRY_CONFIG('[]'));
    const sig = makeSignal();
    let closes = 0;
    const runtime: JobsRuntime = {
      async dispatch() {
        return undefined;
      },
      async startWorker() {
        throw new Error('worker failed to start');
      },
      async pauseQueue() {},
      async resumeQueue() {},
      async upsertSchedules() {},
      async listSchedules() {
        return [];
      },
      async pauseSchedules() {},
      async close() {
        closes += 1;
      },
    };

    await assert.rejects(
      runRuntimeCommand('work', configPath, {
        createRuntime: () => runtime,
        waitForShutdown: () => sig.signal,
      }),
      /worker failed to start/,
    );
    assert.equal(closes, 1, 'runtime closed on startup failure');
    assert.equal(sig.disposeCount(), 1, 'signal disposed on startup failure');
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
    assert.match(result.stdout, /work/);
    assert.match(result.stdout, /schedule/);
    assert.match(result.stdout, /jsails\.runtime\.js/);
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
// serviceRegistry passing through the CLI deps seam
// ---------------------------------------------------------------------------

describe('runRuntimeCommand: serviceRegistry bridging', () => {
  it('passes serviceRegistry: undefined for a config with no extensions', async () => {
    const dir = emptyDir('no-ext');
    const configPath = writeConfig(dir, REGISTRY_CONFIG('[]'));
    const fake = makeFakeDeps();

    await runRuntimeCommand('schedule', configPath, fake.deps);

    assert.equal(fake.configs.length, 1);
    assert.equal(fake.configs[0]?.serviceRegistry, undefined);
  });

  it('passes a defined serviceRegistry when config declares extensions', async () => {
    const dir = emptyDir('with-ext');
    const extConfig = `export default {
  registry: { sendEmail: { schema: {}, handler: async () => {} } },
  valkeyUrl: 'redis://127.0.0.1:6379',
  extensions: [{ name: 'x', setup() {} }],
};`;
    const configPath = writeConfig(dir, extConfig);
    const fake = makeFakeDeps();

    await runRuntimeCommand('schedule', configPath, fake.deps);

    assert.equal(fake.configs.length, 1);
    assert.notEqual(fake.configs[0]?.serviceRegistry, undefined);
    assert.equal(typeof fake.configs[0]?.serviceRegistry?.get, 'function');
  });
});
