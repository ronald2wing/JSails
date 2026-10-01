/**
 * The end-to-end harness the flow property tests share: a seeded generator
 * (seeds from `JSAILS_PROPERTY_SEED`, else a fixed list), and a memory
 * adapter on a virtual clock with a producer and a runtime worker over the
 * given definitions, settled by polling the adapter.
 */

import type { z } from 'zod';

import { createJobCatalog } from '../../src/definition/catalog.js';
import type { JobDefinition } from '../../src/definition/define-job.js';
import { createProducer, type JobProducer } from '../../src/definition/jobs-service.js';
import { MemoryJobsAdapter } from '../../src/memory/memory-adapter.js';
import { defineQueues } from '../../src/queues/queue-set.js';
import { startRuntimeWorker, type RuntimeWorker } from '../../src/runtime/runtime-worker.js';
import { VirtualClock } from '../timing/virtual-clock.js';

const SETTLE_BOUND_MS = 5_000;
const DEFAULT_SEEDS = Array.from({ length: 40 }, (_, index) => 1 + index * 7_919);

/** The seeds to run: the one in `JSAILS_PROPERTY_SEED`, or the fixed list. */
export function propertySeeds(): readonly number[] {
  const pinned = process.env.JSAILS_PROPERTY_SEED;
  return pinned === undefined || pinned === '' ? DEFAULT_SEEDS : [Number(pinned)];
}

/** mulberry32: a small seeded generator, so a failing trial replays from its seed. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function integer(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

export interface Trial {
  readonly adapter: MemoryJobsAdapter;
  readonly producer: JobProducer;
  settle(): Promise<void>;
  close(): Promise<void>;
}

/** A memory adapter, producer and worker over `definitions`. */
export async function startTrial(
  definitions: readonly JobDefinition<string, z.ZodType, 'default'>[],
): Promise<Trial> {
  const clock = new VirtualClock(1_700_000_000_000);
  const catalog = createJobCatalog({ queues: defineQueues({ default: {} }), definitions });
  const adapter = new MemoryJobsAdapter(
    { namespace: 'property:test', queues: catalog.queues.declarations },
    { clock },
  );
  const producer = createProducer({ catalog, adapter, clock });
  const worker: RuntimeWorker = await startRuntimeWorker({ catalog, adapter, jobs: producer });
  return {
    adapter,
    producer,
    async settle() {
      const deadline = performance.now() + SETTLE_BOUND_MS;
      let quiet = 0;
      while (quiet < 3) {
        await new Promise((resolve) => setImmediate(resolve));
        quiet = adapter.busy() ? 0 : quiet + 1;
        if (performance.now() > deadline) throw new Error('the trial did not settle');
      }
    },
    async close() {
      await worker.abort();
      producer.close();
      await adapter.close();
    },
  };
}
