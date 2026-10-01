/**
 * The one place a Valkey (Redis-protocol) client is constructed.
 *
 * {@link createValkeyConnections} turns one URL into an app-owned provider that
 * hands out clients by role, each with a connection policy chosen for what the
 * role does, so no caller assembles ioredis options of its own and nothing
 * waits on an unreachable server without a bound:
 *
 * - `command` (shared): request-path commands. The offline queue is off, so a
 *   command issued while the server is unreachable rejects at once instead of
 *   being held for the whole outage; every command has a reply deadline
 *   (`commandMs`, 2 s by default) unless its script states a longer one.
 * - `subscriber` (shared): pub/sub. The offline queue is on and a pending
 *   command is resent across reconnects without limit, because ioredis
 *   resubscribes after every reconnect with commands nobody awaits: a deadline
 *   or a retry limit would turn a slow or flapping link into an unhandled
 *   rejection. A subscription therefore survives any outage; only the connect
 *   is bounded.
 * - `blocking` (dedicated): `XREAD BLOCK` and other blocking reads. No reply
 *   deadline, TCP keepalive, and ioredis's blocking-command safety timer, so a
 *   connection that dies without a close still returns.
 * - `queue` (dedicated): a BullMQ worker connection, with the
 *   `maxRetriesPerRequest: null` BullMQ requires for its blocking moves.
 *
 * Every role connects within `connectMs` (5 s by default) or rejects: ioredis
 * clears its own connect timer once TCP connects, so a peer that accepts and
 * never answers the handshake would otherwise hang the connect forever. A
 * shared client is created once per role and kept; a failed connect is not
 * memoized, so the next call retries. A dedicated client belongs to the
 * caller, which disconnects it; `close()` still disconnects any left open.
 *
 * Errors leaving the provider are value-free {@link ValkeyError}s: the URL may
 * embed credentials and is never echoed. Failures after a client connected
 * (a dropped connection, failed reconnects) go to `onError`, sanitized, once
 * per outage. Importing this module loads no ioredis; the first connect does.
 */

import { createHash } from 'node:crypto';

import type { Redis, RedisOptions } from 'ioredis';

import { createCleanup } from '../extensions/cleanup.js';
import { JsailsError } from '../errors/jsails-error.js';
import { reportBackendError, sanitizeBackendError } from './backend-errors.js';
import { assertConnectionUrl } from './connection.js';

/**
 * A connected client handed out by {@link ValkeyConnections}.
 *
 * @public
 */
export type ValkeyClient = Redis;

/**
 * Roles served by one client per provider.
 *
 * @public
 */
export type SharedValkeyRole = 'command' | 'subscriber';

/**
 * Roles that get a new client per call, owned by the caller.
 *
 * @public
 */
export type DedicatedValkeyRole = 'blocking' | 'queue';

/**
 * Every connection role.
 *
 * @public
 */
export type ValkeyRole = SharedValkeyRole | DedicatedValkeyRole;

/**
 * Why a Valkey connection operation failed. Value-free.
 *
 * @public
 */
export type ValkeyErrorCode =
  'unavailable' | 'closed' | 'invalid_url' | 'invalid_options' | 'script_failed';

/**
 * Raised by the connection provider. Never echoes the URL or a payload.
 *
 * @public
 */
