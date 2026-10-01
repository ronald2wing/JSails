/**
 * The Valkey Streams change log: the multi-instance implementation of the
 * {@link ChangeLog} contract (LIVE-PLAN.md §9, Phase 7).
 *
 * A per-process ring buffer cannot resume a client that reconnects to a
 * different instance, so it degrades to a full snapshot in exactly the
 * topology it exists to serve. The shared log fixes that: one stream per
 * deployment, one sequence counter, so `since` means the same thing on every
 * instance (LIVE-PLAN.md §14 reversal 5).
 *
 * Sequence assignment is atomic with the append. A Lua script `INCR`s the
 * counter and `XADD`s the entry with an explicit `<sequence>-0` id, so the
 * stream's own ordering and the counter can never disagree — a crash between
 * the two would otherwise leave a gap that `since` reports as `truncated` for
 * no reason. The explicit id also makes the stream id the sequence, so a
 * reader can `XRANGE` from `<sequence>-0` directly instead of scanning.
 *
 * `head` is cached locally and refreshed on append. A lagging `head` is safe
 * because `since` is inclusive and a client resumes from the last sequence it
 * applied; an ahead `head` is safe because live delivery plus an inclusive
 * `since` recover the gap. Neither is a correctness boundary.
 *
 * Retention is the stream's own `MAXLEN ~` trim, so the window is bounded by
 * the deployment's configuration rather than by this process. A `since` that
 * predates the oldest retained entry reports `truncated`, and the caller
 * degrades to a snapshot.
 */

import { assertConnectionUrl } from 'jsails/jobs';
import { disconnectQuietly, reportBackendError, sanitizeBackendError } from 'jsails/plugin-sdk';
import type { ChangeLog, ChangeLogSlice, LiveChange } from 'jsails/live';

/** Why a Valkey change-log operation failed. Value-free. */
export type ValkeyChangeLogErrorCode =
  'closed' | 'invalid_sequence' | 'unavailable' | 'invalid_url' | 'truncated';

/** Raised by the Valkey change log. Never echoes the URL or a payload. */
export class ValkeyChangeLogError extends Error {
  readonly code: ValkeyChangeLogErrorCode;

  constructor(code: ValkeyChangeLogErrorCode, message: string) {
    super(message);
    this.name = 'ValkeyChangeLogError';
    this.code = code;
  }
}

/**
 * The slice of an ioredis client the change log depends on. Narrow on purpose:
 * the log needs commands and a teardown, not the full client surface, so a
 * test can supply a fake without implementing ioredis.
 */
export interface ValkeyLiveClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  xrange(key: string, start: string, end: string): Promise<unknown>;
  xlen(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  disconnect(): Promise<unknown>;
  on(event: 'error', listener: (error: unknown) => void): void;
}

/** Options for {@link createValkeyChangeLog}. */
export interface ValkeyChangeLogOptions {
  /** The `redis://`/`rediss://` URL. Falls back to `VALKEY_URL`. */
  readonly valkeyUrl?: string;
  /** Key prefix for the stream and counter. Defaults to `jsails:live`. */
  readonly prefix?: string;
  /** Approximate stream length retained by `XADD MAXLEN ~`. Defaults to 1000. */
  readonly maxChanges?: number;
  /** Receives post-connect backend errors. Defaults to `process.emitWarning`. */
  readonly onError?: (error: Error) => void;
  /** Test seam: the client constructor. Defaults to ioredis. */
  readonly createClient?: (url: string) => ValkeyLiveClient;
}

const DEFAULT_PREFIX = 'jsails:live';
const DEFAULT_MAX_CHANGES = 1000;

/**
 * Append atomically: bump the counter, then add the entry under the id the
 * counter produced. `KEYS[1]` is the counter, `KEYS[2]` the stream;
 * `ARGV[1]` the max length, `ARGV[2]` the JSON payload.
 */
const APPEND_SCRIPT = `
local sequence = redis.call('INCR', KEYS[1])
redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[1], sequence .. '-0', 'change', ARGV[2])
return sequence
`;

/**
 * Create a {@link ChangeLog} backed by a Valkey Stream.
 *
 * The connection is established eagerly so a misconfigured deployment fails at
 * startup rather than on the first write. The URL is validated before any
 * connection attempt and is never echoed in an error.
 */
export async function createValkeyChangeLog(
  options: ValkeyChangeLogOptions = {},
): Promise<ChangeLog> {
  const url = resolveUrl(options.valkeyUrl);
  const prefix = resolvePrefix(options.prefix);
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
  const counterKey = `${prefix}:sequence`;
  const streamKey = `${prefix}:changes`;

  const makeError = (message: string, code: string | undefined) =>
    new ValkeyChangeLogError(
      code === undefined ? 'unavailable' : 'unavailable',
      code === undefined ? message : `${message} (${code})`,
    );

  const client = await connect(url, options.createClient, makeError);
  client.on('error', (error: unknown) => {
    reportBackendError(error, options.onError, 'live change log', makeError);
  });

  let head = await readHead(client, counterKey, makeError);
  let closed = false;

  return {
    async append(change: LiveChange): Promise<number> {
      if (closed) {
        throw new ValkeyChangeLogError('closed', 'the change log is closed');
      }
      let sequence: unknown;
      try {
        // The sequence is assigned by the script, so the payload cannot carry it
        // yet. Store the change with a placeholder and rewrite the entry's
        // sequence from the stream id on read — the id IS the sequence.
        sequence = await client.eval(
          APPEND_SCRIPT,
          2,
          counterKey,
          streamKey,
          maxChanges,
          JSON.stringify(change),
        );
      } catch (error) {
        throw sanitizeBackendError(error, 'live change log', makeError);
      }
      if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) {
        throw new ValkeyChangeLogError(
          'invalid_sequence',
          'the change log returned an invalid sequence',
        );
      }
      head = sequence;
      return sequence;
    },

    async since(sequence: number): Promise<ChangeLogSlice> {
      if (closed) {
        throw new ValkeyChangeLogError('closed', 'the change log is closed');
      }
      if (!Number.isInteger(sequence) || sequence < 0) {
        throw new ValkeyChangeLogError(
          'invalid_sequence',
          'the sequence must be a non-negative integer',
        );
      }
      return readStreamSlice(client, streamKey, sequence, makeError);
    },

    get head(): number {
      return head;
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      disconnectQuietly(client);
    },
  };
}

