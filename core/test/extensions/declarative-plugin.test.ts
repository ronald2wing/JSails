/** Tests for `defineDeclarativePlugin`: provide and routes wiring, spec keys, pass-through fields, user setup order, and value-free errors. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publicAccess } from '../../src/api/access-ref.js';
import { createHttpRoutes, type HttpRoutes } from '../../src/server/http-routes.js';
import { createServiceRegistry, createServiceToken } from '../../src/extensions/services.js';
import {
  DeclarativePluginErrors,
  defineDeclarativePlugin,
} from '../../src/extensions/declarative-plugin.js';
import type { PluginContext } from '../../src/extensions/plugin-contract.js';

/** Build a minimal fake PluginContext for testing setup behavior. */
function fakeContext(overrides: Partial<PluginContext> = {}): PluginContext {
  const registry = createServiceRegistry();
  return {
    services: registry.registrar,
    rootDir: process.cwd(),
    mode: 'test',
    routes: createHttpRoutes({
      owner: 'test',
      origin: 'code-plugin',
      allow: { mount: true, guard: true, transform: true },
    }).routes,
    onServe: () => {},
    configureRequestScope: () => {},
    configureGuard: () => {},
    intercept: () => {},
    observe: () => {},
    interceptorRegistry: {} as PluginContext['interceptorRegistry'],
    lifecycle: { register: () => {} },
    ...overrides,
  };
}

describe('defineDeclarativePlugin', () => {
  it('produces a plugin matching the JsailsPlugin contract', () => {
    const plugin = defineDeclarativePlugin({
      name: 'test-plugin',
    });

    assert.equal(typeof plugin.name, 'string');
    assert.equal(typeof plugin.setup, 'function');
    assert.equal(plugin.requires, undefined);
    assert.equal(plugin.renderer, undefined);
    assert.equal(plugin.priority, undefined);
    assert.equal(plugin.disabled, undefined);
  });

  it('throws a value-free error for a missing name', () => {
    assert.throws(
      () => defineDeclarativePlugin({ name: '' }),
      (error: unknown) => {
        assert.ok(DeclarativePluginErrors.is(error));
        assert.equal(error.code, 'declarative_plugin.invalid_name');
        assert.ok(!error.message.includes('test'));
        return true;
      },
    );
  });

  it('throws a value-free error for an empty name', () => {
    assert.throws(
      () => defineDeclarativePlugin({ name: '  ' }),
      (error: unknown) => DeclarativePluginErrors.is(error),
    );
  });

  it('throws a value-free error for a non-string name', () => {
    assert.throws(
      // @ts-expect-error testing invalid name type
      () => defineDeclarativePlugin({ name: 1 }),
      (error: unknown) => DeclarativePluginErrors.is(error),
    );
  });
});

