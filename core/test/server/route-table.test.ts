/**
 * The route table's registration rules: one route per method and pattern,
 * a mount's subtree, the reserved paths and the `/_jsails` namespace, the
 * plugin-origin rule, and the methods a path answers for
 * the 405.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publicAccess } from '../../src/api/access-ref.js';
import { RouteErrors, type RouteMeta } from '../../src/server/route-meta.js';
import { createRouteTable, type PluginOrigins } from '../../src/server/route-table.js';

const OPEN = publicAccess('test route');

function meta(overrides: Partial<RouteMeta> = {}): RouteMeta {
  return {
    kind: 'api',
    pattern: '/reports',
    methods: ['GET'],
    access: OPEN,
    credentials: ['cookie'],
    surface: 'route',
    owner: 'app',
    origin: 'app',
    ...overrides,
  };
}

function table(pluginOrigins: PluginOrigins = 'code-only') {
  return createRouteTable({
    reservedPaths: new Set(['/up', '/_jsails/introspect']),
    pluginOrigins,
  });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    assert.ok(RouteErrors.is(error), 'a registration failure is a route error');
    return error.code;
  }
  return undefined;
}

describe('route table', () => {
  it('lists every route in registration order, frozen', () => {
    const routes = table();
    routes.record(meta());
    routes.record(meta({ pattern: '/reports/:id', methods: ['GET', 'DELETE'] }));
    const entries = routes.entries();
    assert.deepEqual(
      entries.map((entry) => `${entry.methods.join(',')} ${entry.pattern}`),
      ['GET /reports', 'GET,DELETE /reports/:id'],
    );
    assert.ok(Object.isFrozen(entries[0]));
    assert.ok(Object.isFrozen(entries[0]?.methods));
  });

  it('refuses the same method and pattern twice, whoever registers it', () => {
    const routes = table();
    routes.record(meta({ methods: ['GET', 'POST'] }));
    assert.equal(
      codeOf(() =>
        routes.record(meta({ methods: ['POST'], owner: 'acme', origin: 'code-plugin' })),
      ),
      'route.duplicate_route',
    );
    // Another method on the same pattern is a different route.
    routes.record(meta({ methods: ['PUT'] }));
  });

  it('reserves the framework paths for the framework', () => {
    const routes = table();
    assert.equal(
      codeOf(() => routes.record(meta({ pattern: '/up' }))),
      'route.reserved_path',
    );
    assert.equal(
      codeOf(() =>
        routes.record(
          meta({ pattern: '/_jsails/introspect', owner: 'acme', origin: 'code-plugin' }),
        ),
      ),
      'route.reserved_path',
    );
    routes.record(
      meta({ kind: 'framework', pattern: '/up', owner: 'framework', origin: 'framework' }),
    );
  });

  it('keeps the /_jsails namespace for the framework and code plugins', () => {
    const routes = table('allow-managed');
    assert.equal(
      codeOf(() => routes.record(meta({ pattern: '/_jsails/mine' }))),
      'route.reserved_path',
    );
    assert.equal(
      codeOf(() =>
        routes.record(meta({ pattern: '/_jsails/mine', owner: 'shop', origin: 'managed-plugin' })),
      ),
      'route.reserved_path',
    );
    routes.record(meta({ pattern: '/_jsails/dev/reload', owner: 'dev', origin: 'code-plugin' }));
  });

  it('refuses a mount that covers a reserved path', () => {
    const routes = table();
    const mount = (pattern: string) =>
      meta({ kind: 'mount', pattern, owner: 'acme', origin: 'code-plugin' });
    assert.equal(
      codeOf(() => routes.record(mount('/_jsails'))),
      'route.reserved_path',
    );
    assert.equal(
      codeOf(() => routes.record(mount('/'))),
      'route.reserved_path',
    );
    routes.record(mount('/acme'));
  });

  it('refuses a route under a mount, whichever is recorded first', () => {
    const mount = meta({ kind: 'mount', pattern: '/api', owner: 'auth', origin: 'code-plugin' });
    const orders = meta({ pattern: '/api/orders', owner: 'shop', origin: 'code-plugin' });
    const mountFirst = table();
    mountFirst.record(mount);
    assert.equal(
      codeOf(() => mountFirst.record(orders)),
      'route.mount_overlap',
    );
    assert.equal(
      codeOf(() => mountFirst.record(meta({ pattern: '/api/:id' }))),
      'route.mount_overlap',
    );
    assert.equal(
      codeOf(() => mountFirst.record(meta({ pattern: '/api' }))),
      'route.mount_overlap',
    );
    const routeFirst = table();
    routeFirst.record(orders);
    assert.equal(
      codeOf(() => routeFirst.record(mount)),
      'route.mount_overlap',
    );
  });

  it('refuses a mount at, above or under another mount', () => {
    const mount = (pattern: string) =>
      meta({ kind: 'mount', pattern, owner: 'acme', origin: 'code-plugin' });
    const routes = table();
    routes.record(mount('/api/auth'));
    assert.equal(
      codeOf(() => routes.record(mount('/api/auth'))),
      'route.mount_overlap',
    );
    assert.equal(
      codeOf(() => routes.record(mount('/api'))),
      'route.mount_overlap',
    );
    assert.equal(
      codeOf(() => routes.record(mount('/api/auth/admin'))),
      'route.mount_overlap',
    );
    routes.record(mount('/api/authz'));
  });

  it('accepts a fallback pattern beside a mount and a route beside its prefix', () => {
    const routes = table();
    routes.record(meta({ kind: 'mount', pattern: '/api', owner: 'auth', origin: 'code-plugin' }));
    routes.record(meta({ pattern: '/:slug{.+}' }));
    routes.record(meta({ pattern: '/:section/orders' }));
    routes.record(meta({ pattern: '/apis' }));
    routes.record(meta({ pattern: '/' }));
    assert.equal(routes.entries().length, 5);
  });

  it('refuses a mount whose prefix has a parameter or wildcard', () => {
    const routes = table();
    for (const pattern of ['/:tenant', '/files/*']) {
      assert.equal(
        codeOf(() =>
          routes.record(meta({ kind: 'mount', pattern, owner: 'acme', origin: 'code-plugin' })),
        ),
        'route.invalid_path',
      );
    }
  });

  it("refuses a managed plugin's route under code-only origins", () => {
    const managed = meta({ pattern: '/shop', owner: 'shop', origin: 'managed-plugin' });
    assert.equal(
      codeOf(() => table('code-only').record(managed)),
      'route.managed_origin_refused',
    );
    table('allow-managed').record(managed);
  });

  it('answers the methods a path has, GET implying HEAD, mounts left out', () => {
    const routes = table();
    routes.record(meta({ pattern: '/reports/:id', methods: ['GET', 'DELETE'] }));
    routes.record(meta({ pattern: '/reports/:id', methods: ['PUT'] }));
    routes.record(meta({ kind: 'mount', pattern: '/files', owner: 'acme', origin: 'code-plugin' }));
    assert.deepEqual(routes.allowedMethods('/reports/7'), ['DELETE', 'GET', 'HEAD', 'PUT']);
    assert.deepEqual(routes.allowedMethods('/files'), []);
    assert.deepEqual(routes.allowedMethods('/nowhere'), []);
    // A later registration is seen by the next lookup.
    routes.record(meta({ pattern: '/nowhere', methods: ['POST'] }));
    assert.deepEqual(routes.allowedMethods('/nowhere'), ['POST']);
  });

  it('keeps registration failures value-free', () => {
    const routes = table();
    routes.record(meta({ pattern: '/secret-token-abc123' }));
    try {
      routes.record(meta({ pattern: '/secret-token-abc123', owner: 'name with spaces' }));
      assert.fail('expected a duplicate');
    } catch (error) {
      assert.ok(RouteErrors.is(error, 'duplicate_route'));
      assert.doesNotMatch(error.message, /name with spaces/);
    }
  });
});
