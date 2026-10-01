/**
 * The process's shutdown signals, and the only module in core that listens
 * for SIGINT and SIGTERM (a structural test holds that).
 *
 * `waitForShutdownSignal()` is what the long-running commands (`serve`,
 * `work`, `dev`, `create --install`) wait on: the first signal resolves its
 * promise and the command shuts down gracefully, draining under its deadline;
 * a second signal aborts its `abort` signal, which the command passes to the
 * kernel's shutdown so every unit not yet idle is aborted at once. Tests
 * substitute a resolved promise.
 *
 * `onProcessSignals(signals, listener)` is the primitive under it, for the
 * commands that only forward a signal to a child (`jsails test`, the `jamal`
 * forwarder). `onFirstProcessSignal(signals, listener)` is for a command that
 * stops on the first signal and has nothing to abort after it (`mcp`): it
 * stops listening at once, so a second signal ends the process the way Node
 * does by default, even when the graceful stop hangs.
 */

/** The shutdown signals the CLI observes. */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = Object.freeze(['SIGINT', 'SIGTERM']);

/**
 * The shutdown wait seam: the first signal resolves `promise`, the second
 * aborts `abort`; `dispose()` removes the listeners.
 */
export interface ShutdownSignal {
  readonly promise: Promise<void>;
  /** Aborted by the second signal: stop draining and abort at once. */
  readonly abort: AbortSignal;
  dispose(): void;
}

/**
 * The process a listener attaches to; `process` unless a test passes its own
 * emitter.
 */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

/**
 * Call `listener` with each of `signals` the process receives until the
 * returned disposer runs. Listening replaces Node's default handling, which
 * ends the process, for as long as the listener is installed.
 */
export function onProcessSignals(
  signals: readonly NodeJS.Signals[],
  listener: (signal: NodeJS.Signals) => void,
  source: SignalSource = process,
): () => void {
  const handler = (signal: NodeJS.Signals): void => listener(signal);
  for (const signal of signals) source.on(signal, handler);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const signal of signals) source.removeListener(signal, handler);
  };
}

/**
 * Call `listener` with the first of `signals` the process receives, then stop
 * listening for all of them, so the next one gets Node's default handling,
 * which ends the process. The returned disposer stops listening before any
 * signal arrived.
 */
export function onFirstProcessSignal(
  signals: readonly NodeJS.Signals[],
  listener: (signal: NodeJS.Signals) => void,
  source: SignalSource = process,
): () => void {
  const dispose = onProcessSignals(
    signals,
    (signal) => {
      dispose();
      listener(signal);
    },
    source,
  );
  return dispose;
}

/**
 * Install SIGINT/SIGTERM handlers: the first signal resolves the promise, the
 * second aborts `abort`. `dispose()` removes the listeners, so a startup
 * failure or completed shutdown never leaks a handler; until then a third
 * signal changes nothing. The handlers are installed before the work starts,
 * so a signal can interrupt a startup that is still connecting.
 */
export function waitForShutdownSignal(source: SignalSource = process): ShutdownSignal {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const controller = new AbortController();
  let received = 0;
  const dispose = onProcessSignals(
    SHUTDOWN_SIGNALS,
    () => {
      received += 1;
      if (received === 1) resolvePromise();
      else controller.abort();
    },
    source,
  );
  return { promise, abort: controller.signal, dispose };
}
