/**
 * The cross-instance change bus and stream tailer (docs/design/live.md §9, §13.2).
 *
 * Two mechanisms, deliberately separate:
 *
 * - **Valkey pub/sub** carries the live push. It is fire-and-forget and
 *   sub-millisecond, which is what a fan-out wants, but it cannot replay.
 * - **Valkey Streams** carries the replay log. It can reproduce a suffix, which
 *   is what a reconnecting client needs, but polling it would add latency to
 *   every change.
 *
 * The invariant: every payload a subscriber receives is read from the log, and
 * pub/sub carries only "the stream advanced". The bus never carries a change,
 * so the tailer's read from its own cursor is the single source of what a
 * subscriber sees — the same bytes a resuming client would read. A dropped
 * pub/sub message costs latency, never correctness, because the next
 * notification (or the periodic poll) catches up.
 *
 * Each instance keeps its **own cursor**, not a consumer group: consumer groups
 * are competing consumers, and fan-out needs every instance to see every
 * change.
 */

import {
  reportBackendError,
  resolveValkeyPrefix,
  sanitizeBackendError,
  type ValkeyClient,
  type ValkeyConnections,
} from 'jsails/plugin-sdk';
import type { LiveChange } from 'jsails/live';
import {
  LIVE_KEY_SEGMENT,
  readStreamFrom,
  unavailableError,
  ValkeyChangeLogError,
  type ValkeyLiveClient,
} from './valkey-change-log.js';
import { detach, escalate } from 'jsails/support';

/** Options for {@link createValkeyChangeBus}. */
export interface ValkeyChangeBusOptions {
  /** The app's Valkey connections; the bus never closes them. */
  readonly connections: ValkeyConnections;
  /** Key prefix; the channel is `${prefix}:notify`. Defaults to `<app key prefix>:live`. */
  readonly prefix?: string;
  /** Receives listener and publish failures. Defaults to `process.emitWarning`. */
  readonly onError?: (error: Error) => void;
}

/** A cross-instance "the stream advanced" notification channel. */
export interface ValkeyChangeBus {
  /** Announce that this instance appended. Fire-and-forget. */
  publish(): Promise<void>;
  /** Invoked when any instance announces an append. */
  onNotify(listener: () => void): void;
  close(): Promise<void>;
}

/**
 * Create the pub/sub notification bus on the app's shared `subscriber` and
 * `command` connections.
 *
 * The subscription is made eagerly so a misconfigured deployment fails at
 * startup. Publishing is best-effort: a failed publish is reported and
 * swallowed, because the tailer's periodic poll is the correctness backstop.
 * The connections are shared, so `close` unsubscribes the channel and removes
 * the listener instead of disconnecting.
 */
export async function createValkeyChangeBus(
  options: ValkeyChangeBusOptions,
): Promise<ValkeyChangeBus> {
  const connections = options.connections;
  const prefix = resolveValkeyPrefix(options.prefix, `${connections.prefix}:${LIVE_KEY_SEGMENT}`);
  const channel = `${prefix}:notify`;

  let subscriber: ValkeyClient;
  let publisher: ValkeyClient;
  try {
    [subscriber, publisher] = await Promise.all([
      connections.shared('subscriber'),
      connections.shared('command'),
    ]);
  } catch (error) {
    throw sanitizeBackendError(error, 'live change bus', unavailableError);
  }

  const listeners = new Set<() => void>();
  let closed = false;

  const onMessage = (received: string): void => {
    if (received !== channel) {
      return;
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        reportBackendError(error, options.onError, 'live change bus', unavailableError);
      }
    }
  };
  subscriber.on('message', onMessage);

  try {
    await subscriber.subscribe(channel);
  } catch (error) {
    subscriber.off('message', onMessage);
    throw sanitizeBackendError(error, 'live change bus', unavailableError);
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
        reportBackendError(error, options.onError, 'live change bus', unavailableError);
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
      subscriber.off('message', onMessage);
      try {
        await subscriber.unsubscribe(channel);
      } catch (error) {
        // The subscription ends with the connection anyway; report and go on.
        reportBackendError(error, options.onError, 'live change bus', unavailableError);
      }
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
  /**
   * The sequence the cursor starts at; entries at or below it are never
   * delivered. Defaults to 0 (deliver the whole retained window). The plugin
   * passes the log's current head so a fresh instance does not replay history
   * to subscribers that have not asked for it.
   */
  readonly startAfter?: number;
}

/** A stream reader that advances its own cursor and reports gaps. */
export interface StreamTailer {
  /**
   * Read everything after the cursor. Safe to call concurrently: calls made
   * while a read is already queued share that read, so a burst of
   * notifications costs one read rather than one per notification.
   */
  pump(): Promise<void>;
  /** The last sequence handed to `onChanges`. */
  readonly cursor: number;
  close(): void;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Create a tailer that reads the stream forward from its own cursor.
 *
 * The cursor starts at `startAfter`; a client that wants history resumes
 * explicitly with `resumeFrom`. Reads are serialized so two notifications
 * cannot interleave and deliver out of order, and each read asks the stream
 * only for ids after the cursor.
 *
 * A gap past retention is reported as `truncated`, the entries still retained
 * after it are delivered, and the cursor moves to the newest: the tailer cannot
 * reconstruct what it missed, and stalling would be worse than a documented
 * gap. Clients that need continuity resubscribe with `resumeFrom`, which the
 * service answers with a snapshot.
 */
export function createStreamTailer(options: StreamTailerOptions): StreamTailer {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let cursor = options.startAfter ?? 0;
  let chain: Promise<void> = Promise.resolve();
  /** A read queued behind the running one and not yet started; later pumps join it. */
  let queued: Promise<void> | null = null;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function schedule(): void {
    if (closed || timer !== null) {
      return;
    }
    timer = setInterval(() => {
      detach(pump(), escalate);
    }, pollIntervalMs);
    // A poll timer must not hold the process open on shutdown.
    timer.unref?.();
  }

  async function read(): Promise<void> {
    if (closed) {
      return;
    }
    const from = cursor + 1;
    const slice = await readStreamFrom(options.client, options.streamKey, from);
    if (slice.firstSequence !== undefined && slice.firstSequence > from) {
      // The cursor fell out of the retained window: the missed changes are
      // unrecoverable, and a client that needs them resubscribes with
      // `resumeFrom` to get a snapshot.
      options.onError?.(
        new ValkeyChangeLogError('truncated', 'the live change log trimmed past the tailer cursor'),
      );
    }
    const fresh = slice.changes.filter((change) => change.sequence > cursor);
    const newest = fresh[fresh.length - 1];
    if (newest === undefined) {
      return;
    }
    cursor = newest.sequence;
    options.onChanges(fresh);
  }

  function pump(): Promise<void> {
    if (queued !== null) {
      return queued;
    }
    const next = chain
      .then(() => {
        queued = null;
        return read();
      })
      .catch((error: unknown) => {
        reportBackendError(error, options.onError, 'live change tailer', unavailableError);
      });
    queued = next;
    chain = next;
    return next;
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
