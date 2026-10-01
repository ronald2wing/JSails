/**
 * Valkey connection options and error routing for BullMQ producers and workers.
 *
 * A single `valkeyUrl` is turned into role-specific connection options:
 *
 * - **producer** (web-facing): a finite command-retry budget plus
 *   `enableOfflineQueue: false`, so `dispatch` fails fast instead of hanging a
 *   request while Redis is unreachable.
 * - **worker**: `maxRetriesPerRequest: null`, so the blocking pop the worker
 *   performs never gives up (a worker must outlive transient Redis blips).
 *
 * Error surfacing is non-silent by design. BullMQ re-emits backend errors on
 * its `Queue`/`Worker` `'error'` event, but drops them when no listener is
 * attached. Every queue/worker created by this library therefore gets an
 * `'error'` listener that routes to the caller's `onError` callback, or to a
 * default logger that prints `name: message` — never a job payload.
 *
 * {@link defaultQueuePrefix} derives the key prefix a producer and a worker of
 * the same app and environment share when neither names one.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { RedisOptions } from 'bullmq';

/** Role of a connection: shapes retry and offline-queue behavior. */
type JobRole = 'producer' | 'worker';

/** Default queue name when none is supplied. */
export const DEFAULT_QUEUE_NAME = 'default';

/** Key prefix of a runtime constructed directly without one (BullMQ's own default). */
export const DEFAULT_PREFIX = 'bull';

/** The app-name part of {@link defaultQueuePrefix} when no `package.json` names the app. */
const UNNAMED_APP = 'jsails';

/** Reduce a name to characters that are safe and unambiguous inside a Valkey key. */
function sanitizePrefixPart(value: string): string {
  const cleaned = value
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 100);
}

/** The `name` field of the `package.json` in `dir`, if it has a non-empty one. */
function packageNameIn(dir: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, 'package.json'), 'utf8');
  } catch {
    return undefined;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (manifest === null || typeof manifest !== 'object') return undefined;
  const name = (manifest as { name?: unknown }).name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/**
 * The `name` of the nearest `package.json` at or above `startDir` that has one.
 * A nameless manifest (such as a nested `{"type":"module"}`) is skipped, so a
 * producer and a worker that start the search from different directories of
 * one app still reach the app's own manifest and agree on the prefix.
 */
function nearestPackageName(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const name = packageNameIn(dir);
    if (name !== undefined) return name;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The default queue key prefix, `<app name>:<environment>`: the `name` of the
 * nearest `package.json` at or above `startDir` and `NODE_ENV` (`development`
 * when unset), each reduced to `[A-Za-z0-9._-]`. Two apps, or two environments
 * of one app, sharing a Valkey therefore never consume each other's jobs,
 * which a fixed default such as BullMQ's `bull` would make them do.
 */
export function defaultQueuePrefix(
  startDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const app = sanitizePrefixPart(nearestPackageName(startDir) ?? '') || UNNAMED_APP;
  const environment = sanitizePrefixPart(env.NODE_ENV ?? '') || 'development';
  return `${app}:${environment}`;
}

/**
 * Command-retry budget for producer connections. Commands that exhaust this
 * budget reject immediately, so a web producer fails fast rather than retrying
 * a command indefinitely.
 */
export const PRODUCER_MAX_RETRIES_PER_REQUEST = 3;

/**
 * Build the BullMQ `connection` options for a role.
 *
 * The returned options are passed straight through to BullMQ, which owns the
 * resulting Redis client(s) and closes them when the queue/worker closes.
 * Only `{ url, maxRetriesPerRequest }` is shaped here; no client is created,
 * so building options (and importing this module) never connects.
 */
export function buildConnectionOptions(valkeyUrl: string, role: JobRole): RedisOptions {
  if (role === 'worker') {
    return { url: valkeyUrl, maxRetriesPerRequest: null };
  }
  return {
    url: valkeyUrl,
    maxRetriesPerRequest: PRODUCER_MAX_RETRIES_PER_REQUEST,
    enableOfflineQueue: false,
  };
}

/** Receives connection and processing errors surfaced by a queue or worker. */
export type JobErrorHandler = (error: Error) => void;

/**
 * Default payload-free error logger used when the caller omits `onError`.
 * Logs only the error class and message; it never logs a job's data, so
 * payloads (which may carry secrets) cannot leak into logs.
 */
export function defaultErrorLogger(component: string, name: string): JobErrorHandler {
  return (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[jsails:jobs] ${component} "${name}" error: ${err.name}: ${err.message}`);
  };
}

/**
 * Attach an `'error'` listener that routes to `onError` or, when absent, to
 * `fallback`. This guarantees a queue/worker never emits an unhandled Redis
 * error even when the caller forgets to pass `onError`.
 */
export function attachErrorHandler(
  target: { on(eventName: 'error', listener: (error: Error) => void): unknown },
  onError: JobErrorHandler | undefined,
  fallback: JobErrorHandler,
): void {
  target.on('error', (error) => {
    (onError ?? fallback)(error);
  });
}
