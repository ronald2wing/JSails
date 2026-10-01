/**
 * Opt-in live-integration verification harness.
 *
 * Exercises the framework's eight external-service seams against *real* services
 * the operator has provisioned and pointed at via environment variables. This is
 * deliberately the opposite of the unit suite, which fakes every adapter: here a
 * MariaDB/Postgres server, a Valkey/Redis instance, and a Docker daemon (where
 * Jamal starts an app's services) are used for real, so a green run proves the
 * wiring end to end.
 *
 * Every stage is env-gated and skips cleanly when its variables are absent, so
 * the default workflow (and `npm run check`) is never affected — running this
 * on a machine without those services simply reports eight `skipped` stages and
 * exits 0. A stage that is *enabled* but then fails (unreachable service, bad
 * config, unexpected error) is a real failure and the process exits non-zero.
 *
 * Stages:
 *   (A) database   — DATABASE_TYPE (mariadb|postgres) plus
 *                    DATABASE_HOST/PORT/USER/PASSWORD/NAME. Builds a
 *                    temporary JsailsDataSource around one scalar EntitySchema,
 *                    reconciles the declared schema against the live database
 *                    and applies the resulting plan, then performs Active Record
 *                    insert/query/update/delete with BaseEntity, drops only its
 *                    own table and destroys the connection. Credentials are
 *                    never printed.
 *   (B) jobs        — VALKEY_URL. On `@jsails/jobs/valkey`: one echo job
 *                    dispatched twice under one key (the second deduplicated)
 *                    and run by a runtime worker, one interval schedule
 *                    reconciled and read back, then everything closed and the
 *                    namespace's keys deleted. Bounded timeout. Then the
 *                    `@jsails/jobs` suite runs through `scripts/run-tests.mjs`
 *                    with JSAILS_TEST_VALKEY=1 and the `valkey` service
 *                    declared (JSAILS_TEST_SERVICES): the transport's full
 *                    conformance suite, its live tests (the settlement
 *                    command budget, chunked batches, failed-job paging,
 *                    leases, schedules) and the spawned two-process test,
 *                    plus the legacy BullMQ conformance file, which reconciles
 *                    with its Valkey-scoped entries in
 *                    `scripts/expected-failures/jobs.json`.
 *   (C) broadcast   — VALKEY_URL. attachBroadcast onto a loopback
 *                    HTTP server with a Redis pub/sub URL, two clients connect,
 *                    message delivery is asserted and channel authorization is
 *                    asserted to deny an unauthorized subscription, then closed.
 *   (D) jamal       — JSAILS_TEST_DOCKER=1 and a Docker daemon with the
 *                    Compose plugin. Generates two throwaway `--admin` apps
 *                    from packed tarballs and drives `@jsails/jamal` against
 *                    real containers: one Compose project and set of volumes
 *                    per app, `.env` loaded by the package's own bin, `up`,
 *                    `ps`, `exec`, `logs`, data kept across `down`,
 *                    `down --volumes` removing only its own project's volumes,
 *                    and nothing labelled with the run's Compose projects left
 *                    afterwards
 *                    (`scripts/verify-integrations/jamal.mjs`). An unavailable
 *                    daemon fails the enabled stage. Apps are named after
 *                    JSAILS_TEST_DOCKER_PREFIX (default `jsails-verify-jamal`).
 *   (D2) jamal-secrets — JSAILS_TEST_DOCKER=1 and a Docker daemon. Writes a
 *                    release's secrets file the way `jamal deploy` does
 *                    (the built secrets-file and remote-file modules, a
 *                    temporary directory standing in for the server home)
 *                    and reads it back from inside a container run as the
 *                    app's runtime uid 10001 through the release's own
 *                    read-only mount: every value equals the original byte
 *                    for byte, and a rewrite reaches a running container
 *                    through the cache proxy's directory mount
 *                    (`scripts/verify-integrations/jamal-secrets.mjs`).
 *                    Containers are named after JSAILS_TEST_DOCKER_PREFIX
 *                    (default `jsails-verify-secrets`).
 *   (E) s3           — JSAILS_TEST_S3=1 plus S3_ENDPOINT/BUCKET/ACCESS_KEY_ID/
 *                    SECRET_ACCESS_KEY. Runs the compiled `S3Disk` live test
 *                    against the real S3-compatible store, which creates its
 *                    own bucket and exercises write/read/stat/list/delete,
 *                    a nested prefix, multipart writes, and a signed URL.
 *   (F) live         — JSAILS_TEST_VALKEY=1 plus VALKEY_URL. Runs the compiled
 *                    live change-log test against the real Valkey, which
 *                    appends to a stream, reads a suffix, shares one sequence
 *                    across connections, and asserts a pub/sub notification.
 *   (G) cache        — VALKEY_URL. Runs the `@jsails/cache` suite through
 *                    `scripts/run-tests.mjs` with JSAILS_TEST_VALKEY=1 and the
 *                    `valkey` service declared, so its live files hold the
 *                    Valkey cache and lease stores and `defineCache` to the
 *                    conformance cases (and to races across two connections)
 *                    on the real server, and time a tag invalidation reaching
 *                    a reader in a second process over the tag bus and, with
 *                    the bus off, through the `syncMs` backstop.
 *
 * `DATABASE_*`/`VALKEY_URL` follow the same convention the app and the
 * `jsails.database.js` readers use. This harness is a **test**: it resolves the
 * `test` environment (`.env` then `.env.test`, the `*_test` database) instead of
 * the development one, and its throwaway `verify_widgets` table lands in the
 * test database — it never touches dev data.
 *
 * Output is a per-stage line plus a final tally (`SUMMARY ok=<n> failed=<n>
 * skipped=<n>`). Exit code is 0 unless a stage failed.
 *
 * `--require <stage,stage,...>` turns a skip of any named stage into a failure,
 * so CI that provisions the services cannot pass on a run whose variables
 * silently failed to arrive. `--only <stage,stage,...>` runs the named stages
 * and no other (for one stage on a developer machine whose `.env` enables the
 * rest). An unknown stage name, or a required stage `--only` leaves out, is a
 * usage error.
 *
 * This script uses the already-built `core/dist` and plugin `dist/` trees: it requires the build to exist
 * (printing a hint to run `npm run build`) and never builds anything itself. It
 * is opt-in — run it with `npm run verify:integrations`; no CLI command triggers
 * it and it is not part of `npm test` / `npm run check`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { EntitySchema } from 'typeorm';
import { z } from 'zod';
import { io as createClient } from 'socket.io-client';

import { runJamalStage } from './verify-integrations/jamal.mjs';
import { runJamalSecretsStage } from './verify-integrations/jamal-secrets.mjs';
import { repoRoot } from './workspaces.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIST_INDEX = join(repoRoot, 'core', 'dist', 'src', 'index.js');
const DIST_INDEX_URL = pathToFileURL(DIST_INDEX).href;
const DIST_PLUGIN_SDK_URL = pathToFileURL(
  join(repoRoot, 'core', 'dist', 'src', 'plugin-sdk', 'index.js'),
).href;
const DIST_JOBS_URL = pathToFileURL(
  join(repoRoot, 'packages', 'jobs', 'dist', 'src', 'index.js'),
).href;
const DIST_JOBS_VALKEY_URL = pathToFileURL(
  join(repoRoot, 'packages', 'jobs', 'dist', 'src', 'valkey', 'index.js'),
).href;

/** Bounded budgets per stage so a hung service surfaces as a failure, not a hang. */
const DATABASE_CONNECT_TIMEOUT_MS = 15_000;
const JOBS_TIMEOUT_MS = 20_000;
const BROADCAST_CONNECT_MS = 10_000;
const BROADCAST_ACK_MS = 10_000;
const BROADCAST_EVENT_MS = 10_000;

