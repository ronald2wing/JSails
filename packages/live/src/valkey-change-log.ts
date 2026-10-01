/**
 * The Valkey Streams change log: the multi-instance implementation of the
 * {@link ChangeLog} contract (docs/design/live.md §9, §13.2).
 *
 * A per-process ring buffer cannot resume a client that reconnects to a
 * different instance, so it degrades to a full snapshot in exactly the
 * topology it exists to serve. The shared log fixes that: one stream per
 * deployment, one sequence counter, so `since` means the same thing on every
 * instance (docs/design/live.md §14 item 5).
 *
 * Sequence assignment is atomic with the append. A Lua script `INCR`s the
 * counter and `XADD`s the entry with an explicit `<sequence>-0` id, so the
 * stream's own ordering and the counter can never disagree — a crash between
 * the two would otherwise leave a gap that `since` reports as `truncated` for
 * no reason. The explicit id also makes the stream id the sequence, so a
 * reader can `XRANGE` from `<sequence>-0` directly instead of scanning.
 *
 * `head` is cached locally and refreshed on append, so it lags whatever other
 * instances appended. A snapshot watermark must not lag — a change another
 * instance appended between the cached value and the query would sit at or
 * below the watermark and the client would drop it — so the service takes its
 * watermark from {@link ValkeyChangeLog.readHead}, which reads the counter.
 *
 * Reads go forward from a sequence (`XRANGE <sequence>-0 + COUNT n`), never
 * over the whole retained window: a reader pays for the entries it needs, not
 * for the window's size.
 *
 * Retention is the stream's own `MAXLEN ~` trim, so the window is bounded by
 * the deployment's configuration rather than by this process. A `since` that
 * predates the oldest retained entry, or names a sequence past the head,
 * reports `truncated`, and the caller degrades to a snapshot.
 */

import {
  assertConnectionUrl,
  disconnectQuietly,
  isRecord,
  JsailsError,
  loadIoredis,
  reportBackendError,
  resolveValkeyPrefix,
  resolveValkeyUrl,
  sanitizeBackendError,
  VALKEY_MAX_RETRIES,
  type BackendErrorFactory,
} from 'jsails/plugin-sdk';
import type { ChangeLog, ChangeLogSlice, LiveChange } from 'jsails/live';

/** Why a Valkey change-log operation failed. Value-free. */
export type ValkeyChangeLogErrorCode =
  'closed' | 'invalid_sequence' | 'unavailable' | 'invalid_url' | 'truncated';

