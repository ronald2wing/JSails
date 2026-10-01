/**
 * `data-jsails-poll` scheduling: the one poll loop shared by component roots
 * and client islands.
 *
 * A loop awaits each refresh before scheduling the next, so refreshes never
 * overlap, and keeps a single deadline (`dueAt`) for the next tick:
 *
 * - after a success, one interval spread by up to 10% either way, so pages
 *   opened together never tick in step;
 * - after consecutive failures, an exponential backoff capped at
 *   {@link MAX_POLL_BACKOFF_MS} (never below one interval), and at least the
 *   `retryAfterMs` a failure carries (a 429 or 503 `Retry-After`);
 * - while the tab is hidden or the browser is offline (each `pause` unless the
 *   marker says `continue`), no timer runs; on return the loop refreshes at
 *   once when the deadline passed meanwhile, and otherwise waits out the rest.
 *
 * The marker is bounded by {@link MAX_POLL_MARKER_LENGTH} and its interval by
 * {@link MIN_POLL_INTERVAL_MS} and {@link MAX_POLL_INTERVAL_MS}, so hostile
 * markup can never drive a tight loop: the lower bound directly, the upper one
 * by keeping every delay below the 2^31 - 1 ms past which a timer fires at once.
 */

import {
  MAX_POLL_INTERVAL_MS,
  MAX_POLL_MARKER_LENGTH,
  MIN_POLL_INTERVAL_MS,
  type ComponentPollOptions,
  type PollPolicy,
} from '../server-components/protocol.js';
import { detach, escalate } from '../support/detach.js';

/** Upper bound of the failure backoff and of an honoured `Retry-After`. */
export const MAX_POLL_BACKOFF_MS: number = 5 * 60 * 1000;

/** Fraction of the delay a tick may move either way. */
const POLL_JITTER = 0.1;

/**
 * Visibility/connectivity signals a poll loop consults to pause and resume.
 * The loop subscribes to changes so it reacts without re-reading markers.
 */
export interface PollSignals {
  /** Whether the document is currently hidden. */
  readonly hidden: boolean;
  /** Whether the browser reports a live connection. */
  readonly online: boolean;
  /** Subscribe to signal changes; returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
}

/** Signals that never report hidden/offline and never fire changes. */
const NO_POLL_SIGNALS: PollSignals = {
  hidden: false,
  online: true,
  onChange: () => () => {},
};

/**
 * Signals backed by `document.hidden` and `navigator.onLine`, listening to
 * `visibilitychange`/`online`/`offline` only while someone is subscribed.
 * Without a `document` the loop never pauses; without `navigator.onLine` the
 * browser counts as online.
 */
export function browserPollSignals(): PollSignals {
  const g = globalThis as {
    document?: {
      hidden?: boolean;
      addEventListener(type: string, listener: () => void): void;
      removeEventListener(type: string, listener: () => void): void;
    };
    navigator?: { onLine?: boolean };
    addEventListener?(type: string, listener: () => void): void;
    removeEventListener?(type: string, listener: () => void): void;
  };
  const documentObject = g.document;
  if (documentObject === undefined) {
    return NO_POLL_SIGNALS;
  }

  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };

  return {
    get hidden(): boolean {
      return documentObject.hidden === true;
    },
    get online(): boolean {
      return g.navigator?.onLine !== false;
    },
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        documentObject.addEventListener('visibilitychange', emit);
        g.addEventListener?.('online', emit);
        g.addEventListener?.('offline', emit);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          documentObject.removeEventListener('visibilitychange', emit);
          g.removeEventListener?.('online', emit);
          g.removeEventListener?.('offline', emit);
        }
      };
    },
  };
}

/** A marker's policy value: absent means `pause`; anything unknown is `null`. */
function readPolicy(value: unknown): PollPolicy | null {
  if (value === undefined || value === 'pause') {
    return 'pause';
  }
  return value === 'continue' ? 'continue' : null;
}

/** A parsed poll marker with every policy resolved. */
export type PollOptions = Required<ComponentPollOptions>;

/** Parse a `data-jsails-poll` marker; `null` when absent, malformed, or out of bounds. */
export function parsePollMarker(raw: string | null): PollOptions | null {
  if (raw === null || raw === '' || raw.length > MAX_POLL_MARKER_LENGTH) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const intervalMs = record.intervalMs;
  if (
    typeof intervalMs !== 'number' ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < MIN_POLL_INTERVAL_MS ||
    intervalMs > MAX_POLL_INTERVAL_MS
  ) {
    return null;
  }
  const whenHidden = readPolicy(record.whenHidden);
  const whenOffline = readPolicy(record.whenOffline);
  if (whenHidden === null || whenOffline === null) {
    return null;
  }
  return { intervalMs, whenHidden, whenOffline };
}

/** A running poll loop; stopping is idempotent. */
export interface PollHandle {
  stop(): void;
}

/** What a poll loop drives. */
export interface PollTarget {
  readonly options: PollOptions;
  readonly signals: PollSignals;
  /** False once the owner can no longer refresh (disposed, blocked); ends scheduling. */
  isActive(): boolean;
  /**
   * One refresh. A rejection counts toward the backoff and is otherwise left
   * to the owner, which reports its own failures; a rejection reason with a
   * finite, non-negative `retryAfterMs` delays the next tick by at least that.
   */
  refresh(): Promise<unknown>;
  /** Uniform `[0, 1)` source for the jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
}

/** The `retryAfterMs` a rejection reason carries, capped; 0 when it carries none. */
function retryAfterOf(reason: unknown): number {
  if (typeof reason !== 'object' || reason === null) {
    return 0;
  }
  const value = (reason as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(value, MAX_POLL_BACKOFF_MS);
}

/** Start a poll loop over `target`. */
export function startPolling(target: PollTarget): PollHandle {
  const { options, signals } = target;
  const random = target.random ?? Math.random;
  let stopped = false;
  let running = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const jitter = (ms: number): number => ms * (1 + (random() * 2 - 1) * POLL_JITTER);
  const backoff = (): number =>
    Math.min(options.intervalMs * 2 ** failures, Math.max(options.intervalMs, MAX_POLL_BACKOFF_MS));

  let dueAt = Date.now() + jitter(options.intervalMs);

  const isPaused = (): boolean =>
    (options.whenHidden === 'pause' && signals.hidden) ||
    (options.whenOffline === 'pause' && !signals.online);

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** Arm the timer for `dueAt`, or tick now when it already passed. */
  const ensureScheduled = (): void => {
    if (stopped || running || timer !== null || isPaused() || !target.isActive()) {
      return;
    }
    const wait = dueAt - Date.now();
    if (wait <= 0) {
      detach(tick(), escalate);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      detach(tick(), escalate);
    }, wait);
  };

  const tick = async (): Promise<void> => {
    // The owner may have been blocked or the tab hidden since the timer was armed.
    if (stopped || isPaused() || !target.isActive()) {
      return;
    }
    running = true;
    try {
      try {
        await target.refresh();
        failures = 0;
        dueAt = Date.now() + jitter(options.intervalMs);
      } catch (reason) {
        failures += 1;
        dueAt = Date.now() + Math.max(jitter(backoff()), retryAfterOf(reason));
      }
    } finally {
      running = false;
    }
    ensureScheduled();
  };

  const unsubscribe = signals.onChange(() => {
    if (stopped) {
      return;
    }
    if (isPaused() || !target.isActive()) {
      clearTimer();
      return;
    }
    ensureScheduled();
  });

  ensureScheduled();

  return {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      clearTimer();
      unsubscribe();
    },
  };
}
