/**
 * The conformance app for the response model: one route per producer, each
 * in a plain and a publicly cacheable variant (`cacheControl` export), plus a
 * global middleware that stages headers before or after `next()` on request.
 *
 * Producers cover every way a response reaches the finalization stages: the
 * `Respond` factories, a raw `Response`, `Response.json`, immutable-header
 * responses (`Response.redirect`, a fetched response), a large compressible
 * body, a progressive stream, server-sent events, a 206 partial answer, a
 * page document and a streamed page. A producer that honours `?status=`
 * answers with that status.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Hono } from 'hono';

import { preactPageRenderer } from '../../../src/pages/page.js';
import { discoverRoutes } from '../../../src/routing/routes.js';
import { createApp } from '../../../src/server/app.js';
import type { AppEnv } from '../../../src/server/env.js';
import type { Session } from '../../../src/contracts/http.js';
import { createTestSession } from '../../../src/testing/index.js';
import { writeFixture } from '../../fixtures/app.js';

/** Milliseconds between the chunks of every streaming producer. */
export const CHUNK_INTERVAL_MS = 5;

/** How a producer is reached and what it promises. */
export interface Producer {
  readonly name: string;
  readonly kind: 'api' | 'page';
  /** The statuses it can be asked for; the first is its natural one. */
  readonly statuses: readonly number[];
  /** Its body is known, sized and under 1024 bytes. */
  readonly small: boolean;
  /** Its body is produced over time, one chunk per interval. */
  readonly streams: boolean;
  /** Its body is large and compressible. */
  readonly compressible: boolean;
  /**
   * What the client must receive once the content coding is removed: the
   * exact body of an API producer, or text a page document must contain.
   */
  readonly body: { readonly exact: string } | { readonly contains: string };
}

type ProducerSpec = Pick<Producer, 'name' | 'kind' | 'statuses' | 'body'> &
  Partial<Pick<Producer, 'small' | 'streams' | 'compressible'>>;

/** The large JSON producer's body, as its module serializes it. */
const LARGE_BODY = JSON.stringify({
  items: Array.from({ length: 400 }, (_, id) => ({ id, name: `item number ${id}` })),
});

const OK = { exact: '{"ok":true}' };

const SPECS: readonly ProducerSpec[] = [
  { name: 'respond-json', kind: 'api', statuses: [200, 404, 503], small: true, body: OK },
  {
    name: 'raw-string',
    kind: 'api',
    statuses: [200, 404, 503],
    small: true,
    body: { exact: 'hello world' },
  },
  { name: 'response-json', kind: 'api', statuses: [200, 404, 503], small: true, body: OK },
  {
    name: 'large-json',
    kind: 'api',
    statuses: [200, 404, 503],
    compressible: true,
    body: { exact: LARGE_BODY },
  },
  { name: 'redirect', kind: 'api', statuses: [302], body: { exact: '' } },
  { name: 'fetched', kind: 'api', statuses: [200], small: true, body: OK },
  { name: 'stream', kind: 'api', statuses: [200], streams: true, body: { exact: 'one two three' } },
  {
    name: 'event-stream',
    kind: 'api',
    statuses: [200],
    streams: true,
    body: { exact: 'data: 1\n\ndata: 2\n\ndata: 3\n\n' },
  },
  { name: 'partial', kind: 'api', statuses: [206], small: true, body: { exact: 'hello' } },
  { name: 'page', kind: 'page', statuses: [200], small: true, body: { contains: 'a small page' } },
  {
    name: 'page-stream',
    kind: 'page',
    statuses: [200],
    streams: true,
    body: { contains: '<p>one</p><p>two</p><p>three</p>' },
  },
];

export const PRODUCERS: readonly Producer[] = SPECS.map((spec) => ({
  small: false,
  streams: false,
  compressible: false,
  ...spec,
}));

const distDir = fileURLToPath(new URL('../../../', import.meta.url));
const respondUrl = new URL('../../../src/api/responses.js', import.meta.url).href;
const gateUrl = new URL('./stream-gate.js', import.meta.url).href;

const statusOf = `const statusOf = (request, fallback) =>
  Number(new URL(request.url).searchParams.get('status') ?? fallback);
const tick = () => new Promise((resolve) => setTimeout(resolve, ${CHUNK_INTERVAL_MS}));
const encoder = new TextEncoder();
// After the first chunk the producer waits at the request's gate until the
// client has that chunk (see stream-gate.ts).
function slowStream(request, chunks) {
  const gate = request.headers.get('x-gate');
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      await tick();
      if (index === 1 && gate !== null) await waitAtGate(gate);
      if (index === chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
}
`;