describe('provide → services.provide mapping', () => {
  it('calls services.provide for every entry during setup', () => {
    const tokenA = createServiceToken<string>('tokenA');
    const tokenB = createServiceToken<number>('tokenB');

    const registry = createServiceRegistry();
    let routesCalled = false;

    const plugin = defineDeclarativePlugin({
      name: 'provider',
      provide: [
        [tokenA, 'valueA'],
        [tokenB, 42],
      ],
      routes: () => {
        routesCalled = true;
      },
    });

    const setupResult = plugin.setup(fakeContext({ services: registry.registrar }));

    assert.equal(setupResult, undefined);
    assert.equal(registry.services.get(tokenA), 'valueA');
    assert.equal(registry.services.get(tokenB), 42);
    assert.equal(routesCalled, true);
  });

  it('throws value-free for a non-token provide key', () => {
    assert.throws(
      () =>
        // @ts-expect-error testing invalid provide entry
        defineDeclarativePlugin({ name: 'bad', provide: [['not-a-token', 'value']] }),
      (error: unknown) => {
        assert.ok(DeclarativePluginErrors.is(error));
        assert.equal(error.code, 'declarative_plugin.invalid_provide_key');
        assert.ok(!error.message.includes('not-a-token'));
        return true;
      },
    );
  });

  it('throws value-free for a non-array provide entry', () => {
    assert.throws(
      () =>
        // @ts-expect-error testing invalid provide entry
        defineDeclarativePlugin({ name: 'bad', provide: [42] }),
      (error: unknown) => {
        assert.ok(DeclarativePluginErrors.is(error));
        assert.equal(error.code, 'declarative_plugin.invalid_provide_entry');
        return true;
      },
    );
  });

  it('throws value-free for a provide entry with wrong length', () => {
    const token = createServiceToken<string>('tok');
    assert.throws(
      () =>
        // @ts-expect-error testing invalid provide entry
        defineDeclarativePlugin({ name: 'bad', provide: [[token]] }),
      (error: unknown) => {
        assert.ok(DeclarativePluginErrors.is(error));
        assert.equal(error.code, 'declarative_plugin.invalid_provide_entry');
        return true;
      },
    );
  });

  it('rejects a plain object without a name property as a provide key', () => {
    const plain = {};
    assert.throws(
      () =>
        // @ts-expect-error testing invalid provide entry
        defineDeclarativePlugin({ name: 'bad', provide: [[plain, 'val']] }),
      (error: unknown) => {
        assert.ok(DeclarativePluginErrors.is(error));
        assert.equal(error.code, 'declarative_plugin.invalid_provide_key');
        return true;
      },
    );
  });

  it('rejects null as a provide key', () => {
    assert.throws(
      () =>
        // @ts-expect-error testing invalid provide entry
        defineDeclarativePlugin({ name: 'bad', provide: [[null, 'val']] }),
      (error: unknown) => {
        assert.ok(DeclarativePluginErrors.is(error));
        assert.equal(error.code, 'declarative_plugin.invalid_provide_key');
        return true;
      },
    );
  });

  it('rejects an array as a provide key', () => {
    assert.throws(
      () =>
        // @ts-expect-error testing invalid provide entry
        defineDeclarativePlugin({ name: 'bad', provide: [['clock', 'val']] }),
      (error: unknown) => {
        assert.ok(DeclarativePluginErrors.is(error));
        assert.equal(error.code, 'declarative_plugin.invalid_provide_key');
        return true;
      },
    );
  });

  it('accepts an empty provide array', () => {
    const registry = createServiceRegistry();
    const plugin = defineDeclarativePlugin({
      name: 'empty',
      provide: [],
    });

    plugin.setup(
      fakeContext({
        services: registry.registrar,
      }),
    );

    // Nothing registered — no error.
    assert.equal(registry.services.tryGet(createServiceToken('x')), undefined);
  });
});

describe('routes passthrough', () => {
  it("calls routes with the plugin's registrar during setup", () => {
    const registrar = createHttpRoutes({
      owner: 'routes-plugin',
      origin: 'code-plugin',
      allow: { mount: false, guard: false, transform: false },
    });
    let seen: HttpRoutes | undefined;
    const plugin = defineDeclarativePlugin({
      name: 'routes-plugin',
      routes: (routes) => {
        seen = routes;
        routes.add({
          methods: ['GET'],
          path: '/routes-plugin',
          access: publicAccess('declarative plugin probe'),
          handler: () => new Response('ok'),
        });
      },
    });

    plugin.setup(fakeContext({ routes: registrar.routes }));

    assert.equal(seen, registrar.routes);
    const [route, ...rest] = registrar.contributions().routes;
    assert.equal(route?.type === 'route' ? route.path : undefined, '/routes-plugin');
    assert.equal(rest.length, 0);
  });

  it('registers nothing when routes is omitted', () => {
    const registrar = createHttpRoutes({
      owner: 'no-routes',
      origin: 'code-plugin',
      allow: { mount: false, guard: false, transform: false },
    });
    defineDeclarativePlugin({ name: 'no-routes' }).setup(fakeContext({ routes: registrar.routes }));
    assert.deepEqual(registrar.contributions().routes, []);
  });

  it('refuses a routes entry that is not a function, value-free', () => {
    assert.throws(
      () =>
        // @ts-expect-error testing an invalid routes entry
        defineDeclarativePlugin({ name: 'bad-routes', routes: 'secret-value' }),
      (error: unknown) => {
        assert.ok(DeclarativePluginErrors.is(error, 'invalid_routes'));
        assert.ok(!error.message.includes('secret-value'));
        return true;
      },
    );
  });
});