/** Broadcast protocol constants, mirrored from core/src/broadcast/server.ts. */
const BROADCAST_ORIGIN = 'https://verify.jsails.test';
const SUBSCRIBE_EVENT = 'jsails:subscribe';
const BROADCAST_EVENT = 'jsails:event';
/** Engine.IO path the built-in adapter mounts on (core/src/broadcast/contracts.ts). */
const BROADCAST_PATH = '/_jsails/broadcast';

const DB_TYPE_ENV = 'DATABASE_TYPE';
const DB_HOST_ENV = 'DATABASE_HOST';
const DB_PORT_ENV = 'DATABASE_PORT';
const DB_USER_ENV = 'DATABASE_USER';
const DB_PASSWORD_ENV = 'DATABASE_PASSWORD';
const DB_NAME_ENV = 'DATABASE_NAME';
const VALKEY_URL_ENV = 'VALKEY_URL';
const S3_ENV = 'JSAILS_TEST_S3';
const VALKEY_LIVE_ENV = 'JSAILS_TEST_VALKEY';

/** Compiled filesystem-plugin live S3 test, relative to the repo root. */
const S3_LIVE_TEST = join(repoRoot, 'packages', 'filesystem', 'dist', 'test', 's3-live.test.js');
const RUN_TESTS = join(repoRoot, 'scripts', 'run-tests.mjs');
/** The budget of one workspace suite run against the live Valkey. */
const VALKEY_SUITE_TIMEOUT_MS = 600_000;
const VALKEY_LIVE_TEST = join(
  repoRoot,
  'packages',
  'live',
  'dist',
  'test',
  'valkey-change-log-live.test.js',
);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Classify a caught value into a one-line, value-free message. */
function describeError(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/** Replace every non-empty secret with a fixed marker so credentials never leak. */
function redact(message, secrets) {
  let out = message;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

/** Reject after `ms`, so a service that never answers fails instead of hanging. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Config-error thrown by stage setup; never carries raw input values. */
class VerifyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerifyConfigError';
  }
}