const API_BODIES: Readonly<Record<string, string>> = {
  'respond-json': `export const GET = (request) => Respond.json({ ok: true }, { status: statusOf(request, 200) });`,
  'raw-string': `export const GET = (request) =>
  new Response('hello world', {
    status: statusOf(request, 200),
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });`,
  'response-json': `export const GET = (request) => Response.json({ ok: true }, { status: statusOf(request, 200) });`,
  'large-json': `const items = Array.from({ length: 400 }, (_, id) => ({ id, name: 'item number ' + id }));
export const GET = (request) => Response.json({ items }, { status: statusOf(request, 200) });`,
  redirect: `export const GET = (request) => Response.redirect(new URL('/elsewhere', request.url), 302);`,
  fetched: `export const GET = () => fetch('data:application/json,' + encodeURIComponent('{"ok":true}'));`,
  stream: `export const GET = (request) =>
  new Response(slowStream(request, ['one ', 'two ', 'three']), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });`,
  'event-stream': `export const GET = (request) =>
  new Response(slowStream(request, ['data: 1\\n\\n', 'data: 2\\n\\n', 'data: 3\\n\\n']), {
    headers: { 'content-type': 'text/event-stream' },
  });`,
  partial: `export const GET = () =>
  new Response('hello', {
    status: 206,
    headers: { 'content-type': 'text/plain', 'content-range': 'bytes 0-4/11' },
  });`,
};

const PAGE_BODIES: Readonly<Record<string, string>> = {
  page: `export default () => 'a small page';`,
  'page-stream': `export const stream = async function* (context) {
  const gate = context.request.headers.get('x-gate');
  yield '<p>one</p>';
  if (gate !== null) await waitAtGate(gate);
  for (const chunk of ['<p>two</p>', '<p>three</p>']) {
    await new Promise((resolve) => setTimeout(resolve, ${CHUNK_INTERVAL_MS}));
    yield chunk;
  }
};
export default () => 'unused';`,
};

/** The path of `producer`, in its public variant when `cacheable`. */
export function producerPath(producer: Producer, cacheable: boolean): string {
  const base = producer.kind === 'api' ? '/api' : '';
  return `${base}${cacheable ? '/public' : ''}/${producer.name}`;
}

function writeProducers(root: string): void {
  const gateImport = `import { waitAtGate } from ${JSON.stringify(gateUrl)};\n`;
  const cacheExport = 'export const cacheControl = { maxAge: 60 };\n';
  for (const producer of PRODUCERS) {
    for (const cacheable of [false, true]) {
      const declared = cacheable ? cacheExport : '';
      if (producer.kind === 'api') {
        const module = `import { Respond } from ${JSON.stringify(respondUrl)};\n${gateImport}${statusOf}${declared}${API_BODIES[producer.name]}\n`;
        writeFixture(root, `api${cacheable ? '/public' : ''}/${producer.name}.mjs`, module);
      } else {
        const module = `${gateImport}${declared}${PAGE_BODIES[producer.name]}\n`;
        writeFixture(root, `pages${cacheable ? '/public' : ''}/${producer.name}/index.mjs`, module);
      }
    }
  }
  writeFixture(
    root,
    'pages/late/index.mjs',
    `export const stream = async function* () {
  yield '<p>first</p>';
  // Well after the adapter's first non-blocking reads, so the failure takes
  // the same path on every run.
  await new Promise((resolve) => setTimeout(resolve, 50));
  throw new Error('late failure');
};
export default () => 'unused';
`,
  );
}

/** The response-model app and its fixture directory. */
export interface ResponseApp {
  readonly app: Hono<AppEnv>;
  close(): void;
}

/** Build the response-model conformance app. */
export async function createResponseApp(): Promise<ResponseApp> {
  const root = mkdtempSync(join(distDir, 'conformance-response-'));
  writeProducers(root);
  const session: Session = createTestSession({ id: 's1' });
  const app = await createApp({
    manifest: discoverRoutes(root),
    renderer: preactPageRenderer,
    authorize: () => true,
    resolveSession: (request) =>
      /(?:^|;\s*)sid=s1(?:;|$)/.test(request.headers.get('cookie') ?? '') ? session : null,
    // A late stream failure is the case under test, not a suite failure.
    onError: () => undefined,
    globalMiddleware: [
      async (c, next) => {
        const mode = c.req.header('x-middleware');
        if (mode === 'pre') {
          c.header('X-Staged', 'pre');
          c.header('Set-Cookie', 'staged=1; Path=/', { append: true });
        }
        await next();
        if (mode === 'post') c.header('X-Post', 'post');
      },
    ],
  });
  return { app, close: () => rmSync(root, { recursive: true, force: true }) };
}
