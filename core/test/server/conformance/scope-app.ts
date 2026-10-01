/**
 * The conformance app for the scope matrix: one app with a tenant request
 * scope, a negotiated locale (the real i18n plugin), a session resolver,
 * services, the structured page renderer, registrar routes, mounts (an upload
 * handler and two Hono apps, one routed under its prefix, one with that prefix
 * as its `basePath`) and the server-components transport. Every observation point calls
 * `observe` from `scope-probe.ts`.
 *
 * The fixture tree lives in a directory named `app#2 %41`: a `#`, a space and
 * a percent escape break any loader that builds module URLs by string
 * concatenation instead of `pathToFileURL`.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Hono } from 'hono';

import { publicAccess } from '../../../src/api/access-ref.js';
import { Respond } from '../../../src/api/responses.js';
import type { Session } from '../../../src/contracts/http.js';
import { runWithTenant } from '../../../src/database/tenant-context.js';
import { runExtensions } from '../../../src/extensions/index.js';
import { i18nPlugin } from '../../../src/i18n/plugin.js';
import { preactPageRenderer } from '../../../src/pages/page.js';
import { discoverRoutes } from '../../../src/routing/routes.js';
import { createApp } from '../../../src/server/app.js';
import { currentRequestFrame, identitySource } from '../../../src/server/request-frame.js';
import type { AppEnv } from '../../../src/server/env.js';
import { serverComponentsToken } from '../../../src/server-components/extension.js';
import type { ServerComponentsRuntime } from '../../../src/server-components/runtime/index.js';
import { createTestSession } from '../../../src/testing/index.js';
import { writeFixture } from '../../fixtures/app.js';
import { counters, observe, probeServiceToken } from './scope-probe.js';

/** The tenant, locale and session every scope-matrix request carries. */
export const EXPECTED = Object.freeze({
  tenant: 'acme',
  locale: 'fr',
  session: 's1',
});

/** Request-body cap of the conformance app, so a 413 is cheap to provoke. */
export const MAX_BODY_BYTES = 1024;

const distDir = fileURLToPath(new URL('../../../', import.meta.url));
const probeUrl = new URL('./scope-probe.js', import.meta.url).href;

/** A fixture module that imports the probe. */
function probeModule(body: string): string {
  return `import { counters, observe } from ${JSON.stringify(probeUrl)};\n${body}`;
}

const tick = 'await new Promise((resolve) => setTimeout(resolve, 2));';

/** Write the conformance route tree under `root`. */
function writeRoutes(root: string): void {
  writeFixture(
    root,
    'api/probe.mjs',
    probeModule(`export const authorize = (context) => {
  observe('api.module-authorize', context);
  return true;
};
export const GET = (_request, context) => {
  observe('api.handler', context);
  return Response.json({ ok: true });
};
`),
  );
  writeFixture(
    root,
    'pages/layout.mjs',
    probeModule(`export default ({ children }, context) => {
  observe('layout', context);
  return children;
};
`),
  );
  writeFixture(
    root,
    'pages/probe/index.mjs',
    probeModule(`export const load = (context) => {
  counters.loads += 1;
  observe('page.load', context);
  return {};
};
export default (_props, context) => {
  counters.renders += 1;
  observe('page.render', context);
  return 'probe';
};
`),
  );
  writeFixture(
    root,
    'pages/boom/index.mjs',
    probeModule(`export const load = () => {
  throw new Error('boom');
};
export default () => 'never';
`),
  );
  writeFixture(
    root,
    'pages/boom/error.mjs',
    probeModule(`export default (_props, context) => {
  observe('error-boundary', context);
  return 'boundary';
};
`),
  );
  writeFixture(
    root,
    'pages/fail/index.mjs',
    probeModule(`export const load = () => {
  throw new Error('page failed');
};
export default () => 'never';
`),
  );
  writeFixture(
    root,
    'pages/docs/index.mjs',
    probeModule(`export default () => 'docs';
`),
  );
  writeFixture(
    root,
    'pages/docs/not-found.mjs',
    probeModule(`export default (_props, context) => {
  observe('not-found-page', context);
  return 'not found';
};
`),
  );
  writeFixture(
    root,
    'pages/stream/index.mjs',
    probeModule(`export const stream = async function* (context) {
  for (let chunk = 1; chunk <= 3; chunk += 1) {
    ${tick}
    observe('stream.chunk' + chunk, context);
    yield '<p>' + chunk + '</p>';
  }
};
export default () => 'unused';
`),
  );
  writeFixture(
    root,
    'pages/endless/index.mjs',
    probeModule(`export const stream = async function* (context) {
  try {
    for (let chunk = 1; ; chunk += 1) {
      ${tick}
      yield '<p>' + chunk + '</p>';
    }
  } finally {
    observe('stream.finally', context);
  }
};
export default () => 'unused';
`),
  );
  writeFixture(
    root,
    'pages/late/index.mjs',
    probeModule(`export const stream = async function* () {
  yield '<p>first</p>';
  ${tick}
  throw new Error('late failure');
};
export default () => 'unused';
`),
  );
}