/** Raised by the Valkey change log, bus, and tailer. Never echoes the URL or a payload. */
export class ValkeyChangeLogError extends JsailsError {
  constructor(
    readonly code: ValkeyChangeLogErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * The error factory handed to the plugin-sdk backend helpers. They already
 * suffix the errno code onto the message, so the factory only pins the code.
 */
export const unavailableError: BackendErrorFactory = (message) =>
  new ValkeyChangeLogError('unavailable', message);

/** Resolve and validate the shared Valkey URL. Never echoes the value. */
export function resolveLiveValkeyUrl(value: string | undefined): string {
  return assertConnectionUrl(
    resolveValkeyUrl({ valkeyUrl: value }),
    () =>
      new ValkeyChangeLogError(
        'invalid_url',
        'the shared live change log requires a redis:// or rediss:// Valkey URL',
      ),
  );
}

/**
 * The slice of an ioredis client the change log depends on. Narrow on purpose:
 * the log needs commands and a teardown, not the full client surface, so a
 * test can supply a fake without implementing ioredis.
 */
export interface ValkeyLiveClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  xrange(key: string, start: string, end: string, ...args: (string | number)[]): Promise<unknown>;
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

/**
 * A {@link ChangeLog} over a Valkey Stream, exposing the connection and stream
 * key so the stream tailer can read the same stream the log appends to.
 */
export interface ValkeyChangeLog extends ChangeLog {
  readonly client: ValkeyLiveClient;
  readonly streamKey: string;
  /** Read the deployment-wide head from the counter, refreshing the cached `head`. */
  readHead(): Promise<number>;
}

const DEFAULT_PREFIX = 'jsails:live';
const DEFAULT_MAX_CHANGES = 1000;
/** Entries per `XRANGE` page; bounds the memory a single read can take. */
export const STREAM_PAGE_SIZE = 500;

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
): Promise<ValkeyChangeLog> {
  const url = resolveLiveValkeyUrl(options.valkeyUrl);
  const prefix = resolveValkeyPrefix(options.prefix, DEFAULT_PREFIX);
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
  const counterKey = `${prefix}:sequence`;
  const streamKey = `${prefix}:changes`;

  const client = await connect(url, options.createClient);
  client.on('error', (error: unknown) => {
    reportBackendError(error, options.onError, 'live change log', unavailableError);
  });

  let head = await readHead(client, counterKey);
  let closed = false;

  return {
    client,
    streamKey,

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
        throw sanitizeBackendError(error, 'live change log', unavailableError);
      }
      if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) {
        throw new ValkeyChangeLogError(
          'invalid_sequence',
          'the change log returned an invalid sequence',
        );
      }
      head = Math.max(head, sequence);
      return sequence;
    },

    async readHead(): Promise<number> {
      if (closed) {
        throw new ValkeyChangeLogError('closed', 'the change log is closed');
      }
      head = Math.max(head, await readHead(client, counterKey));
      return head;
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
      return readStreamSlice(client, streamKey, sequence);
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

/** One forward read: the parsed changes plus the first raw id's sequence. */
export interface StreamRead {
  readonly changes: LiveChange[];
  /**
   * The sequence of the first entry at or after the requested one, malformed
   * or not, or `undefined` when there is none. Ids are a gapless counter, so a
   * first entry past the requested sequence means the stream trimmed it.
   */
  readonly firstSequence: number | undefined;
}

/**
 * Read every entry at `sequence` and later, a page at a time, starting from
 * the `<sequence>-0` id the append script assigned.
 */
export async function readStreamFrom(
  client: ValkeyLiveClient,
  streamKey: string,
  sequence: number,
): Promise<StreamRead> {
  const changes: LiveChange[] = [];
  let firstSequence: number | undefined;
  let start = `${Math.max(sequence, 0)}-0`;
  for (;;) {
    let entries: unknown;
    try {
      entries = await client.xrange(streamKey, start, '+', 'COUNT', STREAM_PAGE_SIZE);
    } catch (error) {
      throw sanitizeBackendError(error, 'live change log', unavailableError);
    }
    const page = parsePage(entries);
    firstSequence ??= page.firstSequence;
    changes.push(...page.changes);
    if (page.count < STREAM_PAGE_SIZE || page.lastId === undefined) {
      return { changes, firstSequence };
    }
    // `(` makes the next page start strictly after the last id read.
    start = `(${page.lastId}`;
  }
}

/**
 * Read the changes at `sequence` and later from a stream, plus whether the
 * window still covers `sequence`.
 *
 * `truncated` holds whenever the stream does not hold the entry at `sequence`
 * itself. Ids come from a gapless counter that the append script bumps
 * atomically with the `XADD`, so a client's last applied sequence is always
 * the id of an entry the stream once held: a first entry later than it means
 * the stream trimmed it, and no entry at or after it means either the stream
 * lost its data or the client presents a sequence this counter never reached
 * (a reset counter, another deployment). Neither can be resumed; the caller
 * degrades to a snapshot.
 */
export async function readStreamSlice(
  client: ValkeyLiveClient,
  streamKey: string,
  sequence: number,
): Promise<ChangeLogSlice> {
  const read = await readStreamFrom(client, streamKey, sequence);
  if (sequence <= 0) {
    return { changes: read.changes, truncated: false };
  }
  return {
    changes: read.changes,
    truncated: read.firstSequence === undefined || read.firstSequence > sequence,
  };
}

/** A parsed `XRANGE` page: its changes, its raw entry count, and its first and last ids. */
interface StreamPage {
  readonly changes: LiveChange[];
  readonly count: number;
  readonly firstSequence: number | undefined;
  readonly lastId: string | undefined;
}

function parsePage(entries: unknown): StreamPage {
  const changes = parseEntries(entries);
  const list = entries as readonly unknown[];
  const first: unknown = list[0];
  const last: unknown = list[list.length - 1];
  const firstId = Array.isArray(first) ? (first as unknown[])[0] : undefined;
  const lastId = Array.isArray(last) ? (last as unknown[])[0] : undefined;
  return {
    changes,
    count: list.length,
    firstSequence: typeof firstId === 'string' ? sequenceFromId(firstId) : undefined,
    lastId: typeof lastId === 'string' ? lastId : undefined,
  };
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
export function parseEntries(entries: unknown): LiveChange[] {
  if (!Array.isArray(entries)) {
    throw new ValkeyChangeLogError(
      'unavailable',
      'the change log returned an unexpected stream shape',
    );
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
  if (!isRecord(parsed)) {
    return undefined;
  }
  const { collection, id, operation, row, at } = parsed;
  if (typeof collection !== 'string' || typeof id !== 'string') {
    return undefined;
  }
  if (operation !== 'insert' && operation !== 'update' && operation !== 'delete') {
    return undefined;
  }
  if (row !== null && !isRecord(row)) {
    return undefined;
  }
  if (typeof at !== 'number') {
    return undefined;
  }
  return { collection, id, operation, row, at };
}

/** Read the counter, treating a missing key as "nothing appended yet". */
async function readHead(client: ValkeyLiveClient, counterKey: string): Promise<number> {
  let raw: string | null;
  try {
    raw = await client.get(counterKey);
  } catch (error) {
    throw sanitizeBackendError(error, 'live change log', unavailableError);
  }
  if (raw === null) {
    return 0;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Connect eagerly so a misconfigured deployment fails at startup. */
async function connect(
  url: string,
  createClient: ((url: string) => ValkeyLiveClient) | undefined,
): Promise<ValkeyLiveClient> {
  try {
    return createClient === undefined ? await loadClient(url) : createClient(url);
  } catch (error) {
    throw sanitizeBackendError(error, 'live change log', unavailableError);
  }
}

/** Load the real ioredis client lazily, only when no seam is supplied. */
async function loadClient(url: string): Promise<ValkeyLiveClient> {
  const Redis = await loadIoredis<ValkeyLiveClient>();
  return new Redis(url, { maxRetriesPerRequest: VALKEY_MAX_RETRIES, lazyConnect: false });
}
