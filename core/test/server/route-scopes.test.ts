/**
 * Extension request scopes wrap every framework route kind: pages, API routes
 * (ahead of `authorize`), the server-components transport, and extension hook
 * routes, once per request and in registration order. Unclaimed requests and
 * hook `app.use` middleware stay outside them.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it, type TestContext } from 'node:test';

import type { Session } from '../../src/contracts/http.js';
import { currentTenantId, runWithTenant } from '../../src/database/tenant-context.js';
import {
  runExtensions,
  type JsailsExtension,
  type RequestScope,
} from '../../src/extensions/index.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { createApp, type AppOptions } from '../../src/server/app.js';
import { RequestScopeError } from '../../src/server/route-scopes.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';
import {
  COMPONENT_DOWNLOAD_ENDPOINT,
  COMPONENT_UPDATE_ENDPOINT,
  COMPONENT_UPLOAD_ENDPOINT,
} from '../../src/server-components/protocol.js';
import type { ServerComponentsRuntime } from '../../src/server-components/runtime/index.js';
import { createTestSession } from '../../src/testing/index.js';
import { writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(distDir, 'route-scopes-'));
after(() => rmSync(root, { recursive: true, force: true }));
const tenantContextUrl = pathToFileURL(join(distDir, 'src', 'database', 'tenant-context.js')).href;
writeFixture(
  root,
  'api/probe.mjs',
  `import { currentTenantId } from ${JSON.stringify(tenantContextUrl)};
export const GET = () => Response.json({ tenant: currentTenantId() ?? null });
`,
);
const manifest = discoverRoutes(root);

/** A component runtime stand-in that reports the ambient tenant from each transport route. */
const probeRuntime = {
  update: () => ({ status: 200, body: { tenant: currentTenantId() ?? null } }),
  handleUpload: () => ({ status: 200, body: { tenant: currentTenantId() ?? null } }),
  handleDownload: () => ({ status: 200, body: { tenant: currentTenantId() ?? null } }),
} as unknown as ServerComponentsRuntime;

const tenantFromHeader: RequestScope = async (c, next) => {
  const named = c.req.header('x-tenant');
  // The server settles the session before any scope runs.
  if (named === undefined || c.var.session === null) {
    await next();
    return;
  }
  await runWithTenant(named, next);
};

interface Harness {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly authorizeSaw: (string | number | null)[];
}

async function harness(
  scopes: readonly JsailsExtension[],
  overrides: Partial<AppOptions> = {},
): Promise<Harness> {
  const runtime = await runExtensions([
    {
      name: 'components',
      setup: ({ services }) => services.provide(serverComponentsToken, probeRuntime),
    },
    ...scopes,
    {
      name: 'hooks',
      setup: ({ configureHttp }) =>
        configureHttp((app) => {
          app.use('/hook/*', async (c, next) => {
            c.header('x-use-tenant', String(currentTenantId() ?? 'none'));
            await next();
          });
          app.get('/hook/probe', (c) => c.json({ tenant: currentTenantId() ?? null }));
        }),
    },
  ]);
  const authorizeSaw: (string | number | null)[] = [];
  const session: Session = createTestSession({ data: { userId: 'u1' } });
  const app = await createApp({
    manifest,
    services: runtime.services,
    httpHooks: runtime.httpHooks,
    requestScopes: runtime.requestScopes,
    resolveSession: (request) => (request.headers.has('x-anonymous') ? null : session),
    authorize: () => {
      authorizeSaw.push(currentTenantId() ?? null);
      return true;
    },
    renderPage: () =>
      new Response(String(currentTenantId() ?? 'none'), {
        headers: { 'content-type': 'text/plain' },
      }),
    ...overrides,
  });
  return {
    authorizeSaw,
    fetch: (path, init) => Promise.resolve(app.fetch(new Request(`http://localhost${path}`, init))),
  };
}

const scopeExtension = (scope: RequestScope, name = 'scope'): JsailsExtension => ({
  name,
  setup: ({ configureRequestScope }) => configureRequestScope(scope),
});

async function tenantOf(response: Response): Promise<unknown> {
  assert.equal(response.status, 200);
  return ((await response.json()) as { tenant: unknown }).tenant;
}