/**
 * Read the changes at `sequence` and later from a stream, plus whether the
 * window still covers `sequence`.
 *
 * Exported for the tailer, which reads forward from a cursor rather than
 * re-reading a suffix. `truncated` is decided by comparing the requested
 * sequence with the oldest retained id: a stream that has trimmed past it can
 * no longer reproduce the suffix, so the caller must snapshot.
 */
export async function readStreamSlice(
  client: ValkeyLiveClient,
  streamKey: string,
  sequence: number,
  makeError: (message: string, code: string | undefined) => Error,
): Promise<ChangeLogSlice> {
  let entries: unknown;
  try {
    entries = await client.xrange(streamKey, '-', '+');
  } catch (error) {
    throw sanitizeBackendError(error, 'live change log', makeError);
  }
  const parsed = parseEntries(entries, makeError);
  const oldest = parsed[0]?.sequence;
  const truncated = sequence > 0 && (oldest === undefined || sequence < oldest);
  return { changes: parsed.filter((entry) => entry.sequence >= sequence), truncated };
}

/**
 * Parse `XRANGE` output into changes, dropping entries whose payload is not a
 * well-formed change. A malformed entry is a deployment fault, not a client
 * fault: skipping it keeps the stream readable rather than failing every
 * subscriber on one bad write.
 *
 * The sequence comes from the **stream id**, not the payload: the id is what
 * the append script assigned atomically with the counter, so it is the
 * authoritative value. The payload's own `sequence` is the caller's placeholder
 * and is overwritten here.
 */
export function parseEntries(
  entries: unknown,
  makeError: (message: string, code: string | undefined) => Error,
): LiveChange[] {
  if (!Array.isArray(entries)) {
    throw makeError('the change log returned an unexpected stream shape', undefined);
  }
  const changes: LiveChange[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const id = entry[0];
    const fields = entry[1];
    if (typeof id !== 'string' || !Array.isArray(fields)) {
      continue;
    }
    const sequence = sequenceFromId(id);
    if (sequence === undefined) {
      continue;
    }
    const payload = fieldValue(fields, 'change');
    if (payload === undefined) {
      continue;
    }
    const change = parseChange(payload);
    if (change !== undefined) {
      changes.push({ ...change, sequence });
    }
  }
  return changes;
}

/** Read the sequence from a `<sequence>-<n>` stream id. */
function sequenceFromId(id: string): number | undefined {
  const separator = id.indexOf('-');
  const raw = separator === -1 ? id : id.slice(0, separator);
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/** Read the value of a named field from a flat `[name, value, ...]` list. */
function fieldValue(fields: readonly unknown[], name: string): string | undefined {
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (fields[index] === name) {
      const value = fields[index + 1];
      return typeof value === 'string' ? value : undefined;
    }
  }
  return undefined;
}

/** Parse one stored payload, rejecting anything that is not a complete change. */
function parseChange(payload: string): Omit<LiveChange, 'sequence'> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const { collection, id, operation, row, at } = record;
  if (typeof collection !== 'string' || typeof id !== 'string') {
    return undefined;
  }
  if (operation !== 'insert' && operation !== 'update' && operation !== 'delete') {
    return undefined;
  }
  if (row !== null && (typeof row !== 'object' || Array.isArray(row))) {
    return undefined;
  }
  if (typeof at !== 'number') {
    return undefined;
  }
  return {
    collection,
    id,
    operation,
    row: row === null ? null : (row as Record<string, unknown>),
    at,
  };
}

/** Read the counter, treating a missing key as "nothing appended yet". */
async function readHead(
  client: ValkeyLiveClient,
  counterKey: string,
  makeError: (message: string, code: string | undefined) => Error,
): Promise<number> {
  let raw: string | null;
  try {
    raw = await client.get(counterKey);
  } catch (error) {
    throw sanitizeBackendError(error, 'live change log', makeError);
  }
  if (raw === null) {
    return 0;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Resolve and validate the connection URL. Never echoes the value. */
function resolveUrl(value: string | undefined): string {
  const candidate = value ?? process.env.VALKEY_URL;
  return assertConnectionUrl(
    candidate,
    () => new ValkeyChangeLogError('invalid_url', 'the live change log requires a Valkey URL'),
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

/** Connect eagerly so a misconfigured deployment fails at startup. */
async function connect(
  url: string,
  createClient: ((url: string) => ValkeyLiveClient) | undefined,
  makeError: (message: string, code: string | undefined) => Error,
): Promise<ValkeyLiveClient> {
  let client: ValkeyLiveClient;
  try {
    client = createClient === undefined ? await loadClient(url) : createClient(url);
  } catch (error) {
    throw sanitizeBackendError(error, 'live change log', makeError);
  }
  return client;
}

/** Load the real ioredis client lazily, only when no seam is supplied. */
async function loadClient(url: string): Promise<ValkeyLiveClient> {
  const { Redis } = await import('ioredis');
  const client = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
  return client as unknown as ValkeyLiveClient;
}
