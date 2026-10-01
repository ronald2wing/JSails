/**
 * Cross-process tag invalidation against a real Valkey: a reader in a child
 * process holds a `process`-tier defined cache warm, and this process changes
 * the source and invalidates the tag. The reader must serve the new value
 * within the bus latency when the Valkey tag bus is on (its sync is set to an
 * hour, so only the bus can tell it), and within its `syncMs` when the bus is
 * off (the `getMany` backstop is then the only signal). The entry's TTL is an
 * hour, so expiry never explains a reload.
 *
 * Opt-in like the package's other live file: it runs only when
 * `JSAILS_TEST_VALKEY` is `"1"` and `VALKEY_URL` is set, which the `cache`
 * stage of `npm run verify:integrations` arranges. Every run keys under its own
 * app prefix and channel; the source key expires on its own.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, test } from 'node:test';

import { createCacheTags, type CacheStore, type CacheTags } from 'jsails/cache';
import { createValkeyConnections, type ValkeyConnections } from 'jsails/plugin-sdk';

import { ValkeyCacheStore, ValkeyTagBus } from '../src/index.js';

const url = process.env.VALKEY_URL?.trim() ?? '';
const gated = process.env.JSAILS_TEST_VALKEY === '1' && url !== '';

/** The reader's sync interval when the bus is on: far beyond any bound below. */
const BUS_ONLY_SYNC_MS = 3_600_000;

/** The reader's sync interval when the bus is off. */
const SYNC_MS = 1000;

/**
 * How long a bus delivery may take: a publish, a delivery, one token read and
 * one reload, on a loaded runner. Far below {@link BUS_ONLY_SYNC_MS}.
 */
const BUS_BOUND_MS = 2000;

/** How far past `syncMs` the backstop may land: a tick in flight, a round trip, the reader's poll. */
const SYNC_SLACK_MS = 2000;

/** How long the reader may take to start and load the first value. */
const START_BOUND_MS = 20_000;

/**
 * The reader: its own connections, store and tag table over the app prefix it
 * is given, one `process`-tier cache whose loader reads the source key, and a
 * poll that prints every value change as one JSON line. It stops when its
 * stdin closes.
 */
const READER = `
  import { ValkeyCacheStore, ValkeyTagBus } from '@jsails/cache';
  import { cacheToken, createCacheTags, defineCache } from 'jsails/cache';
  import { createValkeyConnections } from 'jsails/plugin-sdk';
  import { setTimeout as sleep } from 'node:timers/promises';

  const env = process.env;
  const connections = createValkeyConnections(env.VALKEY_URL, {
    appPrefix: env.JSAILS_TAG_PROBE_PREFIX,
    name: 'tag-probe-reader',
  });
  const root = new ValkeyCacheStore({ connections });
  const tags = createCacheTags({
    store: root.namespace('jsails.tags'),
    syncMs: Number(env.JSAILS_TAG_PROBE_SYNC_MS),
    ...(env.JSAILS_TAG_PROBE_BUS === '1' ? { bus: new ValkeyTagBus({ connections }) } : {}),
  });
  const services = {
    get: (token) => (token === cacheToken ? { cache: (name) => root.namespace(name) } : tags),
  };
  const cache = defineCache(services, {
    name: 'probe',
    ttlMs: 3_600_000,
    tier: 'process',
    tags: () => ['probe'],
  });
  const source = root.namespace('source');
  let stopping = false;
  process.stdin.on('end', () => {
    stopping = true;
  });
  process.stdin.resume();
  let last;
  while (!stopping) {
    const value = await cache.get('k', async () => (await source.get('version')) ?? 'none');
    if (value !== last) {
      last = value;
      process.stdout.write(JSON.stringify({ value }) + '\\n');
    }
    await sleep(5);
  }
  await tags.close();
  await root.close();
  await connections.close();
`;

interface Reader {
  /** Resolves once the reader printed `value`, or rejects past `ms`. */
  until(value: string, ms: number): Promise<void>;
  stop(): Promise<void>;
}