describe('request scopes', () => {
  it('wrap the API route, its authorize gate, the component transport, and hook routes', async () => {
    const { fetch, authorizeSaw } = await harness([scopeExtension(tenantFromHeader)]);
    const headers = { 'x-tenant': 'acme' };

    assert.equal(await tenantOf(await fetch('/api/probe', { headers })), 'acme');
    assert.deepEqual(authorizeSaw, ['acme']);
    assert.equal(await tenantOf(await fetch('/hook/probe', { headers })), 'acme');
    const json = { ...headers, 'content-type': 'application/json' };
    for (const path of [COMPONENT_UPDATE_ENDPOINT, COMPONENT_UPLOAD_ENDPOINT]) {
      assert.equal(
        await tenantOf(await fetch(path, { method: 'POST', headers: json, body: '{}' })),
        'acme',
        path,
      );
    }
    assert.equal(await tenantOf(await fetch(COMPONENT_DOWNLOAD_ENDPOINT, { headers })), 'acme');
  });

  it('wrap page routes', async (t: TestContext) => {
    const pageRoot = mkdtempSync(join(distDir, 'route-scopes-page-'));
    t.after(() => rmSync(pageRoot, { recursive: true, force: true }));
    writeFixture(pageRoot, 'pages/index.mjs', 'export default () => null;\n');
    const { fetch } = await harness([scopeExtension(tenantFromHeader)], {
      manifest: discoverRoutes(pageRoot),
    });
    const response = await fetch('/', { headers: { 'x-tenant': 'acme' } });
    assert.equal(await response.text(), 'acme');
  });

  it('leave the tenant unset when the scope does not grant one', async () => {
    const { fetch } = await harness([scopeExtension(tenantFromHeader)]);
    const headers = { 'x-tenant': 'acme', 'x-anonymous': '1' };
    assert.equal(await tenantOf(await fetch('/api/probe', { headers })), null);
    assert.equal(await tenantOf(await fetch('/hook/probe', { headers })), null);
    assert.equal(await tenantOf(await fetch(COMPONENT_DOWNLOAD_ENDPOINT, { headers })), null);
  });

  it('leave hook app.use middleware and unclaimed requests outside the scope', async () => {
    let runs = 0;
    const counting: RequestScope = async (c, next) => {
      runs += 1;
      await tenantFromHeader(c, next);
    };
    const { fetch } = await harness([scopeExtension(counting)]);
    const response = await fetch('/hook/probe', { headers: { 'x-tenant': 'acme' } });
    assert.equal(response.headers.get('x-use-tenant'), 'none');
    assert.equal(runs, 1);
    assert.equal((await fetch('/nowhere')).status, 404);
    assert.equal(runs, 1);
  });

  it('run once per request, nested in registration order', async () => {
    const order: string[] = [];
    const named =
      (name: string): RequestScope =>
      async (_c, next) => {
        order.push(`${name}:in`);
        await next();
        order.push(`${name}:out`);
      };
    const { fetch } = await harness([
      scopeExtension(named('first'), 'first'),
      scopeExtension(named('second'), 'second'),
    ]);
    assert.equal((await fetch('/api/probe')).status, 200);
    assert.deepEqual(order, ['first:in', 'second:in', 'second:out', 'first:out']);
  });

  it('fail the request when a scope skips or repeats next()', async () => {
    const errors: unknown[] = [];
    const onError = (error: unknown): void => {
      errors.push(error);
    };
    const skipping = await harness([scopeExtension(async () => {})], { onError });
    assert.equal((await skipping.fetch('/hook/probe')).status, 500);
    assert.equal((await skipping.fetch('/api/probe')).status, 500);
    const repeating = await harness(
      [
        scopeExtension(async (_c, next) => {
          await next();
          await next();
        }),
      ],
      { onError },
    );
    assert.equal((await repeating.fetch('/hook/probe')).status, 500);
    assert.deepEqual(
      errors.map((error) => (error as RequestScopeError).code),
      ['missing_next', 'missing_next', 'invalid_next'],
    );
  });

  it('are validated by createApp and only registrable during setup', async () => {
    await assert.rejects(
      createApp({ manifest, requestScopes: 'nope' as never }),
      /requestScopes must be an array of functions/,
    );
    await assert.rejects(
      createApp({ manifest, requestScopes: [42] as never }),
      /requestScopes entries must be functions/,
    );
    await assert.rejects(
      runExtensions([
        { name: 'bad', setup: ({ configureRequestScope }) => configureRequestScope(1 as never) },
      ]),
      /request scope must be a function/,
    );
    let leaked: ((scope: RequestScope) => void) | undefined;
    const runtime = await runExtensions([
      {
        name: 'leaky',
        setup: ({ configureRequestScope }) => {
          leaked = configureRequestScope;
        },
      },
    ]);
    assert.deepEqual(runtime.requestScopes, []);
    assert.throws(() => leaked?.(async (_c, next) => next()), { code: 'sealed' });
  });
});
