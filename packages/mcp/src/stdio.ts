/**
 * Serving a defined server over stdio, on the SDK's `serveStdio`: the opening
 * message picks the era (a `server/discover` probe or any 2026-07-28 request
 * for the modern revision, an `initialize` handshake for 2025), and one
 * factory unit is pinned for the connection's lifetime.
 *
 * The connection is the unit, so the legacy shim is on: a handler that asks
 * for input on a 2025 connection gets it through real server-to-client
 * elicitation, and the handler is written once for both eras.
 *
 * {@link serveMcpStdio} resolves when the connection closes: the client
 * closing stdin (end of file), the `signal` aborting, or a transport fault.
 * Nothing but protocol frames is written to stdout; operator reports go to the
 * `onError` hook (by default `console.error`, which writes to stderr).
 */

import type { Readable, Writable } from 'node:stream';

import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { parseActor, type McpActor } from './access.js';
import type { McpServerDefinition } from './definitions.js';
import { McpDefinitionError } from './errors.js';
import {
  createMcpServerFactory,
  reporter,
  type McpServingOptions,
  type Site,
} from './server-factory.js';
import { detach, escalate } from 'jsails/support';

/** Options for {@link serveMcpStdio}. */
export interface McpStdioOptions extends McpServingOptions {
  /**
   * Who is calling. Default: the local developer who launched the process
   * (`{ kind: 'developer', scopes: '*' }`).
   */
  readonly actor?: McpActor;
  /** Serve 2025-era clients (the default) or refuse their handshake. */
  readonly legacy?: 'serve' | 'reject';
  /** Closes the connection when aborted. */
  readonly signal?: AbortSignal;
  /** The input stream. Default `process.stdin`. */
  readonly stdin?: Readable;
  /** The output stream. Default `process.stdout`. */
  readonly stdout?: Writable;
}

const DEVELOPER: McpActor = Object.freeze({ kind: 'developer', scopes: '*' });
const TRANSPORT: Site = Object.freeze({ kind: 'transport', name: 'stdio' });

function invalidOption(option: string, reason: string): McpDefinitionError {
  return new McpDefinitionError('invalid_option', `${option} ${reason}`, { option });
}

function checkActor(value: unknown): McpActor {
  if (value === undefined) {
    return DEVELOPER;
  }
  const actor = parseActor(value);
  if (actor === undefined) {
    throw invalidOption(
      'actor',
      'must be an actor with a known kind, a non-empty id when given, and string scopes or "*"',
    );
  }
  return actor;
}

/**
 * The transport `serveStdio` owns, wrapped so the connection's end is
 * observable: the SDK entry assigns its own `onclose`, and this wrapper calls
 * it and then reports the close.
 */
class ObservedTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?:
    (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;

  constructor(
    private readonly inner: Transport,
    private readonly closed: () => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  async start(): Promise<void> {
    this.inner.onmessage = (message, extra) => {
      this.onmessage?.(message, extra);
    };
    this.inner.onerror = (error) => {
      this.onerror?.(error);
    };
    this.inner.onclose = () => {
      this.onclose?.();
      this.closed();
    };
    try {
      await this.inner.start();
    } catch (error) {
      this.failed(error);
      throw error;
    }
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/**
 * Serve a defined server over stdio until the connection closes. Rejects with
 * {@link McpDefinitionError} on malformed options (and for every reason
 * `createMcpServerFactory` throws), and with the transport's error when the
 * streams cannot be started.
 */
export async function serveMcpStdio(
  server: McpServerDefinition,
  options: McpStdioOptions = {},
): Promise<void> {
  const actor = checkActor(options.actor);
  if (options.legacy !== undefined && options.legacy !== 'serve' && options.legacy !== 'reject') {
    throw invalidOption('legacy', "must be 'serve' or 'reject'");
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw invalidOption('signal', 'must be an AbortSignal');
  }
  const factory = createMcpServerFactory(server, options);
  const report = reporter(options.onError);
  const signal = options.signal;
  await new Promise<void>((resolve, reject) => {
    let abort: () => void = () => undefined;
    const transport = new ObservedTransport(
      new StdioServerTransport(options.stdin, options.stdout),
      () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      },
      (failure) => {
        signal?.removeEventListener('abort', abort);
        reject(
          failure instanceof Error ? failure : new Error('the stdio transport failed to start'),
        );
      },
    );
    const handle = serveStdio((ctx) => factory({ actor, era: ctx.era, channel: 'connected' }), {
      legacy: options.legacy ?? 'serve',
      transport,
      onerror: (error) => {
        report('transport_error', 'the stdio transport reported an error', TRANSPORT, error);
      },
    });
    abort = () => {
      detach(handle.close(), escalate);
    };
    if (signal?.aborted === true) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }
  });
}