export class ValkeyError extends JsailsError {
  constructor(
    readonly code: ValkeyErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Connect and reply deadlines, in milliseconds.
 *
 * @public
 */
export interface ValkeyTimeouts {
  /** How long a connect, handshake included, may take. */
  readonly connectMs: number;
  /** How long a `command`-role reply may take. */
  readonly commandMs: number;
}

/**
 * The deadlines a provider uses unless its options override them.
 *
 * @public
 */
export const DEFAULT_VALKEY_TIMEOUTS: Readonly<ValkeyTimeouts> = Object.freeze({
  connectMs: 5000,
  commandMs: 2000,
});

/** Interval of TCP keepalive probes on every connection. */
const KEEPALIVE_MS = 10_000;

/** Longest pause between reconnect attempts of a long-lived client. */
const MAX_RECONNECT_DELAY_MS = 2000;

/**
 * The safety timer for a blocking read: ioredis resolves a blocking command
 * with `null` this long after its own `BLOCK` time (or after this long when it
 * blocks forever), so a connection that dies silently still returns.
 */
const BLOCKING_SAFETY_MS = 30_000;

/** A client name segment: what `CLIENT SETNAME` accepts, kept short and readable. */
export const NAME_PATTERN: RegExp = /^[A-Za-z0-9._:-]{1,64}$/;

/** A key prefix: printable, no whitespace, so it never splits a key. */
export const PREFIX_PATTERN: RegExp = /^[A-Za-z0-9._:@/{}-]{1,128}$/;

/**
 * Test seam: the ioredis client constructor. Faults that a real connection
 * cannot reach deterministically are exercised through it; the real class is
 * loaded lazily when it is absent.
 *
 * @public
 */
export interface ValkeyConnectionsDependencies {
  readonly RedisClient: new (url: string, options: RedisOptions) => object;
}

/**
 * Options for {@link createValkeyConnections}.
 *
 * @public
 */
export interface ValkeyConnectionsOptions {
  /**
   * The app's key prefix (`<app>:<environment>` by default in an app), which
   * consumers put in front of their own keys so two apps or environments that
   * share a server never touch each other's data.
   */
  readonly appPrefix: string;
  /** Names every client (`CLIENT SETNAME <name>:<role>[:<dedicated name>]`). */
  readonly name: string;
  /** Overrides of {@link DEFAULT_VALKEY_TIMEOUTS}. */
  readonly timeouts?: Partial<ValkeyTimeouts>;
  /** Receives post-connect failures, sanitized. Defaults to `process.emitWarning`. */
  readonly onError?: (error: Error) => void;
  readonly dependencies?: ValkeyConnectionsDependencies;
}

/**
 * A Lua script run with `EVALSHA`, falling back to `EVAL` once the server lacks it.
 *
 * @public
 */
export interface ValkeyScriptDefinition {
  /** The script source. */
  readonly lua: string;
  /**
   * The reply deadline of this script, in place of the `command` role's. A
   * script that legitimately runs long states it here rather than being cut by
   * the default.
   */
  readonly timeoutMs?: number;
}

/**
 * A script bound to a provider's `command` connection.
 *
 * @public
 */
export interface ValkeyScript {
  /**
   * Run the script; the reply is decoded as UTF-8. A transport failure or a
   * missed deadline rejects `unavailable`, an error the script raised
   * `script_failed`; neither carries the server's reply text, which may quote
   * keys or arguments.
   */
  run(keys: readonly string[], args: readonly (string | number)[]): Promise<unknown>;
}

/**
 * The app-owned connection provider.
 *
 * @public
 */
export interface ValkeyConnections {
  /** The app key prefix every consumer puts in front of its keys. */
  readonly prefix: string;
  /** The connected client of a shared role, connecting it on first use. */
  shared(role: SharedValkeyRole): Promise<ValkeyClient>;
  /** A new connected client of a dedicated role; the caller disconnects it. */
  dedicated(role: DedicatedValkeyRole, name: string): Promise<ValkeyClient>;
  /** Bind a Lua script to the `command` connection. */
  script(definition: ValkeyScriptDefinition): ValkeyScript;
  /** Disconnect every client this provider created; later calls reject `closed`. */
  close(): Promise<void>;
}

/** The ioredis options of a role. Exported so the policy table is testable. */
export function valkeyRoleOptions(
  role: ValkeyRole,
  connectionName: string,
  timeouts: ValkeyTimeouts,
): RedisOptions {
  const common: RedisOptions = {
    lazyConnect: true,
    connectionName,
    connectTimeout: timeouts.connectMs,
    keepAlive: KEEPALIVE_MS,
    retryStrategy: (attempt) => Math.min(attempt * 100, MAX_RECONNECT_DELAY_MS),
  };
  switch (role) {
    case 'command':
      return {
        ...common,
        enableOfflineQueue: false,
        commandTimeout: timeouts.commandMs,
        maxRetriesPerRequest: 1,
      };
    case 'subscriber':
      return {
        ...common,
        enableOfflineQueue: true,
        autoResubscribe: true,
        maxRetriesPerRequest: null,
      };
    case 'blocking':
      return {
        ...common,
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
        blockingTimeout: BLOCKING_SAFETY_MS,
      };
    case 'queue':
      return { ...common, enableOfflineQueue: true, maxRetriesPerRequest: null };
  }
}

interface IoredisModule {
  readonly Redis: new (url: string, options: RedisOptions) => object;
  readonly Command: typeof import('ioredis').Command;
}

let ioredis: Promise<IoredisModule> | undefined;

/** Load ioredis once, on the first connect or script run. */
function loadIoredis(): Promise<IoredisModule> {
  ioredis ??= import('ioredis').then(
    (module) => ({ Redis: module.Redis, Command: module.Command }),
    (error: unknown) => {
      ioredis = undefined;
      throw error;
    },
  );
  return ioredis;
}

/**
 * Create the connection provider for `url`. Nothing connects until a role is
 * first asked for. The URL must be an explicit `redis://` or `rediss://` URL.
 *
 * @public
 */
export function createValkeyConnections(
  url: string,
  options: ValkeyConnectionsOptions,
): ValkeyConnections {
  const target = assertConnectionUrl(url, (message) => new ValkeyError('invalid_url', message));
  if (options === null || typeof options !== 'object') {
    throw new ValkeyError('invalid_options', 'createValkeyConnections requires an options object');
  }
  const prefix = readPattern(options.appPrefix, PREFIX_PATTERN, 'appPrefix');
  const name = readPattern(options.name, NAME_PATTERN, 'name');
  const timeouts = readTimeouts(options.timeouts);
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new ValkeyError('invalid_options', 'onError must be a function');
  }
  const RedisClient = options.dependencies?.RedisClient;

  const sharedClients = new Map<SharedValkeyRole, Promise<ValkeyClient>>();
  const open = new Set<ValkeyClient>();
  let closed = false;

  const report = (error: unknown): void => {
    reportBackendError(error, options.onError, 'Valkey connection', unavailable);
  };

  async function connect(role: ValkeyRole, connectionName: string): Promise<ValkeyClient> {
    const Client = RedisClient ?? (await loadIoredis()).Redis;
    if (closed) {
      throw closedError();
    }
    let client: ValkeyClient;
    try {
      client = new Client(
        target,
        valkeyRoleOptions(role, connectionName, timeouts),
      ) as ValkeyClient;
    } catch (error) {
      throw sanitizeBackendError(error, 'Valkey connection', unavailable);
    }
    open.add(client);
    watchClient(client, () => open.delete(client), report);
    try {
      await withDeadline(client.connect(), timeouts.connectMs, () => {
        client.disconnect();
      });
    } catch (error) {
      open.delete(client);
      client.disconnect();
      if (closed) {
        // The close disconnected this client mid-connect; that is the cause.
        throw closedError();
      }
      throw error instanceof ValkeyError
        ? error
        : sanitizeBackendError(error, 'Valkey connection', unavailable);
    }
    if (closed) {
      // A close that raced the connect must not leave the client behind.
      open.delete(client);
      client.disconnect();
      throw closedError();
    }
    return client;
  }

  function shared(role: SharedValkeyRole): Promise<ValkeyClient> {
    if (closed) {
      return Promise.reject(closedError());
    }
    const existing = sharedClients.get(role);
    if (existing !== undefined) {
      return existing;
    }
    const pending = connect(role, `${name}:${role}`);
    sharedClients.set(role, pending);
    pending.then(
      (client) => {
        // A shared client someone ended (`quit`, `disconnect`) is replaced on
        // the next call instead of being handed out dead.
        client.on('end', () => {
          if (sharedClients.get(role) === pending) {
            sharedClients.delete(role);
          }
        });
      },
      () => {
        if (sharedClients.get(role) === pending) {
          sharedClients.delete(role);
        }
      },
    );
    return pending;
  }

  const closeOnce = createCleanup(() => {
    closed = true;
    sharedClients.clear();
    for (const client of open) {
      client.disconnect();
    }
    open.clear();
  });

  return Object.freeze({
    prefix,
    shared,
    dedicated(role: DedicatedValkeyRole, dedicatedName: string): Promise<ValkeyClient> {
      if (closed) {
        return Promise.reject(closedError());
      }
      if (role !== 'blocking' && role !== 'queue') {
        return Promise.reject(
          new ValkeyError('invalid_options', 'dedicated role must be blocking or queue'),
        );
      }
      let suffix: string;
      try {
        suffix = readPattern(dedicatedName, NAME_PATTERN, 'dedicated connection name');
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return connect(role, `${name}:${role}:${suffix}`);
    },
    script(definition: ValkeyScriptDefinition): ValkeyScript {
      return bindScript(definition, () => shared('command'));
    },
    close: closeOnce,
  });
}

/** Turn a backend failure message into the provider's value-free error. */
function unavailable(message: string): ValkeyError {
  return new ValkeyError('unavailable', message);
}

function closedError(): ValkeyError {
  return new ValkeyError('closed', 'the Valkey connections are closed');
}

/**
 * Report post-connect failures once per outage: ioredis emits an `error` for
 * every failed reconnect attempt, and the next `ready` re-arms the report.
 * Errors before the first `ready` reach the caller through the connect.
 */
function watchClient(
  client: ValkeyClient,
  onEnd: () => void,
  report: (error: unknown) => void,
): void {
  let ready = false;
  let reported = false;
  client.on('ready', () => {
    ready = true;
    reported = false;
  });
  client.on('error', (error: unknown) => {
    if (!ready || reported) {
      return;
    }
    reported = true;
    report(error);
  });
  client.on('end', onEnd);
}

/** Settle with `work`, or run `onTimeout` and reject `unavailable` after `ms`. */
function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ValkeyError('unavailable', `Valkey connect timed out after ${ms} ms`));
      onTimeout();
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('Valkey connect failed'));
      },
    );
  });
}