// ---------------------------------------------------------------------------
// Stage A: database migrations + Active Record CRUD
// ---------------------------------------------------------------------------

/**
 * Parse the database env block. Returns `null` when the stage is disabled (type
 * absent); otherwise validates every field and returns the connection settings.
 * Throws {@link VerifyConfigError} on a malformed block, never echoing a value.
 */
function readDatabaseConfig(env) {
  const type = env[DB_TYPE_ENV];
  if (type === undefined || type === '') {
    return null;
  }
  if (type !== 'mariadb' && type !== 'postgres') {
    throw new VerifyConfigError(`${DB_TYPE_ENV} must be one of "mariadb" or "postgres"`);
  }
  const host = env[DB_HOST_ENV];
  const user = env[DB_USER_ENV];
  const password = env[DB_PASSWORD_ENV];
  const name = env[DB_NAME_ENV];
  const portRaw = env[DB_PORT_ENV];

  const missing = [];
  if (!host) missing.push(DB_HOST_ENV);
  if (!user) missing.push(DB_USER_ENV);
  if (!password) missing.push(DB_PASSWORD_ENV);
  if (!name) missing.push(DB_NAME_ENV);
  const port = portRaw === undefined ? NaN : Number(portRaw);
  if (portRaw === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    missing.push(`${DB_PORT_ENV} (an integer between 1 and 65535)`);
  }
  if (missing.length > 0) {
    throw new VerifyConfigError(`database stage incomplete: ${missing.join(', ')}`);
  }
  return { type, host, port, user, password, name };
}

