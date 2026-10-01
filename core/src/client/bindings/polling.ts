/**
 * `data-jsails-poll` scheduling, shared by component roots and client islands.
 *
 * A poll loop awaits each refresh before scheduling the next, so refreshes
 * never overlap, and pauses while the document is hidden or the browser is
 * offline when the marker asks for it. The marker is bounded by
 * {@link MAX_POLL_MARKER_LENGTH} and {@link MIN_POLL_INTERVAL_MS} so hostile
 * markup can never drive a tight loop.
 */

import {
  MAX_POLL_MARKER_LENGTH,
  MIN_POLL_INTERVAL_MS,
  type ComponentPollOptions,
} from '../../server-components/protocol.js';

/**
 * Visibility/connectivity signals a poll loop consults to pause and resume.
 * The loop subscribes to changes so it reacts without re-reading markers.
 */
export interface PollSignals {
  /** Whether the document is currently hidden (pauses when `pauseWhenHidden`). */
  readonly hidden: boolean;
  /** Whether the browser reports a live connection (pauses when `pauseWhenOffline`). */
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

/** Parse a `data-jsails-poll` marker; `null` when absent, malformed, or out of bounds. */
export function parsePollMarker(raw: string | null): ComponentPollOptions | null {
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
    intervalMs < MIN_POLL_INTERVAL_MS
  ) {
    return null;
  }
  return {
    intervalMs,
    pauseWhenHidden: record.pauseWhenHidden === true,
    pauseWhenOffline: record.pauseWhenOffline === true,
  };
}

/** A running poll loop; stopping is idempotent. */
export interface PollHandle {
  stop(): void;
}

/** What a poll loop drives. */
interface PollTarget {
  readonly options: ComponentPollOptions;
  readonly signals: PollSignals;
  /** False once the owner can no longer refresh (disposed, blocked); ends scheduling. */
  isActive(): boolean;
  /** One refresh; a rejection is swallowed because the owner reports its own failures. */
  refresh(): Promise<unknown>;
}

/** Start a recursive poll loop over `target`. */
export function startPolling(target: PollTarget): PollHandle {
  const { options, signals } = target;
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const isPaused = (): boolean =>
    (options.pauseWhenHidden === true && signals.hidden) ||
    (options.pauseWhenOffline === true && !signals.online);

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const ensureScheduled = (): void => {
    if (stopped || !target.isActive()) {
      return;
    }
    if (isPaused() || running || timer !== null) {
      return;
    }
    timer = setTimeout(() => {
      void tick();
    }, options.intervalMs);
  };

  const tick = async (): Promise<void> => {
    timer = null;
    running = true;
    try {
      if (stopped || !target.isActive() || isPaused()) {
        return;
      }
      await target.refresh();
    } catch {
      // The owner reports its own refresh failures; one that leaves it inactive
      // ends the loop below.
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