describe('spec keys', () => {
  /** A spec as a plain `.js` app config builds it: no excess-property check applies. */
  function untypedSpec(
    spec: Readonly<Record<string, unknown>>,
  ): Parameters<typeof defineDeclarativePlugin>[0] {
    return spec as unknown as Parameters<typeof defineDeclarativePlugin>[0];
  }

  it('refuses the removed http hook, naming routes as its replacement', () => {
    let called = false;
    const spec = untypedSpec({
      name: 'clock',
      http: () => {
        called = true;
      },
    });
    assert.throws(
      () => defineDeclarativePlugin(spec),
      (error: unknown) => {
        assert.ok(DeclarativePluginErrors.is(error, 'removed_option'));
        assert.deepEqual(error.context, { plugin: 'clock', option: 'http', replacement: 'routes' });
        return true;
      },
    );
    assert.equal(called, false);
  });

  it('refuses a key the spec does not have, value-free', () => {
    assert.throws(
      () => defineDeclarativePlugin(untypedSpec({ name: 'typo', rotues: 'secret-value' })),
      (error: unknown) => {
        assert.ok(DeclarativePluginErrors.is(error, 'unknown_option'));
        assert.deepEqual(error.context, { plugin: 'typo' });
        assert.ok(!error.message.includes('rotues'));
        assert.ok(!error.message.includes('secret-value'));
        return true;
      },
    );
  });

  it('accepts every key the spec declares', () => {
    const plugin = defineDeclarativePlugin({
      name: 'full',
      requires: [],
      provide: [],
      routes: () => {},
      setup: () => {},
      describe: () => ({}),
      renderer: undefined,
      priority: 1,
      disabled: false,
    });
    assert.equal(plugin.name, 'full');
  });
});

describe('requires and describe pass through', () => {
  it('preserves requires unchanged', () => {
    const token = createServiceToken<number>('db');
    const plugin = defineDeclarativePlugin({
      name: 'consumer',
      requires: [token],
    });

    assert.deepEqual(plugin.requires, [token]);
  });

  it('preserves describe unchanged', () => {
    const desc = () => ({ components: [{ name: 'c', actions: [], writableKeys: [] }] });
    const plugin = defineDeclarativePlugin({
      name: 'desc-plugin',
      describe: desc,
    });

    assert.equal(plugin.describe, desc);
  });
});

describe('optional user setup runs after auto-wiring', () => {
  it('runs user setup after provide and routes', () => {
    const token = createServiceToken<string>('tok');
    const order: string[] = [];

    const registry = createServiceRegistry();
    const plugin = defineDeclarativePlugin({
      name: 'ordered',
      provide: [[token, 'val']],
      routes: () => {
        order.push('routes');
      },
      setup: () => {
        order.push('user-setup');
      },
    });

    plugin.setup(fakeContext({ services: registry.registrar }));

    assert.deepEqual(order, ['routes', 'user-setup']);
  });
});

describe('declarative_plugin errors are value-free', () => {
  it('never echoes the problematic value in the message', () => {
    const badToken = { foo: 'bar' };
    try {
      // @ts-expect-error testing invalid provide entry
      defineDeclarativePlugin({ name: 'bad', provide: [[badToken, 'x']] });
      assert.fail('expected an error');
    } catch (error) {
      assert.ok(DeclarativePluginErrors.is(error));
      const msg = error.message;
      assert.ok(!msg.includes('foo'));
      assert.ok(!msg.includes('bar'));
      assert.deepEqual(error.context, { plugin: 'bad' });
      assert.equal(error.code, 'declarative_plugin.invalid_provide_key');
    }
  });
});

describe('describe passthrough', () => {
  it('produces undefined describe when no describe is given', () => {
    const plugin = defineDeclarativePlugin({ name: 'bare' });
    assert.equal(plugin.describe, undefined);
  });

  it('passes describe through by reference when given', () => {
    const desc = () => ({ components: [{ name: 'c', actions: [], writableKeys: [] }] });
    const plugin = defineDeclarativePlugin({
      name: 'desc-only',
      describe: desc,
    });

    assert.equal(plugin.describe, desc);
    const describeFn = plugin.describe;
    assert.notEqual(describeFn, undefined);
    assert.deepEqual(describeFn().components, [{ name: 'c', actions: [], writableKeys: [] }]);
  });
});
