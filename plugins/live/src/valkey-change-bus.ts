/**
 * The cross-instance change bus and stream tailer (LIVE-PLAN.md §9, Phase 7).
 *
 * Two mechanisms, deliberately separate:
 *
 * - **Valkey pub/sub** carries the live push. It is fire-and-forget and
 *   sub-millisecond, which is what a fan-out wants, but it cannot replay.
 * - **Valkey Streams** carries the replay log. It can reproduce a suffix, which
 *   is what a reconnecting client needs, but polling it would add latency to
 *   every change.
 *
 * Using one for both is the mistake revision 1 made. The bus only says "the
 * stream advanced"; the tailer then reads the stream from its own cursor, so
 * the payload a subscriber receives always comes from the log — the same bytes
 * a resuming client would read. A dropped pub/sub message costs latency, never
 * correctness, because the next notification (or the periodic poll) catches up.
 *
 * Each instance keeps its **own cursor**, not a consumer group: consumer groups
 * are competing consumers, and fan-out needs every instance to see every
 * change.
 */

import { assertConnectionUrl } from 'jsails/jobs';
import { disconnectQuietly, reportBackendError, sanitizeBackendError } from 'jsails/plugin-sdk';
import type { LiveChange } from 'jsails/live';
import {
  readStreamSlice,
  ValkeyChangeLogError,
  type ValkeyLiveClient,
} from './valkey-change-log.js';

/** The slice of an ioredis client the bus depends on. */
export interface ValkeyBusClient {
  subscribe(channel: string): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  disconnect(): Promise<unknown>;
}

/** Options for {@link createValkeyChangeBus}. */
export interface ValkeyChangeBusOptions {
  /** The `redis://`/`rediss://` URL. Falls back to `VALKEY_URL`. */
  readonly valkeyUrl?: string;
  /** Key prefix; the channel is `${prefix}:notify`. Defaults to `jsails:live`. */
  readonly prefix?: string;
  /** Receives post-connect backend errors. Defaults to `process.emitWarning`. */
  readonly onError?: (error: Error) => void;
  /** Test seam: the subscriber client constructor. Defaults to ioredis. */
  readonly createClient?: (url: string) => ValkeyBusClient;
}

/** A cross-instance "the stream advanced" notification channel. */
export interface ValkeyChangeBus {
  /** Announce that this instance appended. Fire-and-forget. */
  publish(): Promise<void>;
  /** Invoked when any instance announces an append. */
  onNotify(listener: () => void): void;
  close(): Promise<void>;
}

const DEFAULT_PREFIX = 'jsails:live';

/**
 * Create the pub/sub notification bus.
 *
 * The subscriber connects eagerly so a misconfigured deployment fails at
 * startup. Publishing is best-effort: a failed publish is reported and
 * swallowed, because the tailer's periodic poll is the correctness backstop.
 */
export async function createValkeyChangeBus(
  options: ValkeyChangeBusOptions = {},
): Promise<ValkeyChangeBus> {
  const url = resolveUrl(options.valkeyUrl);
  const prefix = resolvePrefix(options.prefix);
  const channel = `${prefix}:notify`;

  const makeError = (message: string, code: string | undefined) =>
    new ValkeyChangeLogError('unavailable', code === undefined ? message : `${message} (${code})`);

  let client: ValkeyBusClient;
  let publisher: ValkeyBusClient;
  try {
    if (options.createClient === undefined) {
      const { Redis } = await import('ioredis');
      const make = (): ValkeyBusClient =>
        new Redis(url, {
          maxRetriesPerRequest: 3,
          lazyConnect: false,
        }) as unknown as ValkeyBusClient;
      client = make();
      publisher = make();
    } else {
      client = options.createClient(url);
      publisher = options.createClient(url);
    }
  } catch (error) {
    throw sanitizeBackendError(error, 'live change bus', makeError);
  }

  const listeners = new Set<() => void>();
  let closed = false;

  client.on('error', (error: unknown) => {
    reportBackendError(error, options.onError, 'live change bus', makeError);
  });
  publisher.on('error', (error: unknown) => {
    reportBackendError(error, options.onError, 'live change bus', makeError);
  });
  client.on('message', (received: string) => {
    if (received !== channel) {
      return;
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        reportBackendError(error, options.onError, 'live change bus', makeError);
      }
    }
  });

  try {
    await client.subscribe(channel);
  } catch (error) {
    disconnectQuietly(client);
    disconnectQuietly(publisher);
    throw sanitizeBackendError(error, 'live change bus', makeError);
  }

  return {
    async publish(): Promise<void> {
      if (closed) {
        return;
      }
      try {
        // The payload is irrelevant: the bus only says "the stream advanced",
        // and the tailer reads the changes from the stream itself.
        await publisher.publish(channel, '1');
      } catch (error) {
        // Best-effort: the tailer's periodic poll is the correctness backstop.
        reportBackendError(error, options.onError, 'live change bus', makeError);
      }
    },

    onNotify(listener: () => void): void {
      listeners.add(listener);
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      listeners.clear();
      disconnectQuietly(client);
      disconnectQuietly(publisher);
    },
  };
}