async function runDatabaseStage(api, env) {
  let config;
  try {
    config = readDatabaseConfig(env);
  } catch (error) {
    return { stage: 'database', status: 'failed', detail: describeError(error) };
  }
  if (config === null) {
    return { stage: 'database', status: 'skipped', detail: `${DB_TYPE_ENV} is not set` };
  }

  const { type, host, port, user, password, name } = config;
  const secrets = [password, user];

  // One scalar entity, bound to a BaseEntity subclass so the Active Record
  // static methods resolve to this data source (TypeORM auto-binds it during
  // metadata construction).
  class VerifyWidget extends api.BaseEntity {}
  const widgetSchema = new EntitySchema({
    name: 'VerifyWidget',
    tableName: 'verify_widgets',
    target: VerifyWidget,
    columns: {
      id: { type: 'integer', primary: true, generated: true },
      label: { type: 'varchar', length: 100, nullable: false },
      active: { type: 'boolean', nullable: false, default: true },
    },
  });

  const dataSourceOptions = {
    type,
    host,
    port,
    username: user,
    password,
    database: name,
    entities: [widgetSchema],
  };
  // Bound the driver's connection attempt so an unreachable host fails rather
  // than hanging the stage on the OS TCP timeout.
  if (type === 'postgres') {
    dataSourceOptions.connectionTimeoutMillis = DATABASE_CONNECT_TIMEOUT_MS;
  } else {
    dataSourceOptions.connectTimeout = DATABASE_CONNECT_TIMEOUT_MS;
  }
  const dataSource = new api.JsailsDataSource(dataSourceOptions);

  try {
    await dataSource.initialize();

    // Declarative reconcile: diff the declared model schema against the live
    // database and apply the resulting plan. A fresh schema is never up to date.
    const plan = await api.reconcileDataSource(dataSource, { allowDestructive: true });
    if (plan.upToDate) {
      throw new Error('expected a pending plan for a fresh schema');
    }
    if (plan.operations.length === 0) {
      throw new Error('expected at least one operation for a fresh schema');
    }
    await api.executeSchemaPlan(dataSource, plan.operations);

    // Active Record CRUD through the BaseEntity subclass.
    const inserted = await VerifyWidget.insert({ label: 'alpha', active: true });
    const insertedId = inserted.identifiers[0]?.id;

    const found = await VerifyWidget.find();
    if (found.length !== 1 || found[0]?.label !== 'alpha') {
      throw new Error('Active Record query did not return the inserted row');
    }

    await VerifyWidget.update({ id: insertedId }, { label: 'beta' });
    const updated = await VerifyWidget.findOneBy({ id: insertedId });
    if (updated?.label !== 'beta') {
      throw new Error('Active Record update did not persist');
    }

    await VerifyWidget.delete({ id: insertedId });
    if ((await VerifyWidget.find()).length !== 0) {
      throw new Error('Active Record delete did not remove the row');
    }

    // A second reconcile against the now-live schema must be up to date.
    const settled = await api.reconcileDataSource(dataSource, { allowDestructive: true });
    if (!settled.upToDate) {
      throw new Error('schema is not up to date after applying the plan');
    }

    return {
      stage: 'database',
      status: 'ok',
      detail: `reconcile + Active Record CRUD on ${type}`,
    };
  } catch (error) {
    return { stage: 'database', status: 'failed', detail: redact(describeError(error), secrets) };
  } finally {
    // Drop only the table this run created. Never touch any other table.
    if (dataSource.isInitialized) {
      await dataSource.query(`DROP TABLE IF EXISTS verify_widgets`).catch(() => {});
    }
    await dataSource.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Stage B: jobs (queue + worker + schedule, then the conformance suite)
// ---------------------------------------------------------------------------

/**
 * How a stage runs the suite of `packages/<workspace>` against the Valkey at
 * `url`: through `scripts/run-tests.mjs`, so the result reconciles with the
 * ledgers instead of failing on the listed defects, with the workspace's live
 * files enabled (JSAILS_TEST_VALKEY) and `valkey` added to the services the
 * run declares, so the entries scoped to it apply. The jobs stage runs
 * `jobs` (the Valkey transport's live files and the legacy BullMQ
 * conformance file), the cache stage `cache`.
 */
export function valkeySuiteRun(workspace, env, url) {
  const services = new Set(
    (env.JSAILS_TEST_SERVICES ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
  );
  services.add('valkey');
  return {
    command: process.execPath,
    args: [RUN_TESTS],
    cwd: join(repoRoot, 'packages', workspace),
    env: {
      ...env,
      [VALKEY_URL_ENV]: url,
      [VALKEY_LIVE_ENV]: '1',
      JSAILS_TEST_SERVICES: [...services].sort().join(','),
    },
  };
}

/**
 * The app-owned Valkey connection provider every Valkey consumer takes its
 * clients from, as an app's `valkeyPlugin` would build it. Its errors are
 * redacted of the URL before they are printed.
 */
async function openValkeyConnections(url, prefix, label) {
  const { createValkeyConnections } = await import(DIST_PLUGIN_SDK_URL);
  return createValkeyConnections(url, {
    appPrefix: prefix,
    name: 'jsails-verify',
    onError: (error) => {
      console.error(`[jsails:verify] ${label} error: ${redact(describeError(error), [url])}`);
    },
  });
}

/** Delete every key under `namespace` the stage wrote, through the provider's command client. */
async function dropKeys(connections, namespace) {
  const client = await connections.shared('command');
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 1_000);
    cursor = next;
    if (keys.length > 0) await client.unlink(...keys);
  } while (cursor !== '0');
}

async function runJobsStage(api, env) {
  const rawUrl = env[VALKEY_URL_ENV];
  if (rawUrl === undefined || rawUrl === '') {
    return { stage: 'jobs', status: 'skipped', detail: `${VALKEY_URL_ENV} is not set` };
  }
  let url;
  try {
    url = api.assertRedisUrl(rawUrl);
  } catch (error) {
    return { stage: 'jobs', status: 'failed', detail: describeError(error) };
  }

  const jobs = await import(DIST_JOBS_URL);
  const { valkeyJobs } = await import(DIST_JOBS_VALKEY_URL);
  const namespace = `jsails-int-${process.pid}-${Date.now().toString(36)}:verify`;

  let resolveRan;
  const ran = new Promise((resolve) => {
    resolveRan = resolve;
  });
  const Echo = jobs.defineJob({
    name: 'verify.echo',
    schema: z.object({ value: z.string() }),
    handle: (payload) => {
      if (payload.value !== 'ping') throw new Error('unexpected payload');
      resolveRan();
    },
  });
  const queues = jobs.defineQueues({ default: {} });
  const catalog = jobs.createJobCatalog({ queues, definitions: [Echo] });

  const connections = await openValkeyConnections(url, namespace, 'jobs valkey');
  let adapter;
  let producer;
  let worker;
  let primaryError;
  try {
    await withTimeout(
      (async () => {
        adapter = await valkeyJobs({
          connections,
          onError: (error) => {
            console.error(`[jsails:verify] jobs error: ${redact(describeError(error), [url])}`);
          },
        })({ namespace, queues: queues.declarations });
        producer = jobs.createProducer({ catalog, adapter });
        worker = await jobs.startRuntimeWorker({ catalog, adapter, jobs: producer });
        const first = await producer.dispatch(Echo.with({ value: 'ping' }), { key: 'verify' });
        const again = await producer.dispatch(Echo.with({ value: 'ping' }), { key: 'verify' });
        if (first.deduplicated || !again.deduplicated || again.id !== first.id) {
          throw new Error('a keyed dispatch was not deduplicated');
        }
        await ran;
        await jobs.reconcileSchedules(
          adapter,
          [jobs.schedule('verify-echo', Echo.with({ value: 'scheduled' }), { everyMs: 60_000 })],
          { app: 'verify', by: 'verify-integrations' },
        );
        const stored = await adapter.capabilities.schedules.read();
        if (stored.schedules.length !== 1) throw new Error('the schedule was not stored');
      })(),
      JOBS_TIMEOUT_MS,
      'echo job round-trip',
    );
  } catch (error) {
    primaryError = error;
  }

  try {
    await worker?.drain({ deadlineMs: JOBS_TIMEOUT_MS });
    producer?.close();
    await adapter?.close();
    await dropKeys(connections, namespace);
  } catch (error) {
    primaryError ??= error;
  }
  // The adapter never closes the provider it was given; the stage owns it.
  await connections.close().catch(() => {});

  if (primaryError !== undefined) {
    return {
      stage: 'jobs',
      status: 'failed',
      detail: redact(describeError(primaryError), [url]),
    };
  }

  const suite = valkeySuiteRun('jobs', env, url);
  try {
    execFileSync(suite.command, suite.args, {
      cwd: suite.cwd,
      env: suite.env,
      stdio: 'inherit',
      timeout: VALKEY_SUITE_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      stage: 'jobs',
      status: 'failed',
      detail: `@jsails/jobs suite against Valkey: ${redact(describeError(error), [url])}`,
    };
  }
  return {
    stage: 'jobs',
    status: 'ok',
    detail:
      'echo job dispatched, deduplicated, run, and scheduled on @jsails/jobs/valkey; @jsails/jobs suite reconciled on Valkey',
  };
}

// ---------------------------------------------------------------------------
// Stage C: broadcast pub/sub
// ---------------------------------------------------------------------------

function listen(httpServer) {
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
}

function connectRaw(port, authorization) {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    path: BROADCAST_PATH,
    transports: ['websocket'],
    reconnection: false,
    timeout: 2000,
    extraHeaders: { Origin: BROADCAST_ORIGIN, Authorization: authorization },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('broadcast connect timed out'));
    }, BROADCAST_CONNECT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function subscribeRaw(socket, channels) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe ack timed out')), BROADCAST_ACK_MS);
    socket.emit(SUBSCRIBE_EVENT, { channels }, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function nextRawEvent(socket) {
  return new Promise((resolve, reject) => {
    const handler = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(BROADCAST_EVENT, handler);
      reject(new Error('broadcast event timed out'));
    }, BROADCAST_EVENT_MS);
    socket.on(BROADCAST_EVENT, handler);
  });
}

