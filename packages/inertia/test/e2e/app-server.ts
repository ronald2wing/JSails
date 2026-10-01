/**
 * The server half of an end-to-end scenario: the Inertia engine behind a
 * minimal router on an ephemeral `127.0.0.1` listener.
 *
 * A loopback listener rather than happy-dom's fetch interceptor, because the
 * spike showed the interceptor short-circuits the browser semantics the
 * protocol depends on: a `Response` returned from `beforeAsyncRequest` reaches
 * the XHR as it is, so a `303` is handed to the client unfollowed and its
 * `Set-Cookie` never reaches the cookie jar. Over a real socket happy-dom
 * follows redirects and keeps cookies as a browser does.
 *
 * Each request becomes {@link InertiaRequestFacts} plus its body text; a
 * handler answers with an engine outcome or a web `Response`. Every request
 * is logged with its method, path and query, the Inertia and Precognition
 * request headers, whether it carried the carrier cookie, and the status, so
 * a scenario can assert on the exact wire exchange the client produced.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { text } from 'node:stream/consumers';

import {
  outcomeToResponse,
  CARRIER_COOKIE,
  type InertiaOutcome,
  type InertiaRequestFacts,
} from '../../src/index.js';

/** One request as a handler sees it. */
export interface AppRequest {
  readonly facts: InertiaRequestFacts;
  readonly body: string;
}

/** Answers one route. */
export type AppHandler = (
  request: AppRequest,
) => Promise<InertiaOutcome | Response> | InertiaOutcome | Response;

/** Routes keyed by `METHOD /path`. */
export type AppRoutes = Readonly<Record<string, AppHandler>>;

/** One logged request. */
export interface RequestRecord {
  readonly method: string;
  /** Path and query. */
  readonly url: string;
  /** The Inertia and Precognition request headers that were present. */
  readonly headers: Readonly<Record<string, string>>;
  /** The request carried the flash and errors carrier cookie. */
  readonly carrier: boolean;
  status: number;
}

/** A running scenario server. */
export interface AppServer {
  readonly origin: string;
  readonly log: readonly RequestRecord[];
  /** Requests received but not answered yet. */
  pending(): number;
  close(): Promise<void>;
}

const LOGGED_HEADERS = [
  'x-inertia',
  'x-inertia-version',
  'x-inertia-partial-component',
  'x-inertia-partial-data',
  'x-inertia-partial-except',
  'x-inertia-reset',
  'x-inertia-except-once-props',
  'x-inertia-error-bag',
  'x-inertia-infinite-scroll-merge-intent',
  'purpose',
  'precognition',
  'precognition-validate-only',
];

/** Start a server for `routes` on an ephemeral loopback port. */
export async function startAppServer(routes: AppRoutes): Promise<AppServer> {
  const log: RequestRecord[] = [];
  let pending = 0;
  const server = createServer((request, response) => {
    pending += 1;
    void answer(routes, log, request, response).finally(() => {
      pending -= 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    log,
    pending: () => pending,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

async function answer(
  routes: AppRoutes,
  log: RequestRecord[],
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const headers = new Headers();
  for (const [name, values] of Object.entries(request.headersDistinct)) {
    for (const value of values ?? []) headers.append(name, value);
  }
  const url = new URL(request.url ?? '/', `http://${headers.get('host') ?? 'localhost'}`);
  const method = (request.method ?? 'GET').toUpperCase();
  const record: RequestRecord = {
    method,
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(
      LOGGED_HEADERS.flatMap((name) => {
        const value = headers.get(name);
        return value === null ? [] : [[name, value]];
      }),
    ),
    carrier: (headers.get('cookie') ?? '').includes(`${CARRIER_COOKIE}=`),
    status: 0,
  };
  log.push(record);
  const controller = new AbortController();
  response.on('close', () => {
    if (!response.writableFinished) controller.abort();
  });
  const body = await text(request);
  const handler = routes[`${method} ${url.pathname}`];
  let reply: Response;
  try {
    const answered =
      handler === undefined
        ? new Response('not found', { status: 404 })
        : await handler({
            facts: { method, url, headers, signal: controller.signal },
            body,
          });
    reply = answered instanceof Response ? answered : outcomeToResponse(answered);
  } catch (error) {
    console.error('[inertia e2e] handler failed', error);
    reply = new Response('server error', { status: 500 });
  }
  record.status = reply.status;
  const payload = Buffer.from(await reply.arrayBuffer());
  const outgoing: Record<string, string | string[]> = {};
  reply.headers.forEach((value, name) => {
    if (name !== 'set-cookie') outgoing[name] = value;
  });
  const cookies = reply.headers.getSetCookie();
  if (cookies.length > 0) outgoing['set-cookie'] = cookies;
  response.writeHead(reply.status, outgoing);
  response.end(payload);
}