/** Options for {@link createStreamTailer}. */
export interface StreamTailerOptions {
  /** The client the tailer reads the stream with. */
  readonly client: ValkeyLiveClient;
  /** The stream key. */
  readonly streamKey: string;
  /** Receives changes in sequence order. */
  readonly onChanges: (changes: readonly LiveChange[]) => void;
  /** Receives read failures. Defaults to `process.emitWarning`. */
  readonly onError?: (error: Error) => void;
  /** Poll interval used when no notification arrives. Defaults to 1000 ms. */
  readonly pollIntervalMs?: number;
}

/** A stream reader that advances its own cursor and reports gaps. */
export interface StreamTailer {
  /** Read everything after the cursor now. Safe to call concurrently. */
  pump(): Promise<void>;
  /** The last sequence handed to `onChanges`. */
  readonly cursor: number;
  close(): void;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Create a tailer that reads the stream forward from its own cursor.
 *
 * The cursor starts at the log's current head, so a fresh instance does not
 * replay history to subscribers that have not asked for it — a client that
 * wants history resumes explicitly with `resumeFrom`. Reads are serialized so
 * two notifications cannot interleave and deliver out of order.
 *
 * A gap past retention is reported as `truncated` and the cursor jumps to the
 * newest entry: the tailer cannot reconstruct what it missed, and stalling
 * would be worse than a documented gap. Clients that need continuity resubscribe
 * with `resumeFrom`, which the service answers with a snapshot.
 */
export function createStreamTailer(options: StreamTailerOptions): StreamTailer {
  const makeError = (message: string, code: string | undefined) =>
    new ValkeyChangeLogError('unavailable', code === undefined ? message : `${message} (${code})`);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let cursor = 0;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function schedule(): void {
    if (closed || timer !== null) {
      return;
    }
    timer = setInterval(() => {
      void pump();
    }, pollIntervalMs);
    // A poll timer must not hold the process open on shutdown.
    timer.unref?.();
  }

  async function read(): Promise<void> {
    if (closed) {
      return;
    }
    const slice = await readStreamSlice(options.client, options.streamKey, cursor + 1, makeError);
    if (slice.truncated) {
      // The cursor fell out of the retained window. Report and jump forward:
      // the missed changes are unrecoverable, and a client that needs them
      // resubscribes with `resumeFrom` to get a snapshot.
      const newest = slice.changes[slice.changes.length - 1];
      if (newest !== undefined) {
        cursor = newest.sequence;
      }
      options.onError?.(
        new ValkeyChangeLogError('truncated', 'the live change log trimmed past the tailer cursor'),
      );
      return;
    }
    const fresh = slice.changes.filter((change) => change.sequence > cursor);
    if (fresh.length === 0) {
      return;
    }
    cursor = fresh[fresh.length - 1]!.sequence;
    options.onChanges(fresh);
  }

  function pump(): Promise<void> {
    chain = chain.then(read, read).catch((error: unknown) => {
      reportBackendError(error, options.onError, 'live change tailer', makeError);
    });
    return chain;
  }

  schedule();

  return {
    pump,
    get cursor(): number {
      return cursor;
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/** Resolve and validate the connection URL. Never echoes the value. */
function resolveUrl(value: string | undefined): string {
  const candidate = value ?? process.env.VALKEY_URL;
  return assertConnectionUrl(
    candidate,
    () => new ValkeyChangeLogError('invalid_url', 'the live change bus requires a Valkey URL'),
  );
}

/** Validate the key prefix. */
function resolvePrefix(value: string | undefined): string {
  if (value === undefined) {
    return DEFAULT_PREFIX;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('prefix must be a non-empty string');
  }
  return value;
}
