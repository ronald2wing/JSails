/**
 * Test fixtures for `@jsails/mcp`: actors, a serving-error collector, a seeded
 * generator for property tests, a time bound for cancellation, and harnesses
 * that put a server factory on a real wire. `overHttp` serves it through the
 * SDK's `createMcpHandler` and connects the official client over Streamable
 * HTTP (in-process `fetch`, no socket) in the modern or legacy era;
 * `overMemory` connects the official client to one unit over a linked
 * in-memory transport (a transport without HTTP, so scope challenges cannot
 * preempt dispatch).
 */

import {
  Client,
  StreamableHTTPClientTransport,
  type ClientCapabilities,
} from '@modelcontextprotocol/client';
import { createMcpHandler, InMemoryTransport } from '@modelcontextprotocol/server';

import type { McpActor } from '../src/access.js';
import type { McpServingError } from '../src/errors.js';
import type { McpServerFactory } from '../src/server-factory.js';

export const USER: McpActor = Object.freeze({
  kind: 'user',
  id: 'user-1',
  scopes: Object.freeze([]),
});

export type Era = 'modern' | 'legacy';
export const ERAS: readonly Era[] = ['modern', 'legacy'];

/**
 * How long a cancelled call's handler may take to see its signal abort. It
 * is far below the 30 s handler deadline (which aborts the signal too), so a
 * cancellation that never reaches the handler fails the test instead of
 * passing late.
 */
export const CANCEL_WITHIN_MS = 5_000;

/** `promise`, or a rejection naming `what` when it has not settled within `ms`. */
export async function within<T>(
  promise: Promise<T>,
  what: string,
  ms = CANCEL_WITHIN_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not happen within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Collects serving errors handed to `onError`. */
export function errorSink(): {
  readonly errors: McpServingError[];
  readonly onError: (error: McpServingError) => void;
} {
  const errors: McpServingError[] = [];
  return { errors, onError: (error) => void errors.push(error) };
}

/** A recorded HTTP exchange. */
export interface Exchange {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Promise<string>;
}

/** An HTTP harness around one factory and one actor. */
export interface HttpHarness {
  readonly exchanges: Exchange[];
  connect(era: Era): Promise<Client>;
  close(): Promise<void>;
}

/** Serve `factory` over the SDK HTTP entry for `actor`. */
export function overHttp(factory: McpServerFactory, actor: McpActor = USER): HttpHarness {
  const handler = createMcpHandler((ctx) => factory({ actor, era: ctx.era }));
  const exchanges: Exchange[] = [];
  const clients: Client[] = [];
  const fetchThrough = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const response = await handler.fetch(new Request(url, init));
    exchanges.push({
      status: response.status,
      headers: response.headers,
      body: response.clone().text(),
    });
    return response;
  };
  return {
    exchanges,
    async connect(era) {
      const client = new Client(
        { name: 'test-client', version: '7.0.0' },
        { versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' } },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: fetchThrough }),
      );
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      await handler.close();
    },
  };
}

/**
 * Connect the official client to one unit over an in-memory transport (legacy
 * handshake), declaring `capabilities`.
 */
export async function overMemory(
  factory: McpServerFactory,
  actor: McpActor = USER,
  capabilities: ClientCapabilities = {},
): Promise<{ readonly client: Client; close(): Promise<void> }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = await factory({ actor, era: 'legacy' });
  await server.connect(serverSide);
  const client = new Client(
    { name: 'memory-client', version: '1.0.0' },
    { capabilities, versionNegotiation: { mode: 'legacy' } },
  );
  await client.connect(clientSide);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** The code, message, and data of a rejected client call. */
export async function rejection(
  call: Promise<unknown>,
): Promise<{ code: unknown; message: string; data: unknown }> {
  try {
    await call;
  } catch (error) {
    const { code, message, data } = error as { code?: unknown; message: string; data?: unknown };
    return { code, message, data };
  }
  throw new Error('expected the call to reject');
}

/** mulberry32: a small deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded value generator. */
export interface Gen {
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  bool(): boolean;
}

export function generator(seed: number): Gen {
  const next = mulberry32(seed);
  return {
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    bool: () => next() < 0.5,
  };
}

/** Run `check` for `runs` seeds, naming the failing seed. */
export async function forAll(
  baseSeed: number,
  runs: number,
  check: (gen: Gen, seed: number) => Promise<void> | void,
): Promise<void> {
  for (let run = 0; run < runs; run += 1) {
    const seed = (baseSeed + run) >>> 0;
    try {
      await check(generator(seed), seed);
    } catch (error) {
      throw new Error(`property failed for seed ${seed}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
}
