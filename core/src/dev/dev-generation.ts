/**
 * The dev build generation: a counter that tells a browser whether the page it
 * is showing came from the current build.
 *
 * The dev parent owns the counter and writes it to a file; the serve child
 * reads it and reports it over SSE. A file is the channel because the child is
 * replaced on every server restart, so in-memory state cannot cross the
 * boundary, and because the value must survive that restart: a tab that
 * reconnects afterwards compares the current value against the one embedded in
 * its HTML.
 *
 * The write is atomic (temp file + rename) so a poller never reads a torn
 * value. Polling beats `fs.watch` here: a single-file watch breaks when the
 * rename replaces the inode, and a 2-byte read every 250 ms is cheaper than
 * that bug class.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Environment variable carrying the generation file path to the serve child. */
export const DEV_GENERATION_ENV = 'JSAILS_DEV_GENERATION';

/** Default poll interval for the serve child. */
const DEFAULT_POLL_MS = 250;

/** The generation file path for a project root. */
export function generationFilePath(cwd: string): string {
  return join(cwd, '.jsails', 'dev-generation');
}

/**
 * Write `generation` atomically. The parent calls this before the first serve
 * spawn and on every bump.
 */
export function writeGeneration(path: string, generation: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${generation}\n`, 'utf8');
  renameSync(temporary, path);
}

/**
 * Read the current generation, or `0` when the file is missing or unreadable.
 *
 * A missing file is the normal state for a plain `jsails serve` with
 * `NODE_ENV=development`, where no dev parent is running. An unparsable file
 * keeps the caller's previous value rather than resetting to zero, so a torn
 * read cannot trigger a spurious reload.
 */
export function readGeneration(path: string, previous = 0): number {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return previous;
  }
  const trimmed = raw.trim();
  // `parseInt` would accept `1.5` as `1`; the file is written by us, so any
  // non-canonical content means a torn or foreign write and must be ignored.
  if (!/^\d+$/.test(trimmed)) {
    return previous;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : previous;
}

/** A live view of the generation file. */
export interface GenerationChannel {
  /** The last value read. */
  current(): number;
  /** Called whenever the value changes. Returns an unsubscribe function. */
  subscribe(listener: (generation: number) => void): () => void;
  /** Stop polling. Idempotent. */
  close(): void;
}

/** Options for {@link createGenerationChannel}. */
export interface GenerationChannelOptions {
  /** The generation file path, or `undefined` for a constant-0 channel. */
  readonly path: string | undefined;
  /** Poll interval. Defaults to 250ms. */
  readonly pollMs?: number;
}

/**
 * Watch the generation file.
 *
 * One interval serves every subscriber, and it is `unref`'d so a dev server
 * with no open browser can still exit. The interval is cleared when the last
 * subscriber leaves, so an idle server does no work.
 */
export function createGenerationChannel(options: GenerationChannelOptions): GenerationChannel {
  const { path } = options;
  const listeners = new Set<(generation: number) => void>();
  let value = path === undefined ? 0 : readGeneration(path);
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const poll = (): void => {
    if (path === undefined) {
      return;
    }
    const next = readGeneration(path, value);
    if (next === value) {
      return;
    }
    value = next;
    for (const listener of listeners) {
      listener(next);
    }
  };

  const start = (): void => {
    if (timer !== undefined || closed || path === undefined) {
      return;
    }
    timer = setInterval(poll, options.pollMs ?? DEFAULT_POLL_MS);
    timer.unref();
  };

  const stop = (): void => {
    if (timer === undefined) {
      return;
    }
    clearInterval(timer);
    timer = undefined;
  };

  return {
    current(): number {
      return value;
    },
    subscribe(listener: (generation: number) => void): () => void {
      if (closed) {
        return () => {};
      }
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop();
        }
      };
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      listeners.clear();
      stop();
    },
  };
}
