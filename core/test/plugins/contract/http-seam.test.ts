/**
 * The plugin HTTP seam on the `definePlugin` contract: setup receives the
 * registrar (`routes.add`, `mount`, `guard`, `transform`) and nothing that
 * reaches Hono. The type fixtures are compile-time proofs: a plugin calling a
 * removed Hono verb (`routes.use`, `routes.get`, `routes.route`,
 * `routes.basePath`) or asking for `configureHttp` does not compile, so each
 * `@ts-expect-error` below fails the build the day the seam grows one back.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publicAccess } from '../../../src/api/access-ref.js';
import { definePlugin } from '../../../src/plugins/contract/define-plugin.js';
import type { PluginSetupContext } from '../../../src/plugins/contract/instance.js';
import { testPlugin } from '../../../src/testing/plugin-harness.js';

describe('definePlugin: the HTTP seam', () => {
  it('hands setup the registrar and no Hono verb or configureHttp', async () => {
    let seen: PluginSetupContext | undefined;
    const factory = definePlugin({
      name: 'seam-probe',
      setup(context) {
        seen = context;
        context.routes.add({
          methods: ['GET'],
          path: '/seam-probe',
          access: publicAccess('seam fixture'),
          handler: () => new Response('ok'),
        });
      },
    });
    const run = await testPlugin(factory());
    await run.close();

    assert.ok(seen !== undefined);
    assert.equal('configureHttp' in seen, false);
    assert.deepEqual(Object.keys(seen.routes).sort(), ['add', 'guard', 'mount', 'transform']);
    assert.deepEqual(
      run.http.routes.map((route) => (route.type === 'route' ? route.path : route.prefix)),
      ['/seam-probe'],
    );
  });

  it('does not compile a plugin that reaches for Hono', () => {
    const fixture = definePlugin({
      name: 'hono-fixture',
      setup(context) {
        // @ts-expect-error the setup context has no configureHttp
        const configureHttp: unknown = context.configureHttp;
        // @ts-expect-error the registrar has no Hono middleware verb
        const use: unknown = context.routes.use;
        // @ts-expect-error the registrar has no Hono method verbs
        const get: unknown = context.routes.get;
        // @ts-expect-error the registrar mounts no Hono sub-app
        const route: unknown = context.routes.route;
        // @ts-expect-error the registrar has no Hono base path
        const basePath: unknown = context.routes.basePath;
        assert.deepEqual(
          [configureHttp, use, get, route, basePath],
          [undefined, undefined, undefined, undefined, undefined],
        );
      },
    });
    assert.equal(typeof fixture, 'function');
  });
});