/** Start the reader over `prefix`; its output is matched line by line. */
function startReader(prefix: string, options: { bus: boolean; syncMs: number }): Reader {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JSAILS_TAG_PROBE_PREFIX: prefix,
    JSAILS_TAG_PROBE_SYNC_MS: String(options.syncMs),
    JSAILS_TAG_PROBE_BUS: options.bus ? '1' : '0',
  };
  delete env.NODE_TEST_CONTEXT;
  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
    process.execPath,
    ['--input-type=module', '-e', READER],
    { cwd: new URL('../..', import.meta.url), env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const seen = new Set<string>();
  const waiters = new Set<() => void>();
  let stderr = '';
  let exited: number | null | undefined;
  const closed = new Promise<void>((resolve) => {
    child.on('close', (status) => {
      exited = status;
      for (const wake of waiters) wake();
      resolve();
    });
  });
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') continue;
      seen.add(String((JSON.parse(line) as { value: unknown }).value));
      for (const wake of waiters) wake();
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return {
    async until(value, ms) {
      const deadline = performance.now() + ms;
      while (!seen.has(value)) {
        if (exited !== undefined) {
          assert.fail(
            `the reader exited (status ${String(exited)}) before printing ${value}: ${stderr.slice(0, 1000)}`,
          );
        }
        const left = deadline - performance.now();
        if (left <= 0) assert.fail(`the reader did not print ${value} within ${String(ms)} ms`);
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const done = (): void => {
            clearTimeout(timer);
            waiters.delete(done);
            resolve();
          };
          waiters.add(done);
          timer = setTimeout(done, left);
        });
      }
    },
    async stop() {
      if (exited === undefined) child.stdin.end();
      const outcome = await Promise.race([closed.then(() => 'closed'), sleep(10_000)]);
      if (outcome !== 'closed') {
        child.kill('SIGKILL');
        await closed;
      }
    },
  };
}

/** This process's side: the source store and a tag table over the same prefix. */
interface Writer {
  readonly source: CacheStore;
  readonly tags: CacheTags;
  close(): Promise<void>;
}

function startWriter(prefix: string, bus: boolean): Writer {
  const connections: ValkeyConnections = createValkeyConnections(url, {
    appPrefix: prefix,
    name: 'tag-probe-writer',
  });
  const root = new ValkeyCacheStore({ connections });
  const tags = createCacheTags({
    store: root.namespace('jsails.tags'),
    syncMs: BUS_ONLY_SYNC_MS,
    ...(bus ? { bus: new ValkeyTagBus({ connections }) } : {}),
  });
  return {
    source: root.namespace('source'),
    tags,
    async close() {
      await tags.close();
      await root.close();
      await connections.close();
    },
  };
}

let runs = 0;

function uniquePrefix(): string {
  runs += 1;
  return `jsails-cache-live:tags:${String(process.pid)}:${String(Date.now())}:${String(runs)}`;
}

/** Warm the reader, change the source, invalidate, and time how long the reader takes. */
async function measure(options: {
  bus: boolean;
  syncMs: number;
  boundMs: number;
}): Promise<number> {
  const prefix = uniquePrefix();
  const writer = startWriter(prefix, options.bus);
  const reader = startReader(prefix, options);
  try {
    await writer.source.set('version', '1', 60_000);
    await reader.until('1', START_BOUND_MS);
    await writer.source.set('version', '2', 60_000);
    const started = performance.now();
    await writer.tags.invalidate(['probe']);
    await reader.until('2', options.boundMs);
    return performance.now() - started;
  } finally {
    await reader.stop();
    await writer.close();
  }
}

if (gated) {
  describe('tag invalidation across two processes on a live Valkey', () => {
    it('reaches the other process within the bus latency', async (t) => {
      const elapsed = await measure({
        bus: true,
        syncMs: BUS_ONLY_SYNC_MS,
        boundMs: BUS_BOUND_MS,
      });
      t.diagnostic(`bus delivery took ${elapsed.toFixed(1)} ms`);
    });

    it('reaches the other process within syncMs with the bus off', async (t) => {
      const elapsed = await measure({
        bus: false,
        syncMs: SYNC_MS,
        boundMs: SYNC_MS + SYNC_SLACK_MS,
      });
      t.diagnostic(`sync delivery took ${elapsed.toFixed(1)} ms`);
    });
  });
} else {
  test(
    'tag invalidation across two processes on a live Valkey',
    { skip: 'set JSAILS_TEST_VALKEY=1 and VALKEY_URL' },
    () => {},
  );
}
