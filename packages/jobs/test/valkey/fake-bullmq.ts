/**
 * A fake of the BullMQ surface the Valkey transport uses
 * (`BullmqModule`) and of a Valkey connection provider, so the option
 * mapping, the outcome mapping and the transport's own records run in the
 * default suite with no server.
 *
 * - Queues and the flow producer record what they store. An add under a job
 *   id the queue already holds stores nothing and hands back that id, and a
 *   deduplication id seen before hands back the first job's id, as BullMQ
 *   does. A flow producer's bulk add is one transaction: when any of its
 *   jobs cannot be stored, none is.
 * - Workers keep their processor, so a test delivers fake jobs to it and
 *   emits BullMQ's `completed` and `failed` events itself.
 * - Every script run is recorded under the script's name in
 *   `ValkeyScripts` and answered by `FakeBackend.scriptReply`, which may
 *   return a promise to hold the script open.
 * - `events` logs, in order, every close and disconnect, so a test pins what
 *   a shutdown closed and when.
 */

import type { ValkeyClient, ValkeyConnections } from 'jsails/plugin-sdk';

import type {
  BullFlowJob,
  BullFlowProducer,
  BullJob,
  BullJobOptions,
  BullmqModule,
  BullProcessor,
  BullQueue,
  BullWorker,
  BullWorkerOptions,
} from '../../src/valkey/bullmq-surface.js';
import { bindValkeyScripts, type ValkeyScripts } from '../../src/valkey/valkey-scripts.js';

/** The name of one of the transport's scripts. */
export type ScriptName = keyof ValkeyScripts;

/** One script run. */
export interface ScriptCall {
  readonly script: ScriptName;
  readonly keys: readonly string[];
  readonly args: readonly (string | number)[];
}

/** One add a fake queue or the fake flow producer stored. */
export interface RecordedAdd {
  readonly queue: string;
  readonly name: string;
  readonly data: unknown;
  readonly options: BullJobOptions;
  /** Whether it came through the flow producer's transaction. */
  readonly flow: boolean;
}

/** One move or update a fake job saw, in order. */
export type JobCall =
  | { readonly call: 'moveToWait'; readonly token: string | undefined }
  | {
      readonly call: 'moveToDelayed';
      readonly timestamp: number;
      readonly token: string | undefined;
    }
  | { readonly call: 'updateProgress'; readonly progress: number }
  | { readonly call: 'updateData'; readonly data: unknown }
  | { readonly call: 'retry'; readonly state: string | undefined }
  | { readonly call: 'promote' };

/** A fake delivered or loaded job. */
export interface FakeJob extends BullJob {
  readonly calls: JobCall[];
}