/**
 * Bind a script: `EVALSHA` by the source's SHA-1 and, when the server answers
 * `NOSCRIPT` (a restart or `SCRIPT FLUSH`), `EVAL` with the source, which also
 * caches it for the next `EVALSHA`. The commands are built here rather than
 * through ioredis's `defineCommand` so a script can carry its own reply
 * deadline: ioredis arms a command's deadline only once, so one set before the
 * client's default takes precedence.
 */
function bindScript(
  definition: ValkeyScriptDefinition,
  client: () => Promise<ValkeyClient>,
): ValkeyScript {
  if (definition === null || typeof definition !== 'object' || typeof definition.lua !== 'string') {
    throw new ValkeyError('invalid_options', 'a Valkey script needs its Lua source');
  }
  const timeoutMs = definition.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new ValkeyError(
      'invalid_options',
      'a Valkey script timeoutMs must be a positive integer',
    );
  }
  const lua = definition.lua;
  const sha = createHash('sha1').update(lua).digest('hex');

  return Object.freeze({
    async run(keys: readonly string[], args: readonly (string | number)[]): Promise<unknown> {
      const connected = await client();
      const { Command } = await loadIoredis();
      const send = (name: 'evalsha' | 'eval', body: string): Promise<unknown> => {
        const command = new Command(name, [body, keys.length, ...keys, ...args], {
          replyEncoding: 'utf8',
        });
        if (timeoutMs !== undefined) {
          command.setTimeout(timeoutMs);
        }
        return connected.sendCommand(command) as Promise<unknown>;
      };
      try {
        try {
          return await send('evalsha', sha);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('NOSCRIPT')) {
            throw error;
          }
          return await send('eval', lua);
        }
      } catch (error) {
        throw scriptError(error);
      }
    },
  });
}