/** The component runtime stand-in: observes the update route. */
const probeRuntime = {
  routes: {
    update: async (_request: Request, context: { readonly session: Session | null }) => {
      observe('component.update', context);
      return Response.json({});
    },
    upload: async () => Response.json({}),
    download: async () => Response.json({}),
    uploadBodyBytes: 1024 * 1024,
    laneTotalMs: { update: 30_000, upload: 300_000, download: 600_000 },
  },
} as unknown as ServerComponentsRuntime;

/** The conformance app and the directory holding its fixtures. */
export interface ScopeApp {
  readonly app: Hono<AppEnv>;
  readonly root: string;
  close(): void;
}

/** Build the scope-matrix conformance app. */
export async function createScopeApp(): Promise<ScopeApp> {
  const base = mkdtempSync(join(distDir, 'conformance-'));
  const root = join(base, 'app#2 %41');
  mkdirSync(root, { recursive: true });
  writeRoutes(root);
  const manifest = discoverRoutes(root);
  const session = createTestSession({ id: EXPECTED.session });

  const runtime = await runExtensions(
    [
      i18nPlugin({
        locale: 'en',
        catalogs: { en: { hello: 'Hello' }, fr: { hello: 'Bonjour' } },
        // The negotiated locale: the request's own Accept-Language, matched
        // against the served catalogs by the plugin.
        resolveLocale: (request) => request.headers.get('accept-language') ?? undefined,
      }),
      {
        name: 'conformance-services',
        setup: ({ services }) => {
          services.provide(probeServiceToken, { name: 'probe' });
          services.provide(serverComponentsToken, probeRuntime);
        },
      },
      {
        name: 'conformance-tenant',
        setup: ({ configureRequestScope }) =>
          configureRequestScope({
            name: 'conformance-tenant',
            cache: 'partition',
            resolve: ({ request }) => {
              counters.scopes += 1;
              const tenant = request.headers.get('x-tenant');
              if (tenant === null) return undefined;
              return {
                run: (fn) => runWithTenant(tenant, fn),
                partition: { name: 'tenant', value: tenant, from: 'header' },
              };
            },
          }),
      },
      {
        name: 'conformance-registrar',
        setup: ({ routes }) => {
          const access = publicAccess('scope-matrix observation point');
          routes.add({
            methods: ['GET'],
            path: '/registrar/probe',
            access,
            handler: (context) => {
              observe('registrar.route', context);
              return Respond.json({ ok: true });
            },
          });
          // Reads its body under the app-wide cap, so an oversized one is a
          // 413, answered to a browser with the app's error page.
          routes.mount(
            '/upload',
            async (request) => {
              await request.arrayBuffer();
              return Respond.json({ ok: true });
            },
            { access },
          );
          /** Observe `point` with the ambient frame's context, as a mounted app reaches it. */
          const observeMounted = (point: string): Response => {
            observe(point, currentRequestFrame()?.requestContext());
            return Response.json({ ok: true });
          };
          const routed = new Hono();
          routed.route(
            '/sub',
            new Hono().get('/probe', () => observeMounted('registrar.mount')),
          );
          routes.mount('/sub', routed.fetch, { access });
          const based = new Hono()
            .basePath('/based')
            .get('/probe', () => observeMounted('registrar.base-path'));
          routes.mount('/based', based.fetch, { access });
        },
      },
    ],
    { rootDir: import.meta.dirname },
  );

  const app = await createApp({
    manifest,
    services: runtime.services,
    contributions: { routes: runtime.routes, transforms: runtime.transforms },
    requestScopes: runtime.requestScopes,
    renderer: preactPageRenderer,
    maxBodyBytes: MAX_BODY_BYTES,
    // The session cookie is declared, so a request without it never resolves.
    identity: identitySource({
      cookies: ['sid'],
      resolve: (request) => {
        counters.sessions += 1;
        return /(?:^|;\s*)sid=s1(?:;|$)/.test(request.headers.get('cookie') ?? '') ? session : null;
      },
    }),
    errorPage: (error, context) => {
      counters.errorPages += 1;
      observe(`error-page.${error.status}`, context);
      return `<p>${error.status}</p>`;
    },
    onError: (error, info) => {
      observe('error-hook', undefined, {
        message: error instanceof Error ? error.message : String(error),
        route: info.route,
        requestId: info.requestId,
        phase: info.phase,
      });
    },
  });
  return { app, root, close: () => rmSync(base, { recursive: true, force: true }) };
}
