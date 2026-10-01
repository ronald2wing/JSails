/**
 * The live Valkey the opt-in tests of this directory run against, and a
 * namespace per adapter so tests share one server without touching each
 * other's keys.
 *
 * Opt-in: a live file runs only when `JSAILS_TEST_VALKEY` is `"1"` and
 * `VALKEY_URL` is set (the convention of `packages/live`'s live test);
 * otherwise it registers one skipped test saying so and nothing connects.
 * The jobs stage of `npm run verify:integrations` runs this package through
 * `scripts/run-tests.mjs` that way, with the `valkey` service declared.
 *
 * {@link valkeyTransport} is the runtime driver's transport over the live
 * server: under virtual time the schedules run on the virtual clock (the
 * adapter's `clock`) and delayed jobs fall due on it through the adapter's
 * `promoteDue` hook, which stands for the server's clock reaching their
 * time; everything else runs on real time. An unawaited failure the adapter
 * reports fails the scenario when its driver closes.
 */

import { createValkeyConnections, type ValkeyConnections } from 'jsails/plugin-sdk';

import { valkeyJobs, ValkeyJobsAdapter, type ValkeyJobsOptions } from '../../src/valkey/index.js';
import type { DriverTransport, DriverTransportFactory } from '../conformance/runtime-driver.js';

/** The server URL, or the empty string when the live tests are off. */
export const VALKEY_URL = process.env.VALKEY_URL?.trim() ?? '';

/** Whether the live tests run. */
export const LIVE = process.env.JSAILS_TEST_VALKEY === '1' && VALKEY_URL !== '';

/** Why a live file skipped. */
export const SKIP_REASON = 'set JSAILS_TEST_VALKEY=1 and VALKEY_URL to run the live Valkey tests';

let sequence = 0;

/** A fresh `<app>:<environment>` namespace no other test uses. */
export function freshNamespace(label: string): string {
  sequence += 1;
  return `jsails-test-${label}-${process.pid}-${Date.now().toString(36)}-${sequence}:test`;
}

/** A connection provider on the live server for one namespace. */
export function liveConnections(namespace: string): ValkeyConnections {
  return createValkeyConnections(VALKEY_URL, {
    appPrefix: namespace,
    name: 'jsails-jobs-test',
    // A script deadline long enough for a loaded CI server.
    timeouts: { commandMs: 10_000 },
  });
}

/** Delete every key under `namespace`, then close `connections`. */
export async function dropNamespace(
  connections: ValkeyConnections,
  namespace: string,
): Promise<void> {
  try {
    const client = await connections.shared('command');
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 1_000);
      cursor = next;
      if (keys.length > 0) await client.unlink(...keys);
    } while (cursor !== '0');
  } finally {
    await connections.close();
  }
}

/** A Valkey adapter on a fresh namespace of the live server, and how to drop it. */
export interface LiveAdapter {
  readonly adapter: ValkeyJobsAdapter;
  readonly connections: ValkeyConnections;
  readonly namespace: string;
  /** Unawaited failures the adapter reported. */
  readonly reported: readonly Error[];
  /** Close the adapter, then delete the namespace's keys and close its connections. */
  close(): Promise<void>;
}

/** Build a Valkey adapter on a fresh namespace for `queues`. */
export async function liveAdapter(
  label: string,
  queues: Parameters<ReturnType<typeof valkeyJobs>>[0]['queues'],
  options: Omit<ValkeyJobsOptions, 'connections' | 'onError'> = {},
): Promise<LiveAdapter> {
  const namespace = freshNamespace(label);
  const connections = liveConnections(namespace);
  const reported: Error[] = [];
  let built: unknown;
  try {
    built = await valkeyJobs({
      ...options,
      connections,
      onError: (error) => reported.push(error),
    })({ namespace, queues });
  } catch (error) {
    await dropNamespace(connections, namespace);
    throw error;
  }
  if (!(built instanceof ValkeyJobsAdapter)) throw new Error('not the Valkey adapter');
  const adapter = built;
  return {
    adapter,
    connections,
    namespace,
    reported,
    async close() {
      try {
        await adapter.close();
      } finally {
        await dropNamespace(connections, namespace);
      }
    },
  };
}

/** The runtime driver's transport over the live server. */
export const valkeyTransport: DriverTransportFactory = async ({
  queues,
  clock,
  virtualTime,
}): Promise<DriverTransport> => {
  const live = await liveAdapter('conformance', queues, { clock });
  const { adapter } = live;
  return {
    adapter,
    busy: () => adapter.busy(),
    redeliver: (id) => adapter.redeliver(id),
    evictCompleted: (queue) => adapter.evictCompleted(queue),
    quiesce: async (now) => {
      await adapter.schedulesIdle();
      if (virtualTime) await adapter.promoteDue(now);
    },
    close: async () => {
      // The driver closed the adapter already; closing it again is a no-op.
      await live.close();
      if (live.reported.length > 0) {
        throw new Error(
          `the adapter reported ${live.reported.length} unawaited failures: ${live.reported
            .map((error) => error.message)
            .join('; ')}`,
        );
      }
    },
  };
};
