/**
 * Request scenarios: one small app, each request measured through both
 * drivers (`Application.fetch` and the real request listener). They cover the
 * shapes the request kernel work changes first: a small JSON API response, a
 * small server-rendered page, a static file, and a JSON 404. Every request
 * carries a browser's `Accept-Encoding`, so compression decisions are on the
 * measured path.
 */

import { ORIGIN } from '../app.mjs';

// `serve` outside development requires `server.origin` and answers any other
// Host 421; the drivers address every request to ORIGIN.
const APP_CONFIG = `export default {
  host: '127.0.0.1',
  port: 0,
  server: { origin: '${ORIGIN}' },
  authorize: () => true,
};
`;

const BROWSER = { 'accept-encoding': 'gzip, deflate, br, zstd' };

const files = {
  'jsails.app.js': APP_CONFIG,
  'api/hello.js': 'export function GET() {\n  return Response.json({ ok: true });\n}\n',
  'pages/index.js': "export default function Home() {\n  return 'hello';\n}\n",
  'public/robots.txt': 'User-agent: *\n',
};

const request = (name, path, accept, expectStatus = 200) => ({
  name,
  kind: 'request',
  files,
  request: { path, headers: { ...BROWSER, accept } },
  expectStatus,
  drivers: ['fetch', 'listener'],
});

export const scenarios = [
  request('api-small-json', '/api/hello', 'application/json'),
  request('page-small', '/', 'text/html'),
  request('static-small', '/robots.txt', 'text/plain'),
  request('not-found-json', '/missing', 'application/json', 404),
];