async function runBroadcastStage(api, env) {
  const rawUrl = env[VALKEY_URL_ENV];
  if (rawUrl === undefined || rawUrl === '') {
    return { stage: 'broadcast', status: 'skipped', detail: `${VALKEY_URL_ENV} is not set` };
  }
  let url;
  try {
    url = api.assertRedisUrl(rawUrl);
  } catch (error) {
    return { stage: 'broadcast', status: 'failed', detail: describeError(error) };
  }

  const httpServer = createServer();
  const sockets = [];
  let broadcast;
  let connections;
  try {
    connections = await openValkeyConnections(
      url,
      `jsails-int-broadcast-${process.pid}`,
      'broadcast valkey',
    );
    broadcast = await api.attachBroadcast(httpServer, {
      allowedOrigins: [BROADCAST_ORIGIN],
      authenticate: (handshake) => {
        const auth = handshake.headers.authorization;
        return typeof auth === 'string' && auth.startsWith('Bearer ')
          ? auth.slice('Bearer '.length)
          : null;
      },
      authorizeChannel: (identity, channel) => channel === `room-${identity}`,
      valkey: connections,
      onError: (error) => {
        console.error(`[jsails:verify] broadcast error: ${redact(describeError(error), [url])}`);
      },
    });
    await listen(httpServer);
    const port = httpServer.address().port;

    const clientA = await connectRaw(port, 'Bearer user-a');
    sockets.push(clientA);
    const clientB = await connectRaw(port, 'Bearer user-b');
    sockets.push(clientB);

    const authorized = await subscribeRaw(clientA, ['room-user-a']);
    if (authorized?.ok !== true) {
      throw new Error('authorized subscription was rejected');
    }

    // channel authorization: user-b is not allowed into room-user-a.
    const denied = await subscribeRaw(clientB, ['room-user-a']);
    if (denied?.ok !== false || denied?.error !== 'unauthorized') {
      throw new Error('unauthorized subscription was not denied');
    }

    const pending = nextRawEvent(clientA);
    broadcast.emit('room-user-a', 'greeting', { hello: 'world' });
    const event = await pending;
    if (event?.channel !== 'room-user-a' || event?.event !== 'greeting') {
      throw new Error('broadcast did not deliver the expected event');
    }
  } catch (error) {
    return {
      stage: 'broadcast',
      status: 'failed',
      detail: redact(describeError(error), [url]),
    };
  } finally {
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // Socket close is best-effort; a throwing close must not mask the result.
      }
    }
    if (broadcast !== undefined) {
      await broadcast.close().catch(() => {});
    } else {
      await new Promise((resolve) => httpServer.close(() => resolve()));
    }
    await connections?.close().catch(() => {});
  }
  return { stage: 'broadcast', status: 'ok', detail: 'pub/sub delivery + channel authorization' };
}