/** Build a delivered job carrying `data`. */
export function fakeJob(
  data: unknown,
  fields: {
    readonly id?: string;
    readonly attemptsMade?: number;
    readonly attempts?: number;
    readonly stalledCounter?: number;
    readonly progress?: unknown;
    readonly failMoves?: boolean;
    /** What `retry` rejects with, when set. */
    readonly retryError?: Error;
  } = {},
): FakeJob {
  const calls: JobCall[] = [];
  const move = (): Promise<void> =>
    fields.failMoves === true ? Promise.reject(new Error('lost lock')) : Promise.resolve();
  return {
    id: fields.id ?? 'job-1',
    name: isRecord(data) && typeof data.name === 'string' ? data.name : 'job',
    data,
    attemptsMade: fields.attemptsMade ?? 0,
    stalledCounter: fields.stalledCounter ?? 0,
    progress: fields.progress ?? 0,
    opts: { attempts: fields.attempts ?? 1 },
    calls,
    updateData(next) {
      calls.push({ call: 'updateData', data: next });
      return Promise.resolve();
    },
    updateProgress(progress) {
      calls.push({ call: 'updateProgress', progress });
      return Promise.resolve();
    },
    moveToDelayed(timestamp, token) {
      calls.push({ call: 'moveToDelayed', timestamp, token });
      return move();
    },
    moveToWait(token) {
      calls.push({ call: 'moveToWait', token });
      return move().then(() => 0);
    },
    retry(state) {
      calls.push({ call: 'retry', state });
      return fields.retryError === undefined
        ? Promise.resolve()
        : Promise.reject(fields.retryError);
    },
    promote() {
      calls.push({ call: 'promote' });
      return Promise.resolve();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A fake worker: its processor, its options, and its listeners. */
export interface FakeWorker extends BullWorker {
  readonly queue: string;
  readonly processor: BullProcessor;
  readonly options: BullWorkerOptions;
  readonly closed: boolean;
  emit(event: 'completed' | 'failed', job: BullJob): void;
}

/** Everything the fakes recorded, and the knobs a test turns. */
export interface FakeBackend {
  readonly module: BullmqModule;
  readonly connections: ValkeyConnections;
  readonly adds: RecordedAdd[];
  readonly workers: FakeWorker[];
  /** Dedicated connections handed out, by name, and whether each was disconnected. */
  readonly dedicated: { readonly name: string; disconnected: boolean }[];
  readonly scriptCalls: ScriptCall[];
  /** Closes and disconnects, in order: `close <queue>`, `close flows`, `close worker <queue>`, `disconnect <name>`. */
  readonly events: string[];
  /** Jobs `getJob` finds, by `<queue>:<id>`. */
  readonly jobs: Map<string, FakeJob>;
  /** Answers a script run; defaults to 0. */
  scriptReply: (script: ScriptName, keys: readonly string[], args: readonly unknown[]) => unknown;
  /** Makes every add reject while set. */
  failAdds: boolean;
  /** Adds to these queues reject; a flow transaction holding one stores nothing. */
  readonly failQueues: Set<string>;
  /** When set, a dedicated connection is handed out only once its promise resolves. */
  connectGate: ((name: string) => Promise<void>) | undefined;
  /** When set, every queue's `waitUntilReady` rejects with it, as for a server that cannot be reached. */
  readyError: Error | undefined;
}

class NamedError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** Each script's name, by its Lua source. */
const SCRIPT_NAMES: ReadonlyMap<string, ScriptName> = (() => {
  const probe = bindValkeyScripts({
    script: ({ lua }: { readonly lua: string }) => ({ lua }),
  } as unknown as ValkeyConnections);
  return new Map(
    Object.entries(probe).map(([name, script]) => [
      (script as unknown as { readonly lua: string }).lua,
      name as ScriptName,
    ]),
  );
})();

/** A fresh fake backend. */
export function fakeBackend(): FakeBackend {
  const deduplicated = new Map<string, string>();
  const stored = new Set<string>();
  // The closures below run after `backend` is assigned at the end.
  const refusal = (queue: string): Error | undefined =>
    backend.failAdds || backend.failQueues.has(queue) ? new Error('server unreachable') : undefined;
  const store = (
    queue: string,
    name: string,
    data: unknown,
    options: BullJobOptions,
    flow: boolean,
  ): BullJob => {
    if (stored.has(`${queue}:${options.jobId}`)) return fakeJob(data, { id: options.jobId });
    const dedupId = options.deduplication?.id;
    const first = dedupId === undefined ? undefined : deduplicated.get(`${queue}:${dedupId}`);
    if (first !== undefined) return fakeJob(data, { id: first });
    if (dedupId !== undefined) deduplicated.set(`${queue}:${dedupId}`, options.jobId);
    stored.add(`${queue}:${options.jobId}`);
    backend.adds.push({ queue, name, data, options, flow });
    return fakeJob(data, { id: options.jobId });
  };
  const createQueue = (name: string): BullQueue => ({
    add: (jobName, data, options) => {
      const refused = refusal(name);
      return refused === undefined
        ? Promise.resolve(store(name, jobName, data, options, false))
        : Promise.reject(refused);
    },
    getJob: (id) => Promise.resolve(backend.jobs.get(`${name}:${id}`)),
    waitUntilReady: () =>
      backend.readyError === undefined ? Promise.resolve() : Promise.reject(backend.readyError),
    close: () => {
      backend.events.push(`close ${name}`);
      return Promise.resolve();
    },
    on: () => undefined,
  });
  const createFlowProducer = (): BullFlowProducer => ({
    addBulk: (jobs: readonly BullFlowJob[]) => {
      const refused = jobs.map((job) => refusal(job.queueName)).find((error) => error);
      if (refused !== undefined) return Promise.reject(refused);
      for (const job of jobs) store(job.queueName, job.name, job.data, job.opts, true);
      return Promise.resolve();
    },
    waitUntilReady: () => Promise.resolve(),
    close: () => {
      backend.events.push('close flows');
      return Promise.resolve();
    },
    on: () => undefined,
  });
  const createWorker = (
    queue: string,
    processor: BullProcessor,
    options: BullWorkerOptions,
  ): BullWorker => {
    const listeners = new Map<string, ((job: BullJob) => void)[]>();
    const worker: FakeWorker = {
      queue,
      processor,
      options,
      closed: false,
      waitUntilReady: () => Promise.resolve(),
      close() {
        (worker as { closed: boolean }).closed = true;
        backend.events.push(`close worker ${queue}`);
        return Promise.resolve();
      },
      on(event: string, listener: (value: never) => void) {
        const list = listeners.get(event) ?? [];
        list.push(listener as (job: BullJob) => void);
        listeners.set(event, list);
        return worker;
      },
      emit(event, job) {
        for (const listener of listeners.get(event) ?? []) listener(job);
      },
    };
    backend.workers.push(worker);
    return worker;
  };
  const module: BullmqModule = {
    createQueue,
    createWorker,
    createFlowProducer,
    unrecoverable: (message) => new NamedError('UnrecoverableError', message),
    waiting: () => new NamedError('WaitingError', ''),
    delayed: () => new NamedError('DelayedError', ''),
  };
  const client = (name: string): ValkeyClient => {
    const entry = { name, disconnected: false };
    backend.dedicated.push(entry);
    return {
      disconnect: () => {
        entry.disconnected = true;
        backend.events.push(`disconnect ${name}`);
      },
    } as unknown as ValkeyClient;
  };
  const connections: ValkeyConnections = {
    prefix: 'app:test',
    shared: () => Promise.resolve({} as ValkeyClient),
    dedicated: async (_role, name) => {
      await backend.connectGate?.(name);
      return client(name);
    },
    script: ({ lua }) => {
      const script = SCRIPT_NAMES.get(lua);
      if (script === undefined) throw new Error('a script the fake does not know');
      return {
        run: (keys, args) => {
          backend.scriptCalls.push({ script, keys, args });
          return Promise.resolve(backend.scriptReply(script, keys, args));
        },
      };
    },
    close: () => Promise.resolve(),
  };
  const backend: FakeBackend = {
    module,
    connections,
    adds: [],
    workers: [],
    dedicated: [],
    scriptCalls: [],
    events: [],
    jobs: new Map(),
    scriptReply: () => 0,
    failAdds: false,
    failQueues: new Set(),
    connectGate: undefined,
    readyError: undefined,
  };
  return backend;
}

/** A promise held open until `release` (or `fail`) is called. */
export interface Held<T> {
  readonly promise: Promise<T>;
  /** Resolves once the holder first awaited it. */
  readonly reached: Promise<void>;
  /** Mark it reached (the holder calls this as it hands out `promise`). */
  reach(): void;
  release(value: T): void;
  fail(error: Error): void;
}

/** A fresh {@link Held}. */
export function held<T>(): Held<T> {
  let release: (value: T) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  let reach: () => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { promise, reached, reach, release, fail };
}