/**
 * The value-free error of a failed script run. ioredis rejects a server error
 * reply as a `ReplyError` whose message is the script's own error text, and a
 * missed deadline with `Command timed out`; everything else is the connection.
 */
function scriptError(error: unknown): Error {
  if (error instanceof Error && error.name === 'ReplyError') {
    return new ValkeyError('script_failed', 'a Valkey script raised an error');
  }
  if (error instanceof Error && error.message === 'Command timed out') {
    return new ValkeyError('unavailable', 'a Valkey script timed out');
  }
  return sanitizeBackendError(error, 'Valkey script', unavailable);
}

function readPattern(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ValkeyError('invalid_options', `${label} must match ${String(pattern)}`);
  }
  return value;
}

function readTimeouts(value: Partial<ValkeyTimeouts> | undefined): ValkeyTimeouts {
  if (value === undefined) {
    return DEFAULT_VALKEY_TIMEOUTS;
  }
  if (value === null || typeof value !== 'object') {
    throw new ValkeyError('invalid_options', 'timeouts must be an object');
  }
  const connectMs = value.connectMs ?? DEFAULT_VALKEY_TIMEOUTS.connectMs;
  const commandMs = value.commandMs ?? DEFAULT_VALKEY_TIMEOUTS.commandMs;
  for (const [label, ms] of [
    ['timeouts.connectMs', connectMs],
    ['timeouts.commandMs', commandMs],
  ] as const) {
    if (!Number.isSafeInteger(ms) || ms <= 0) {
      throw new ValkeyError('invalid_options', `${label} must be a positive integer`);
    }
  }
  return Object.freeze({ connectMs, commandMs });
}