// ---------------------------------------------------------------------------
// Stage E: S3Disk live (S3-compatible object store)
// ---------------------------------------------------------------------------

/**
 * Run the compiled `S3Disk` live test against the real store pointed at by the
 * `S3_*` variables. Skips when `JSAILS_TEST_S3` is not `"1"`; when enabled but
 * the compiled test is missing, or the test run reports failures, the stage
 * fails. The test itself creates its bucket and exercises write/read/stat/
 * list/delete, a nested prefix, multipart writes, a signed URL, and a 512 MiB
 * streamed write.
 */
async function runS3Stage(env) {
  if (env[S3_ENV] !== '1') {
    return { stage: 's3', status: 'skipped', detail: `${S3_ENV} is not "1"` };
  }
  if (!existsSync(S3_LIVE_TEST)) {
    return {
      stage: 's3',
      status: 'failed',
      detail: `compiled S3 live test missing (run "npm run build" first)`,
    };
  }
  try {
    execFileSync(process.execPath, ['--test', S3_LIVE_TEST], {
      stdio: 'inherit',
      timeout: 60_000,
      env,
    });
    return {
      stage: 's3',
      status: 'ok',
      detail: 'S3Disk write/read/stat/list/delete, multipart, signed URL',
    };
  } catch (error) {
    return { stage: 's3', status: 'failed', detail: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// Stage F: live change log (Valkey Streams)
// ---------------------------------------------------------------------------

/**
 * Run the compiled live change-log test against the real Valkey pointed at by
 * `VALKEY_URL`. Skips when `JSAILS_TEST_VALKEY` is not `"1"`; when enabled but
 * the compiled test is missing, or the test run reports failures, the stage
 * fails. The test uses a unique key prefix and deletes it afterwards, so a
 * shared development server is not polluted.
 */
async function runValkeyLiveStage(env) {
  if (env[VALKEY_LIVE_ENV] !== '1') {
    return { stage: 'live', status: 'skipped', detail: `${VALKEY_LIVE_ENV} is not "1"` };
  }
  if (!existsSync(VALKEY_LIVE_TEST)) {
    return {
      stage: 'live',
      status: 'failed',
      detail: `compiled live change-log test missing (run "npm run build" first)`,
    };
  }
  try {
    execFileSync(process.execPath, ['--test', VALKEY_LIVE_TEST], {
      stdio: 'inherit',
      timeout: 60_000,
      env,
    });
    return { stage: 'live', status: 'ok', detail: 'Valkey stream append/since/notify' };
  } catch (error) {
    return { stage: 'live', status: 'failed', detail: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// Stage G: cache and lease stores
// ---------------------------------------------------------------------------

/**
 * Run the `@jsails/cache` suite against the Valkey at `VALKEY_URL`, its live
 * files enabled. Every case keys under its own prefix and every key carries a
 * TTL, so a shared server is not polluted.
 */
async function runCacheStage(api, env) {
  const rawUrl = env[VALKEY_URL_ENV];
  if (rawUrl === undefined || rawUrl === '') {
    return { stage: 'cache', status: 'skipped', detail: `${VALKEY_URL_ENV} is not set` };
  }
  let url;
  try {
    url = api.assertRedisUrl(rawUrl);
  } catch (error) {
    return { stage: 'cache', status: 'failed', detail: describeError(error) };
  }
  const suite = valkeySuiteRun('cache', env, url);
  try {
    execFileSync(suite.command, suite.args, {
      cwd: suite.cwd,
      env: suite.env,
      stdio: 'inherit',
      timeout: VALKEY_SUITE_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      stage: 'cache',
      status: 'failed',
      detail: `@jsails/cache suite against Valkey: ${redact(describeError(error), [url])}`,
    };
  }
  return {
    stage: 'cache',
    status: 'ok',
    detail: 'cache, lease and defined-cache conformance and two-process invalidation on Valkey',
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function printSummary(results) {
  for (const { stage, status, detail } of results) {
    const suffix = detail === '' ? '' : ` (${detail})`;
    console.log(`stage ${stage}: ${status}${suffix}`);
  }
  const ok = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  console.log(`SUMMARY ok=${ok} failed=${failed} skipped=${skipped}`);
}

export const STAGES = Object.freeze([
  'database',
  'jobs',
  'broadcast',
  'jamal',
  'jamal-secrets',
  's3',
  'live',
  'cache',
]);

/** The stages a comma-separated `--require`/`--only` value names, or `null` when it names none or an unknown one. */
function stageList(value) {
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return names.length === 0 || names.some((name) => !STAGES.includes(name)) ? null : names;
}

/**
 * The `--require` and `--only` stages of `args`: `{ required, only }`, where
 * `only` is every stage when the flag is absent, or `{ error }` for a usage
 * error.
 */
export function stageOptions(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: { require: { type: 'string' }, only: { type: 'string' } },
      strict: true,
    }));
  } catch {
    return { error: 'the options are --require <stages> and --only <stages>' };
  }
  const required = values.require === undefined ? [] : stageList(values.require);
  const only = values.only === undefined ? [...STAGES] : stageList(values.only);
  if (required === null || only === null) {
    return { error: `--require and --only take a comma-separated list of: ${STAGES.join(', ')}` };
  }
  const excluded = required.filter((name) => !only.includes(name));
  if (excluded.length > 0) {
    return { error: `--require names stages --only leaves out: ${excluded.join(', ')}` };
  }
  return { required, only };
}

/** Record every required stage that was skipped as a failure. */
function enforceRequired(results, required) {
  return results.map((result) =>
    required.includes(result.stage) && result.status === 'skipped'
      ? { ...result, status: 'failed', detail: `required but skipped: ${result.detail}` }
      : result,
  );
}

async function main() {
  const options = stageOptions(process.argv.slice(2));
  if ('error' in options) {
    console.error(options.error);
    process.exitCode = 2;
    return;
  }
  const { required, only } = options;
  if (!existsSync(DIST_INDEX)) {
    console.error(`Missing build output: ${DIST_INDEX} does not exist. Run "npm run build" first.`);
    process.exitCode = 1;
    return;
  }

  const api = await import(DIST_INDEX_URL);

  // This harness is a test: it resolves the `test` environment (`.env` then
  // `.env.test`, the `*_test` database) instead of the development one, so it
  // never touches dev data and its throwaway `verify_widgets` table lands in
  // the test database. It fills in the resolved values only: it is not a
  // JSails command, so the processes it starts resolve their own environment.
  const { resolveEnvironment } = await import(
    pathToFileURL(join(repoRoot, 'core', 'dist', 'src', 'environment', 'resolve.js')).href
  );
  const resolved = resolveEnvironment({ rootDir: process.cwd(), name: 'test', secrets: 'unused' });
  for (const [key, value] of Object.entries(resolved.values)) {
    if (resolved.sources[key] !== 'process') process.env[key] = value;
  }
  process.env.NODE_ENV ??= 'test';

  const env = process.env;

  const log = (line) => console.log(`[jsails:verify] ${line}`);
  const runners = {
    database: () => runDatabaseStage(api, env),
    jobs: () => runJobsStage(api, env),
    broadcast: () => runBroadcastStage(api, env),
    jamal: () => runJamalStage(env, { log }),
    'jamal-secrets': () => runJamalSecretsStage(env, { log }),
    s3: () => runS3Stage(env),
    live: () => runValkeyLiveStage(env),
    cache: () => runCacheStage(api, env),
  };
  let results = [];
  for (const stage of STAGES) {
    if (only.includes(stage)) results.push(await runners[stage]());
  }
  results = enforceRequired(results, required);

  printSummary(results);
  process.exitCode = results.some((r) => r.status === 'failed') ? 1 : 0;
}

if (import.meta.main) await main();
