/**
 * Startup scenarios. `assemble-<n>-routes` builds an app of `n` API routes
 * and one page the way `jsails serve` does (config load, `createApplication`,
 * `serve()`), then sends the first request through the real listener; the
 * exact counters of both steps are budgeted, so an eager import or a file
 * read moved onto the first request is caught. `cli-help` times
 * `jsails --help` against a bare `node -e 0` in the same run (timing mode
 * only; its module count is the import-graph gate's).
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

function routes(count) {
  const files = {
    'jsails.app.js': APP_CONFIG,
    'pages/index.js': "export default function Home() {\n  return 'hello';\n}\n",
  };
  for (let index = 0; index < count; index += 1) {
    files[`api/r${index}.js`] =
      'export const authorize = () => true;\n' +
      `export function GET() {\n  return Response.json({ route: ${index} });\n}\n`;
  }
  return files;
}

const assembly = (count) => ({
  name: `assemble-${count}-routes`,
  kind: 'assembly',
  files: routes(count),
  request: { path: '/api/r0', headers: { accept: 'application/json' } },
  expectStatus: 200,
});

export const scenarios = [
  assembly(5),
  assembly(200),
  { name: 'cli-help', kind: 'process', argv: ['--help'] },
];
