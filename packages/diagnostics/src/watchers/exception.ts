/**
 * The exception watcher: captures unhandled errors through a caller-provided
 * `capture` hook and the optional `requestFailed` signal, recording value-free
 * `exception` entries keyed by family.
 *
 * Every entry's `data` carries `class`, `file`, `line`, `frames` (a frame
 * count only — the raw stack is never stored), `family`, and an optional
 * `context`. The `family` discriminator is built from the error class and any
 * caller-provided `context.family`, so the recorder derives the same
 * `familyHash` the watcher uses as the key of its bounded occurrence map
 * (`counts()`).
 */

import { isRecord } from 'jsails/plugin-sdk';
import { requestFailed, type RequestSignalPayload, type SignalBus } from 'jsails/signals';
import { deriveFamilyHash } from '../family-hash.js';
import type { Watcher, WatcherContext } from './registry.js';

/** A handler that receives a captured error. */
export type CapturedErrorHandler = (captured: CapturedError) => void;

/** Registers a captured-error handler and returns an unsubscribe called on teardown. */
export type ErrorSubscribe = (fn: CapturedErrorHandler) => () => void;

/** Options for {@link ExceptionWatcher}. */
export interface ExceptionWatcherOptions {
  /** The shared signal bus; when present the watcher also observes {@link requestFailed}. */
  readonly signals?: SignalBus;
  /** Register the watcher's handler with the error-capture channel. */
  readonly capture: ErrorSubscribe;
  /** Maximum distinct families the occurrence map holds before evicting the least recent. Defaults to 1000. */
  readonly maxFamilies?: number;
}

/** An error the watcher processes, with optional caller-provided context. */
export interface CapturedError {
  /** The thrown value (an `Error` instance or any unknown throwable). */
  readonly error: unknown;
  /** Value-free context attached by the capture source. */
  readonly context?: Readonly<Record<string, unknown>>;
}

const DEFAULT_MAX_FAMILIES = 1000;

/** Matches one V8 stack frame: `at fn (file:line:col)` or `at file:line:col`. */
const STACK_FRAME = /^\s*at\s+(?:(?:.*?)\s+\((.+?):(\d+):\d+\)|(.+?):(\d+):\d+)\s*$/;

/** The error class name, or `Error` for a throwable without one. */
function errorName(error: unknown): string {
  if (isRecord(error) && typeof error.name === 'string' && error.name.length > 0) {
    return error.name;
  }
  return 'Error';
}

/**
 * Read the first frame's file and line from `error.stack` and count the
 * frames, without keeping the raw stack.
 */
function parseStack(stack: unknown): {
  file: string | undefined;
  line: number | undefined;
  frames: number;
} {
  if (typeof stack !== 'string') {
    return { file: undefined, line: undefined, frames: 0 };
  }
  let frames = 0;
  let file: string | undefined;
  let line: number | undefined;
  for (const text of stack.split('\n')) {
    const match = STACK_FRAME.exec(text);
    if (match === null) {
      continue;
    }
    frames += 1;
    if (frames === 1) {
      file = match[1] ?? match[3];
      const parsed = Number.parseInt(match[2] ?? match[4] ?? '', 10);
      line = Number.isNaN(parsed) ? undefined : parsed;
    }
  }
  return { file, line, frames };
}

/** The family discriminator: the class name, qualified by `context.family` when present. */
function familyOf(
  className: string,
  context: Readonly<Record<string, unknown>> | undefined,
): string {
  const contextFamily = context?.family;
  return typeof contextFamily === 'string' && contextFamily.length > 0
    ? `${className}:${contextFamily}`
    : className;
}

/**
 * A {@link Watcher} that subscribes to the caller's error-capture channel and
 * (optionally) the `requestFailed` signal, recording value-free `exception`
 * entries and counting occurrences per family.
 */
export class ExceptionWatcher implements Watcher {
  readonly name = 'exception';

  // Occurrence counts keyed by family hash. Map insertion order is the
  // recency order: a bumped family is re-inserted at the end, and the first
  // key is the least recently seen one, evicted when over capacity.
  readonly #counts = new Map<string, number>();
  readonly #maxFamilies: number;
  readonly #options: ExceptionWatcherOptions;

  constructor(options: ExceptionWatcherOptions) {
    this.#options = options;
    this.#maxFamilies = options.maxFamilies ?? DEFAULT_MAX_FAMILIES;
  }

  register(ctx: WatcherContext): () => void {
    let detached = false;
    const unsubscribe = this.#options.capture((captured) => {
      if (!detached) {
        this.#observe(ctx, captured);
      }
    });

    // The signal bus has no observer removal, so the observer is detached by
    // the same flag and becomes a no-op after teardown.
    this.#options.signals?.observe(requestFailed, (payload: RequestSignalPayload) => {
      if (!detached) {
        this.#observe(ctx, {
          error: payload.error,
          context: { route: payload.route, method: payload.method },
        });
      }
    });

    return () => {
      detached = true;
      unsubscribe();
    };
  }

  /** A copy of the per-family occurrence counts, keyed by family hash. */
  counts(): ReadonlyMap<string, number> {
    return new Map(this.#counts);
  }

  #observe(ctx: WatcherContext, captured: CapturedError): void {
    const className = errorName(captured.error);
    const { file, line, frames } = parseStack(
      isRecord(captured.error) ? captured.error.stack : undefined,
    );
    const family = familyOf(className, captured.context);

    this.#count(deriveFamilyHash(this.name, family));

    const data: Record<string, unknown> = { class: className, frames, family };
    if (file !== undefined) {
      data.file = file;
    }
    if (line !== undefined) {
      data.line = line;
    }
    if (captured.context !== undefined && Object.keys(captured.context).length > 0) {
      data.context = captured.context;
    }

    try {
      ctx.record({ type: this.name, data });
    } catch {
      // Diagnostics must never throw into the observed path.
    }
  }

  #count(hash: string): void {
    const previous = this.#counts.get(hash) ?? 0;
    this.#counts.delete(hash);
    this.#counts.set(hash, previous + 1);
    while (this.#counts.size > this.#maxFamilies) {
      const oldest = this.#counts.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#counts.delete(oldest);
    }
  }
}
