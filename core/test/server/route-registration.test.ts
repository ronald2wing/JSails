/**
 * The registration snapshot: an app with every core route kind (health,
 * readiness, introspection, registrar routes in and out of the `/_jsails`
 * namespace and a registrar mount, the component transport, filesystem API routes in both shapes,
 * filesystem pages with and without `definePage`, the public files) lists,
 * in registration order (the precedence order assembly compiles in), each
 * route's kind and surface kind, methods, pattern, access, credentials,
 * owner and origin, and the surface registry holds one descriptor per route
 * plus the public files. A change to any core route kind changes this list;
 * review it line by line. Every
 * first-party plugin's routes are pinned by the `route-registration` gate
 * (`api/routes.md`).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { publicAccess } from '../../src/api/access-ref.js';
import { createAssetIndex } from '../../src/assets/asset-index.js';
import { runExtensions } from '../../src/extensions/extension.js';
import { preactPageRenderer } from '../../src/pages/page.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';
import type { ServerComponentsRuntime } from '../../src/server-components/runtime/index.js';
import { surfacesOf } from '../../src/security/surfaces.js';
import { createApp, routeTableOf } from '../../src/server/app.js';
import type { RouteMeta } from '../../src/server/route-meta.js';
import { writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const API_URL = JSON.stringify(pathToFileURL(join(distDir, 'src/api/index.js')).href);
const root = mkdtempSync(join(distDir, 'route-registration-'));
after(() => rmSync(root, { recursive: true, force: true }));

writeFixture(
  root,
  'api/users.mjs',
  `export const GET = () => Response.json([]);
export const POST = () => Response.json({});
export const authorize = ({ session }) => session !== null;
`,
);
writeFixture(
  root,
  'api/posts/[id].mjs',
  `import { defineApi, publicAccess } from ${API_URL};
export default defineApi('/api/posts/:id', {
  access: publicAccess('published posts are public'),
  credentials: [],
  GET: ({ params }) => Response.json({ id: params.id }),
});\n`,
);
writeFixture(root, 'pages/index.mjs', `export default () => 'home';\n`);
writeFixture(
  root,
  'pages/account.mjs',
  `import { definePage } from ${API_URL};
export const route = definePage('/account', { access: ({ session }) => session !== null });
export default () => 'account';\n`,
);

const answer = () => new Response('ok');
const components = {
  routes: {
    update: answer,
    upload: answer,
    download: answer,
    uploadBodyBytes: 1024 * 1024,
    laneTotalMs: { update: 30_000, upload: 300_000, download: 600_000 },
  },
} as unknown as ServerComponentsRuntime;

function line(meta: RouteMeta): string {
  const access =
    meta.access.reason === '' ? meta.access.kind : `${meta.access.kind}(${meta.access.reason})`;
  let limits = '';
  if (meta.body !== undefined) {
    limits += ` body=${meta.body.kind}${meta.body.kind === 'none' ? '' : `:${meta.body.maxBytes}`}`;
  }
  if (meta.timeoutMs !== undefined) limits += ` timeout=${meta.timeoutMs}`;
  if (meta.stream !== undefined) limits += ` stream-idle=${meta.stream.timeoutMs}`;
  const credentials = meta.credentials.length === 0 ? 'none' : meta.credentials.join('+');
  return `${meta.kind}/${meta.surface} ${meta.methods.join(',')} ${meta.pattern} ${access} credentials=${credentials}${limits} ${meta.owner}/${meta.origin}`;
}

describe('route registration snapshot', () => {
  it('lists every registered route with its access, credentials and owner', async () => {
    const runtime = await runExtensions(
      [
        {
          name: 'components',
          setup: ({ services }) => services.provide(serverComponentsToken, components),
        },
        {
          name: 'acme',
          setup: ({ routes }) => {
            routes.add({
              methods: ['POST'],
              path: '/_jsails/acme/import',
              access: publicAccess('a signed import; the handler verifies the signature'),
              credentials: ['token'],
              body: { kind: 'raw', maxBytes: 8192 },
              timeoutMs: 120_000,
              handler: answer,
            });
            routes.add({
              methods: ['GET', 'POST'],
              path: '/acme/reports',
              access: ({ session }) => session !== null,
              body: { kind: 'json', maxBytes: 4096 },
              timeoutMs: 5000,
              handler: answer,
            });
            routes.mount('/acme/app', answer, { access: publicAccess('the mounted app checks') });
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );
    const app = await createApp({
      manifest: discoverRoutes(root),
      renderer: preactPageRenderer,
      services: runtime.services,
      contributions: { routes: runtime.routes, transforms: runtime.transforms },
      healthPath: '/up',
      readiness: { path: '/ready', probes: {} },
      introspect: { enabled: true, authorize: () => false, sections: [], providers: [] },
      assets: await createAssetIndex({ roots: [] }),
    });
    const table = routeTableOf(app);
    assert.ok(table !== undefined);
    assert.deepEqual(table.entries().map(line), [
      'framework/ops GET,HEAD /up public(health probe; the readiness detail has its own authorize) credentials=none framework/framework',
      'framework/ops GET,HEAD /ready public(health probe; the readiness detail has its own authorize) credentials=none framework/framework',
      'framework/ops GET /_jsails/introspect legacy credentials=cookie framework/framework',
      'component/component-action POST /_jsails/components/update public(the component lane verifies every request) credentials=cookie timeout=60000 framework/framework',
      'component/upload POST /_jsails/components/upload public(the component lane verifies every request) credentials=cookie body=raw:1048576 timeout=330000 framework/framework',
      'component/download GET /_jsails/components/download public(the component lane verifies every request) credentials=cookie timeout=630000 framework/framework',
      'mount/route GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD /acme/app public(the mounted app checks) credentials=cookie acme/code-plugin',
      'api/route POST /_jsails/acme/import public(a signed import; the handler verifies the signature) credentials=token body=raw:8192 timeout=120000 acme/code-plugin',
      'api/route GET,POST /acme/reports legacy credentials=cookie body=json:4096 timeout=5000 acme/code-plugin',
      'page/page GET / public(public page; its loader decides) credentials=cookie app/app',
      'page/page GET /account legacy credentials=cookie app/app',
      'api/api GET /api/posts/:id public(published posts are public) credentials=none app/app',
      'api/api GET,POST /api/users legacy credentials=cookie+token app/app',
    ]);
    const surfaces = surfacesOf(app);
    assert.ok(surfaces !== undefined);
    assert.deepEqual(
      surfaces
        .entries()
        .map(
          (d) =>
            `${d.id} ${d.kind} ${d.action} ${d.access.kind} ${d.credentials.join('+') || 'none'} ${d.owner}`,
        ),
      [
        'asset:public asset read public none framework',
        'GET,HEAD /up ops read public none framework',
        'GET,HEAD /ready ops read public none framework',
        'GET /_jsails/introspect ops read legacy cookie framework',
        'POST /_jsails/components/update component-action write public cookie framework',
        'POST /_jsails/components/upload upload write public cookie framework',
        'GET /_jsails/components/download download read public cookie framework',
        'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD /acme/app route write public cookie acme',
        'POST /_jsails/acme/import route write public token acme',
        'GET,POST /acme/reports route write legacy cookie acme',
        'GET / page read public cookie app',
        'GET /account page read legacy cookie app',
        'GET /api/posts/:id api read public none app',
        'GET,POST /api/users api write legacy cookie+token app',
      ],
    );
    await runtime.close();
  });
});
