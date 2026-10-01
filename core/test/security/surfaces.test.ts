/**
 * The surface registry (`security/surfaces.ts`): a descriptor without a valid
 * access reference, one registered twice and a malformed one fail assembly
 * value-free; a registered descriptor is frozen; an assembled app's surfaces
 * are readable through `surfacesOf` and only through it. A registrar route
 * at the method and path of a page or API module fails assembly: one surface
 * per method and path.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { publicAccess, type AccessRef } from '../../src/api/access-ref.js';
import { createAssetIndex } from '../../src/assets/asset-index.js';
import { preactPageRenderer } from '../../src/pages/page.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import {
  createSurfaceRegistry,
  publicFilesSurface,
  routeSurfaceId,
  surfaceOfRoute,
  surfacesOf,
  SurfaceErrors,
  type SurfaceDescriptor,
} from '../../src/security/surfaces.js';
import { createApp } from '../../src/server/app.js';
import { createHttpRoutes } from '../../src/server/http-routes.js';
import { RouteErrors, type RouteMeta } from '../../src/server/route-meta.js';
import { writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(distDir, 'security-surfaces-'));
after(() => rmSync(root, { recursive: true, force: true }));

const OPEN = publicAccess('surface registry test');

function descriptor(overrides: Partial<SurfaceDescriptor> = {}): SurfaceDescriptor {
  return {
    id: 'GET /posts',
    kind: 'api',
    match: { methods: ['GET'], pattern: '/posts' },
    access: OPEN,
    action: 'read',
    credentials: ['cookie', 'token'],
    owner: 'app',
    ...overrides,
  };
}

describe('createSurfaceRegistry', () => {
  it('freezes what it registers and lists it in registration order', () => {
    const registry = createSurfaceRegistry();
    const added = registry.add(descriptor());
    registry.add(descriptor({ id: 'POST /posts', action: 'write' }));
    assert.ok(Object.isFrozen(added));
    assert.ok(Object.isFrozen(added.match));
    assert.ok(Object.isFrozen(added.match.methods));
    assert.ok(Object.isFrozen(added.credentials));
    assert.deepEqual(
      registry.entries().map((entry) => entry.id),
      ['GET /posts', 'POST /posts'],
    );
    assert.equal(registry.get('GET /posts'), added);
    assert.equal(registry.get('DELETE /posts'), undefined);
  });

  it('refuses a surface without a valid access reference, value-free', () => {
    const registry = createSurfaceRegistry();
    const forged = Object.freeze({ kind: 'public', reason: 'hand-built' }) as unknown as AccessRef;
    for (const access of [undefined, forged, (() => true) as unknown]) {
      assert.throws(
        () =>
          registry.add(
            descriptor({ access: access as AccessRef, match: { methods: ['GET'], pattern: '/x' } }),
          ),
        (error: unknown) =>
          SurfaceErrors.is(error, 'missing_access') && error.context.pattern === 'x',
      );
    }
    assert.deepEqual(registry.entries(), []);
  });

  it('refuses an id registered twice', () => {
    const registry = createSurfaceRegistry();
    registry.add(descriptor());
    assert.throws(
      () => registry.add(descriptor({ owner: 'blog' })),
      (error: unknown) =>
        SurfaceErrors.is(error, 'duplicate_surface') && error.context.owner === 'blog',
    );
  });

  const malformed: readonly (readonly [string, Partial<SurfaceDescriptor>])[] = [
    ['invalid_kind', { kind: 'nonsense' as SurfaceDescriptor['kind'] }],
    ['invalid_methods', { match: { methods: [], pattern: '/posts' } }],
    ['invalid_credentials', { credentials: ['cookie', 'cookie'] }],
    ['invalid_credentials', { credentials: ['password' as 'cookie'] }],
    ['invalid_action', { action: '' }],
  ];
  for (const [problem, overrides] of malformed) {
    it(`refuses a malformed surface: ${problem} (${JSON.stringify(overrides)})`, () => {
      assert.throws(
        () => createSurfaceRegistry().add(descriptor(overrides)),
        (error: unknown) =>
          SurfaceErrors.is(error, 'invalid_surface') && error.context.problem === problem,
      );
    });
  }

  it('names an owner that is not an identifier as unnamed', () => {
    assert.throws(
      () =>
        createSurfaceRegistry().add(descriptor({ owner: '<script>', access: undefined as never })),
      (error: unknown) =>
        SurfaceErrors.is(error, 'missing_access') &&
        error.context.owner === 'unnamed' &&
        !error.message.includes('<script>'),
    );
  });
});

describe('route surfaces', () => {
  function meta(methods: RouteMeta['methods']): RouteMeta {
    return {
      kind: 'api',
      pattern: '/posts/:id',
      methods,
      access: OPEN,
      credentials: ['cookie'],
      surface: 'api',
      owner: 'app',
      origin: 'app',
    };
  }

  it('ids a route by its methods and pattern', () => {
    assert.equal(routeSurfaceId(['GET', 'POST'], '/posts/:id'), 'GET,POST /posts/:id');
  });

  it('asks the gate about reading only when every method is safe', () => {
    assert.equal(surfaceOfRoute(meta(['GET', 'HEAD', 'OPTIONS'])).action, 'read');
    assert.equal(surfaceOfRoute(meta(['GET', 'POST'])).action, 'write');
    assert.equal(surfaceOfRoute(meta(['DELETE'])).action, 'write');
  });

  it('describes the asset index as one open, credential-free GET surface', () => {
    const surface = publicFilesSurface();
    assert.equal(surface.id, 'asset:public');
    assert.equal(surface.access.kind, 'public');
    assert.deepEqual(surface.credentials, []);
    assert.deepEqual(surface.match, { methods: ['GET', 'HEAD'], pattern: '/*' });
  });
});

describe('surfacesOf', () => {
  writeFixture(
    root,
    'api/posts.mjs',
    `export const GET = () => Response.json([]);
export const POST = () => Response.json({});
export const authorize = () => true;
`,
  );

  it("lists an assembled app's surfaces, the asset index first", async () => {
    const app = await createApp({
      manifest: discoverRoutes(root),
      assets: await createAssetIndex({ roots: [] }),
    });
    const surfaces = surfacesOf(app);
    assert.ok(surfaces !== undefined);
    const posts = surfaces.get('GET,POST /api/posts');
    assert.ok(posts !== undefined);
    assert.equal(posts.kind, 'api');
    assert.equal(posts.action, 'write');
    assert.equal(posts.access.kind, 'legacy');
    assert.deepEqual(posts.credentials, ['cookie', 'token']);
    // The index answers before every route, so it is registered first.
    assert.equal(surfaces.entries()[0]?.id, 'asset:public');
  });

  describe('a registrar route at the method and path of a filesystem route', () => {
    const shadowRoot = mkdtempSync(join(distDir, 'security-surfaces-shadow-'));
    after(() => rmSync(shadowRoot, { recursive: true, force: true }));
    writeFixture(shadowRoot, 'pages/blog/index.mjs', "export default () => 'page';\n");
    writeFixture(
      shadowRoot,
      'api/foo.mjs',
      `export const GET = () => Response.json({ from: 'api' });
export const authorize = () => true;
`,
    );

    it('fails assembly, so no route answers in place of another unseen', async () => {
      for (const path of ['/blog', '/api/foo']) {
        const { routes, contributions } = createHttpRoutes({
          owner: 'acme',
          origin: 'code-plugin',
          allow: { mount: false, guard: false, transform: false },
        });
        routes.add({
          methods: ['GET'],
          path,
          access: publicAccess('shadow probe'),
          handler: () => Response.json({ from: 'registrar' }),
        });
        await assert.rejects(
          createApp({
            manifest: discoverRoutes(shadowRoot),
            renderer: preactPageRenderer,
            contributions: contributions(),
          }),
          (error: unknown) =>
            error instanceof RouteErrors.Error && error.code === 'route.duplicate_route',
          path,
        );
      }
    });
  });

  it('reads nothing from an object createApp did not build', () => {
    assert.equal(surfacesOf({}), undefined);
  });
});
