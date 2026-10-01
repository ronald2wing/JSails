/**
 * A `fetch` for adapter tests: it serves stored wire fixtures (server-sent
 * event streams and JSON error bodies) to the real provider SDKs and records
 * every request the SDK sends, so a test exercises the SDK's own SSE parser,
 * retry logic, and error classes and can compare the exact request body.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The fixture directory of one provider (`test/fixtures/<provider>/`). */
export function fixtureDir(provider: string): string {
  // Compiled tests run from dist/test/<dir>/; fixtures stay in the source tree.
  return fileURLToPath(new URL(`../../../test/fixtures/${provider}/`, import.meta.url));
}

/** The text of one stored fixture. */
export function readFixture(provider: string, name: string): string {
  return readFileSync(`${fixtureDir(provider)}${name}`, 'utf8');
}

/** One request the SDK sent. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The raw body text, byte for byte as sent. */
  readonly bodyText: string;
  readonly body: unknown;
}

/** What the fake server answers one request with. */
export type FixtureReply =
  | { readonly kind: 'sse'; readonly text: string; readonly chunkSize?: number }
  | {
      readonly kind: 'json';
      readonly status: number;
      readonly body: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'stream'; readonly body: ReadableStream<Uint8Array> }
  | { readonly kind: 'network-error' };

/** A fetch that answers from a script of replies and records the requests. */
export interface FixtureFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: RecordedRequest[];
}

function sseBody(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

function headerRecord(headers: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(headers as ConstructorParameters<typeof Headers>[0]).forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

/** A fetch answering request `n` with `replies[n]` (the last reply repeats). */
export function fixtureFetch(replies: readonly FixtureReply[]): FixtureFetch {
  const requests: RecordedRequest[] = [];
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: headerRecord(init?.headers),
      bodyText,
      body: bodyText.length > 0 ? (JSON.parse(bodyText) as unknown) : undefined,
    });
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    if (reply === undefined || reply.kind === 'network-error') {
      throw new TypeError('fetch failed');
    }
    if (reply.kind === 'json') {
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json', ...reply.headers },
      });
    }
    const body = reply.kind === 'sse' ? sseBody(reply.text, reply.chunkSize ?? 64) : reply.body;
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture' },
    });
  };
  return { fetch: fetchImpl, requests };
}

/**
 * An endless event stream that counts how many chunks were pulled from it;
 * `chunk(n)` is the text of the n-th chunk.
 */
export function countingStream(chunk: (index: number) => string): {
  readonly body: ReadableStream<Uint8Array>;
  readonly pulls: () => number;
} {
  let pulled = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(encoder.encode(chunk(pulled)));
        pulled += 1;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, pulls: () => pulled };
}
