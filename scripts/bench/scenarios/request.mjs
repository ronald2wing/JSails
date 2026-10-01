/**
 * Request scenarios: one small app, each request measured through both
 * drivers (`Application.fetch` and the real request listener). They cover the
 * shapes the request kernel work changes first: a small JSON API response, a
 * JSON body large enough to encode, a 1 KiB JSON POST read through the
 * request's body budget (`ctx.body.json` on a route declaring its body), a
 * small server-rendered page, a static file (answered whole, revalidated with
 * a 304, and a 200 KiB one streamed from disk), a JSON 404, and a browser's HTML
 * 404 (anonymous, so its page is kept and a repeat renders nothing). Every
 * request carries a browser's `Accept-Encoding`, so compression decisions are
 * on the measured path.
 */

import { ORIGIN } from '../app.mjs';

// `serve` outside development requires `server.origin` and answers any other
// Host 421; the drivers address every request to ORIGIN.
const APP_CONFIG = `export default {
  host: '127.0.0.1',
  port: 0,
  server: { origin: '${ORIGIN}' },
};
`;

const BROWSER = { 'accept-encoding': 'gzip, deflate, br, zstd' };

// Every API module states its access; these are public benchmark routes.
const OPEN = 'export const authorize = () => true;\n';

const files = {
  'jsails.app.js': APP_CONFIG,
  'api/hello.js': OPEN + 'export function GET() {\n  return Response.json({ ok: true });\n}\n',
  'api/items.js':
    OPEN +
    "const items = Array.from({ length: 200 }, (_, id) => ({ id, name: 'item number ' + id }));\n" +
    'export function GET() {\n  return Response.json({ items });\n}\n',
  'api/echo.js':
    OPEN +
    "export const body = { kind: 'json', maxBytes: 4096 };\n" +
    'const schema = { validate: (input) => input };\n' +
    'export async function POST(_request, context) {\n' +
    '  const value = await context.body.json(schema);\n' +
    '  return Response.json({ fields: Object.keys(value).length });\n' +
    '}\n',
  'pages/index.js': "export default function Home() {\n  return 'hello';\n}\n",
  'public/robots.txt': 'User-agent: *\n',
  // Above the index's 64 KiB inline limit, and of a type the finalizer leaves
  // uncompressed, so the bytes come from one open of the file.
  'public/large.bin': 'x'.repeat(200 * 1024),
};

/** The `ETag` of `public/robots.txt`: its SHA-256, base64url, first 16 characters. */
const ROBOTS_ETAG = '"_Yk0Wvaspdq4Xyqm"';

const request = (name, path, accept, expectStatus = 200, headers = {}) => ({
  name,
  kind: 'request',
  files,
  request: { path, headers: { ...BROWSER, accept, ...headers } },
  expectStatus,
  drivers: ['fetch', 'listener'],
});

/** A JSON object of about 1 KiB (999 bytes): 16 fields of 50-character strings. */
const POST_JSON = JSON.stringify(
  Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`field${index}`, 'x'.repeat(50)])),
);

export const scenarios = [
  request('api-small-json', '/api/hello', 'application/json'),
  request('page-small', '/', 'text/html'),
  request('static-small', '/robots.txt', 'text/plain'),
  request('static-304', '/robots.txt', 'text/plain', 304, { 'if-none-match': ROBOTS_ETAG }),
  request('static-large', '/large.bin', '*/*'),
  request('not-found-json', '/missing', 'application/json', 404),
  request('api-large-json', '/api/items', 'application/json'),
  request('not-found-html', '/missing', 'text/html,application/xhtml+xml', 404),
  {
    name: 'api-post-json',
    kind: 'request',
    files,
    request: {
      path: '/api/echo',
      method: 'POST',
      headers: {
        ...BROWSER,
        accept: 'application/json',
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: POST_JSON,
    },
    expectStatus: 200,
    drivers: ['fetch', 'listener'],
    baseline: 'hono',
  },
];
