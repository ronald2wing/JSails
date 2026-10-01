/**
 * The two ways every conformance case is sent: through `app.fetch` and
 * through the production request listener (`createHttpServer`'s Node adapter)
 * over an in-memory socket, so the adapter's own conversion and write path is
 * part of what each case observes.
 *
 * Creating the listener installs the adapter's lightweight global
 * `Request`/`Response`, as starting a server does in production; both drivers
 * therefore run against the same globals.
 */

import type { Hono } from 'hono';

import { createHttpServer } from '../../../src/server/http-server.js';
import type { AppEnv } from '../../../src/server/env.js';
import { listenerModule, type RequestListener } from './bench-tools.js';

/** The driver names, as they appear in test names. */
export type DriverName = 'app.fetch' | 'listener';

/** One body chunk as the client received it, with its arrival time. */
export interface DrivenChunk {
  readonly bytes: Uint8Array;
  readonly at: number;
}

/** What a client received. */
export interface DrivenResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly chunks: readonly DrivenChunk[];
  text(): string;
  /** The error that cut the body short (an errored stream, a destroyed socket). */
  readonly error?: string;
  /** Listener only: whether the body went out in `res.end(bytes)`. */
  readonly endedWithBody?: boolean;
  /** Listener only: `res.write` calls that carried data. */
  readonly writes?: number;
  /** Listener only: the header lines as sent, duplicates kept. */
  readonly rawHeaders?: readonly (readonly [string, string])[];
}

/** Options of {@link Driver.send}. */
export interface SendOptions {
  /** Disconnect after this many body chunks, as a client that goes away. */
  readonly abortAfterChunks?: number;
  /** Called with `n` as the n-th body chunk reaches the client. */
  readonly onChunk?: (count: number) => void;
  /**
   * `app.fetch` only: called once the response head is back and before its
   * body is read, so a measurement can leave out the client's own reading.
   */
  readonly onHead?: () => void;
}

/** A way to send one request to the app under test. */
export interface Driver {
  readonly name: DriverName;
  send(request: Request, options?: SendOptions): Promise<DrivenResponse>;
}

function concat(chunks: readonly DrivenChunk[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.bytes.byteLength, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk.bytes, offset);
    offset += chunk.bytes.byteLength;
  }
  return joined;
}

/** Read `response` as a client would, chunk by chunk. */
async function readAsClient(
  response: Response,
  started: number,
  options: SendOptions,
): Promise<DrivenResponse> {
  const chunks: DrivenChunk[] = [];
  let error: string | undefined;
  const body = response.body;
  if (body !== null) {
    const reader = body.getReader();
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        chunks.push({ bytes: step.value, at: performance.now() - started });
        options.onChunk?.(chunks.length);
        if (options.abortAfterChunks !== undefined && chunks.length >= options.abortAfterChunks) {
          await reader.cancel();
          break;
        }
      }
    } catch (failure) {
      // A body that errors mid-way reaches a client as a truncated response.
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  const bytes = concat(chunks);
  return {
    status: response.status,
    headers: response.headers,
    body: bytes,
    chunks,
    text: () => new TextDecoder().decode(bytes),
    ...(error === undefined ? {} : { error }),
  };
}

/** The production request listener of `app`, without a listening socket. */
export function requestListenerOf(app: Hono<AppEnv>): RequestListener {
  const [listener] = createHttpServer(app).listeners('request');
  if (typeof listener !== 'function') throw new Error('the server has no request listener');
  return listener;
}

/** Both drivers for `app`. */
export function createDrivers(app: Hono<AppEnv>): readonly Driver[] {
  const listener = requestListenerOf(app);
  return [
    {
      name: 'app.fetch',
      async send(request, options = {}) {
        const started = performance.now();
        const response = await app.fetch(request);
        options.onHead?.();
        return readAsClient(response, started, options);
      },
    },
    {
      name: 'listener',
      async send(request, options = {}) {
        const { abortAfterChunks, onChunk } = options;
        const result = await listenerModule.driveListener(listener, request, {
          ...(abortAfterChunks === undefined ? {} : { abortAfterChunks }),
          ...(onChunk === undefined ? {} : { onChunk }),
        });
        return {
          status: result.status,
          headers: result.headers,
          body: result.body,
          chunks: result.chunks,
          text: () => result.text(),
          endedWithBody: result.endedWithBody,
          writes: result.writes,
          rawHeaders: result.rawHeaders,
          ...(result.error === undefined ? {} : { error: result.error }),
        };
      },
    },
  ];
}
