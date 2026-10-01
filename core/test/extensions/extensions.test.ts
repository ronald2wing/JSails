/** Tests for `runExtensions`: service tokens, the lifecycle, sealing and close, http and serve hooks, and entry-point imports. */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createServiceRegistry,
  createServiceToken,
  ExtensionErrors,
  runExtensions,
  ServiceErrors,
  type ExtensionContext,
  type JsailsExtension,
  type ServiceRegistrar,
} from '../../src/extensions/index.js';
import { publicAccess } from '../../src/api/access-ref.js';

/**
 * Tests for the extension foundation. They exercise the registry, the ordered
 * setup/failure lifecycle, sealing, idempotent close, hook collection, and the
 * absence of any ORM/HTTP runtime import. No service or network is involved.
 */

/** Capture the `service.*` error thrown by `fn`, asserting its code. */
function registryError(fn: () => unknown, code: keyof typeof ServiceErrors.codes): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(ServiceErrors.is(error, code), `expected service.${code}, got ${String(error)}`);
    return true;
  });
}

describe('service tokens and registry', () => {
  it('returns an opaque typed identity that is not frozen', () => {
    const token = createServiceToken<{ port: number }>('database');
    const controller = createServiceRegistry();
    const value = { port: 5432 };

    controller.registrar.provide(token, value);

    // Compile-time check: `get` returns the token's value type.
    const resolved: { port: number } = controller.services.get(token);
    assert.equal(resolved, value);
    assert.equal(controller.services.has(token), true);

    // Values are handed back by reference, never frozen.
    resolved.port = 6000;
    assert.equal(controller.services.get(token).port, 6000);
  });

  it('treats tokens with the same name as distinct identities', () => {
    const primary = createServiceToken<string>('shared');
    const other = createServiceToken<string>('shared');
    const controller = createServiceRegistry();

    controller.registrar.provide(primary, 'a');

    assert.equal(controller.services.has(other), false);
    assert.equal(controller.services.tryGet(other), undefined);
    registryError(() => controller.services.get(other), 'not_found');
  });

  it('rejects a duplicate provide of the same token', () => {
    const token = createServiceToken<number>('count');
    const controller = createServiceRegistry();

    controller.registrar.provide(token, 1);

    registryError(() => controller.registrar.provide(token, 2), 'duplicate');
    assert.equal(controller.services.get(token), 1);
  });

  it('keeps registries isolated per app', () => {
    const token = createServiceToken<string>('config');
    const first = createServiceRegistry();
    const second = createServiceRegistry();

    first.registrar.provide(token, 'one');

    assert.equal(first.services.get(token), 'one');
    assert.equal(second.services.has(token), false);
  });
});

describe('runExtensions lifecycle', () => {
  it('checks requirements against services registered by earlier extensions', async () => {
    const answer = createServiceToken<number>('answer');
    const seen: number[] = [];

    const runtime = await runExtensions(
      [
        {
          name: 'provider',
          setup: ({ services }) => {
            services.provide(answer, 42);
          },
        },
        {
          name: 'consumer',
          requires: [answer],
          setup: ({ services }) => {
            seen.push(services.get(answer));
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );

    assert.deepEqual(seen, [42]);
    assert.equal(runtime.services.get(answer), 42);
    await runtime.close();
  });

  it('fails when no extension registers a requirement', async () => {
    const answer = createServiceToken<number>('answer');
    const other = createServiceToken<number>('other');

    await assert.rejects(
      runExtensions(
        [
          { name: 'consumer', requires: [answer], setup: () => {} },
          {
            name: 'provider',
            setup: ({ services }) => {
              services.provide(other, 42);
            },
          },
        ],
        { rootDir: import.meta.dirname },
      ),
      (error: unknown) => {
        assert.ok(ExtensionErrors.is(error, 'missing_service'));
        assert.equal(error.context.token, 'answer');
        return true;
      },
    );
  });

  it('rejects duplicate names and malformed setup before any side effect', async () => {
    let ran = false;

    await assert.rejects(
      runExtensions(
        [
          {
            name: 'dup',
            setup: () => {
              ran = true;
            },
          },
          {
            name: 'dup',
            setup: () => {
              ran = true;
            },
          },
        ],
        { rootDir: import.meta.dirname },
      ),
      /extension dup is rejected: duplicate_name/,
    );
    assert.equal(ran, false);

    await assert.rejects(
      runExtensions([{ name: 'bad', setup: undefined as unknown as () => void }], {
        rootDir: import.meta.dirname,
      }),
      /extension bad is rejected: missing_setup/,
    );
    assert.equal(ran, false);
  });

  it('cleans up completed extensions in reverse and aggregates errors', async () => {
    const order: string[] = [];
    const primary = new Error('setup failed');

    await assert.rejects(
      runExtensions(
        [
          {
            name: 'first',
            setup: () => () => {
              order.push('first');
            },
          },
          {
            name: 'second',
            setup: () => () => {
              order.push('second');
              throw new Error('cleanup failed');
            },
          },
          {
            name: 'third',
            setup: () => {
              throw primary;
            },
          },
        ],
        { rootDir: import.meta.dirname },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], primary);
        assert.equal(error.cause, primary);
        assert.equal((error.errors[1] as Error).message, 'cleanup failed');
        return true;
      },
    );

    assert.deepEqual(order, ['second', 'first']);
  });

  it('clears the registry on failure even when cleanup throws', async () => {
    const token = createServiceToken<string>('leaked');
    const late = createServiceToken<string>('late');
    let leaked: ServiceRegistrar | undefined;

    await assert.rejects(
      runExtensions(
        [
          {
            name: 'first',
            setup: ({ services }) => {
              leaked = services;
              services.provide(token, 'value');
              return () => {
                throw new Error('cleanup failed');
              };
            },
          },
          {
            name: 'second',
            setup: () => {
              throw new Error('boom');
            },
          },
        ],
        { rootDir: import.meta.dirname },
      ),
      AggregateError,
    );

    const registrar = leaked;
    assert.ok(registrar);
    registryError(() => registrar.provide(late, 'value'), 'closed');
  });
});

describe('runExtensions sealing and close', () => {
  it('seals the registry after setup so a leaked registrar cannot provide', async () => {
    const early = createServiceToken<string>('early');
    const late = createServiceToken<string>('late');
    let leaked: ServiceRegistrar | undefined;

    const runtime = await runExtensions(
      [
        {
          name: 'app',
          setup: ({ services }) => {
            leaked = services;
            services.provide(early, 'ok');
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );

    assert.equal(runtime.services.get(early), 'ok');
    const registrar = leaked;
    assert.ok(registrar);
    registryError(() => registrar.provide(late, 'nope'), 'sealed');

    await runtime.close();
    registryError(() => registrar.provide(late, 'nope'), 'closed');
  });

  it('makes registry reads fail after close', async () => {
    const token = createServiceToken<number>('gone');
    const runtime = await runExtensions(
      [{ name: 'app', setup: ({ services }) => services.provide(token, 1) }],
      { rootDir: import.meta.dirname },
    );

    await runtime.close();

    registryError(() => runtime.services.has(token), 'closed');
    registryError(() => runtime.services.tryGet(token), 'closed');
    registryError(() => runtime.services.get(token), 'closed');
  });

  it('closes idempotently and shares one promise across concurrent callers', async () => {
    let cleanups = 0;
    const runtime = await runExtensions(
      [
        {
          name: 'app',
          setup: () => () => {
            cleanups += 1;
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );

    const first = runtime.close();
    const second = runtime.close();
    assert.equal(first, second);
    await Promise.all([first, second]);
    await runtime.close();

    assert.equal(cleanups, 1);
  });

  it('runs every cleanup before clearing, even when one throws', async () => {
    const order: string[] = [];
    const runtime = await runExtensions(
      [
        {
          name: 'first',
          setup: () => () => {
            order.push('first');
          },
        },
        {
          name: 'second',
          setup: () => () => {
            order.push('second');
            throw new Error('cleanup failed');
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );

    await assert.rejects(runtime.close(), /cleanup failed/);
    assert.deepEqual(order, ['second', 'first']);
  });
});

describe('runExtensions http surface', () => {
  it('hands setup the registrar and no router seam', async () => {
    let seen: ExtensionContext | undefined;
    const runtime = await runExtensions(
      [
        {
          name: 'probe',
          setup: (context) => {
            seen = context;
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );
    assert.ok(seen !== undefined);
    assert.equal(typeof seen.routes.add, 'function');
    for (const removed of ['configureHttp', 'configureMiddleware']) {
      assert.equal(removed in seen, false, removed);
    }
    await runtime.close();
  });
});

describe('runExtensions registrars', () => {
  it("keeps what a later extension registers through an earlier one's registrar", async () => {
    let shared: ExtensionContext | undefined;
    const handler = () => new Response('late');
    const guard = () => undefined;
    const runtime = await runExtensions(
      [
        {
          name: 'provider',
          setup: (context) => {
            shared = context;
          },
        },
        {
          name: 'consumer',
          setup: () => {
            assert.ok(shared);
            shared.routes.add({
              methods: ['GET'],
              path: '/late',
              access: publicAccess('a route a provider helper adds'),
              handler,
            });
            shared.configureGuard(guard);
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );
    assert.deepEqual(
      runtime.routes.map((route) => [route.owner, route.type === 'route' ? route.path : '']),
      [['provider', '/late']],
    );
    assert.deepEqual(runtime.guards, [guard]);
    const late = shared;
    assert.ok(late);
    assert.throws(
      () =>
        late.routes.add({ methods: ['GET'], path: '/after', access: publicAccess('x'), handler }),
      (error: unknown) => ExtensionErrors.is(error, 'sealed'),
    );
    await runtime.close();
  });
});

describe('runExtensions serve hooks', () => {
  it('collects serve hooks in setup order, never invokes them, and closes registration', async () => {
    const calls: string[] = [];
    let leakedOnServe: ((hook: (server: unknown) => void) => void) | undefined;

    const runtime = await runExtensions(
      [
        {
          name: 'first',
          setup: ({ onServe }) => {
            onServe(() => {
              calls.push('first');
            });
          },
        },
        {
          name: 'second',
          setup: ({ onServe }) => {
            leakedOnServe = onServe;
            onServe(async () => {
              calls.push('second');
            });
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );

    assert.equal(runtime.serveHooks.length, 2);
    assert.deepEqual(calls, []);

    const register = leakedOnServe;
    assert.ok(register);
    assert.throws(() => register(() => {}), /only be configured during setup/);

    await runtime.close();

    // Registration stays closed after close: a leaked registrar still rejects.
    assert.throws(() => register(() => {}), /only be configured during setup/);
  });

  it('rejects a non-function serve hook during setup', async () => {
    await assert.rejects(
      runExtensions(
        [
          {
            name: 'bad',
            setup: ({ onServe }) => {
              onServe('not-a-function' as unknown as () => void);
            },
          },
        ],
        { rootDir: import.meta.dirname },
      ),
      (error: unknown) => ExtensionErrors.is(error, 'invalid_hook'),
    );
  });
});

describe('extension entry point imports', () => {
  it('compiled extension modules import no ORM, HTTP, or CLI runtime', async () => {
    const dir = fileURLToPath(new URL('../../src/extensions/', import.meta.url));
    const files = (await readdir(dir)).filter((file) => file.endsWith('.js')).sort();

    assert.ok(files.includes('index.js'), 'expected compiled index.js');
    for (const file of files) {
      const source = await readFile(join(dir, file), 'utf8');
      assert.equal(
        /from\s+['"](hono|typeorm)['"]/.test(source),
        false,
        `${file} must not import hono or typeorm at runtime`,
      );
      assert.equal(
        /from\s+['"]\.\.\/cli\//.test(source),
        false,
        `${file} must not import the CLI at runtime`,
      );
    }
  });
});

/** Compile-time guard: the exported extension shape stays usable. */
const _extensionShape: JsailsExtension = { name: 'noop', setup: () => {} };
void _extensionShape;

describe('runExtensions priority and disabled', () => {
  it('runs plain extensions in ascending priority then declaration order', async () => {
    const order: string[] = [];
    const runtime = await runExtensions(
      [
        {
          name: 'z',
          priority: 3,
          setup: () => {
            order.push('z');
          },
        },
        {
          name: 'a',
          priority: 0,
          setup: () => {
            order.push('a');
          },
        },
        {
          name: 'b',
          priority: 0,
          setup: () => {
            order.push('b');
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );

    assert.deepEqual(order, ['a', 'b', 'z']);
    await runtime.close();
  });

  it('skips a disabled extension without checking its requirements', async () => {
    const missing = createServiceToken<number>('missing');
    let ran = false;
    const runtime = await runExtensions(
      [
        {
          name: 'off',
          disabled: true,
          requires: [missing],
          setup: () => {
            ran = true;
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );

    assert.equal(ran, false);
    await runtime.close();
  });

  it('rejects a malformed priority or disabled flag before any setup', async () => {
    await assert.rejects(
      runExtensions([{ name: 'bad-priority', priority: Number.NaN, setup: () => {} }], {
        rootDir: import.meta.dirname,
      }),
      /priority/,
    );
    await assert.rejects(
      runExtensions(
        [
          {
            name: 'bad-disabled',
            disabled: 1 as unknown as boolean,
            setup: () => {},
          },
        ],
        { rootDir: import.meta.dirname },
      ),
      /disabled/,
    );
  });
});

describe('runExtensions enabledNames allowlist', () => {
  it('skips an extension whose name is not listed, without running its setup', async () => {
    const ran: string[] = [];
    const runtime = await runExtensions(
      [
        {
          name: 'listed',
          setup: () => {
            ran.push('listed');
          },
        },
        {
          name: 'unlisted',
          setup: () => {
            ran.push('unlisted');
          },
        },
      ],
      { rootDir: import.meta.dirname, enabledNames: ['listed'] },
    );

    assert.deepEqual(ran, ['listed']);
    assert.deepEqual(runtime.skipped, ['unlisted']);
    await runtime.close();
  });

  it('runs an extension whose name is listed', async () => {
    let ran = false;
    const runtime = await runExtensions(
      [
        {
          name: 'listed',
          setup: () => {
            ran = true;
          },
        },
      ],
      { rootDir: import.meta.dirname, enabledNames: ['listed'] },
    );

    assert.equal(ran, true);
    assert.deepEqual(runtime.skipped, []);
    await runtime.close();
  });

  it('fails with the missing-requirement error when a required service belongs to a skipped extension', async () => {
    const answer = createServiceToken<number>('answer');

    await assert.rejects(
      runExtensions(
        [
          {
            name: 'provider',
            setup: ({ services }) => {
              services.provide(answer, 42);
            },
          },
          {
            name: 'consumer',
            requires: [answer],
            setup: () => {},
          },
        ],
        { rootDir: import.meta.dirname, enabledNames: ['consumer'] },
      ),
      (error: unknown) => {
        assert.ok(ExtensionErrors.is(error, 'missing_service'));
        assert.equal(error.context.token, 'answer');
        return true;
      },
    );
  });

  it('runs every extension when enabledNames is undefined', async () => {
    const ran: string[] = [];
    const runtime = await runExtensions(
      [
        {
          name: 'a',
          setup: () => {
            ran.push('a');
          },
        },
        {
          name: 'b',
          setup: () => {
            ran.push('b');
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );

    assert.deepEqual(ran, ['a', 'b']);
    assert.deepEqual(runtime.skipped, []);
    await runtime.close();
  });

  it('still rejects duplicate names before any setup, even for unlisted entries', async () => {
    let ran = false;
    await assert.rejects(
      runExtensions(
        [
          {
            name: 'dup',
            setup: () => {
              ran = true;
            },
          },
          {
            name: 'dup',
            setup: () => {
              ran = true;
            },
          },
        ],
        { rootDir: import.meta.dirname, enabledNames: [] },
      ),
      /extension dup is rejected: duplicate_name/,
    );
    assert.equal(ran, false);
  });
});

describe('runExtensions application root', () => {
  it('hands every setup the rootDir it was given', async () => {
    const seen: string[] = [];
    const root = join(fileURLToPath(new URL('.', import.meta.url)), 'some-app');
    const runtime = await runExtensions(
      [
        {
          name: 'first',
          setup: ({ rootDir }) => {
            seen.push(rootDir);
          },
        },
        {
          name: 'second',
          setup: ({ rootDir }) => {
            seen.push(rootDir);
          },
        },
      ],
      { rootDir: root },
    );

    assert.deepEqual(seen, [root, root]);
    await runtime.close();
  });

  for (const [label, options, problem] of [
    ['no options', undefined, 'missing'],
    ['no rootDir', {}, 'missing'],
    ['an empty rootDir', { rootDir: '' }, 'missing'],
    ['a non-string rootDir', { rootDir: 42 }, 'missing'],
    ['a relative rootDir', { rootDir: 'some-app' }, 'not_absolute'],
    ['a dot rootDir', { rootDir: '.' }, 'not_absolute'],
    // Each platform's look-alike: a drive path is a relative name on POSIX, and
    // a rooted path with no drive still depends on the current drive on Windows.
    [
      'a rootDir absolute only on another platform',
      { rootDir: process.platform === 'win32' ? '\\some-app' : 'C:\\some-app' },
      'not_absolute',
    ],
  ] as const) {
    it(`refuses ${label} before any setup runs, without echoing the value`, async () => {
      let ran = false;
      await assert.rejects(
        runExtensions(
          [
            {
              name: 'plain',
              setup: () => {
                ran = true;
              },
            },
          ],
          options as unknown as { rootDir: string },
        ),
        (error: unknown) => {
          assert.ok(ExtensionErrors.is(error, 'invalid_root'), String(error));
          assert.equal(error.context.problem, problem);
          assert.ok(!error.message.includes('some-app'), error.message);
          return true;
        },
      );
      assert.equal(ran, false);
    });
  }
});

describe('runExtensions readiness probes', () => {
  it('collects declared probes of the extensions that ran, bound to the sealed services', async () => {
    const token = createServiceToken<string>('db-handle');
    const calls: string[] = [];
    const runtime = await runExtensions(
      [
        {
          name: 'db',
          readiness: {
            database: (_signal, services) => {
              calls.push(services.get(token));
              return true;
            },
          },
          setup: ({ services }) => {
            services.provide(token, 'pool');
          },
        },
        { name: 'off', disabled: true, readiness: { off: () => true }, setup() {} },
        { name: 'skipped', readiness: { skipped: () => true }, setup() {} },
      ],
      { rootDir: import.meta.dirname, enabledNames: ['db', 'off'] },
    );

    assert.deepEqual(
      runtime.readinessProbes.map(([name]) => name),
      ['database'],
    );
    assert.deepEqual(calls, []);
    const [, probe] = runtime.readinessProbes[0]!;
    assert.equal(await probe(new AbortController().signal), true);
    assert.deepEqual(calls, ['pool']);
    assert.ok(Object.isFrozen(runtime.readinessProbes));
    await runtime.close();
  });

  it('rejects malformed and duplicate probe declarations before any setup', async () => {
    let ran = false;
    const setup = (): void => {
      ran = true;
    };
    const cases: [JsailsExtension[], RegExp][] = [
      [
        [{ name: 'a', setup, readiness: { db: 'x' } } as unknown as JsailsExtension],
        /extension a is rejected: invalid_readiness/,
      ],
      [
        [{ name: 'a', setup, readiness: { '': () => true } }],
        /extension a is rejected: invalid_readiness/,
      ],
      [
        [
          { name: 'a', setup, readiness: { db: () => true } },
          { name: 'b', setup, readiness: { db: () => true } },
        ],
        /extension b is rejected: duplicate_readiness_probe/,
      ],
    ];
    for (const [extensions, pattern] of cases) {
      await assert.rejects(
        runExtensions(extensions, { rootDir: import.meta.dirname }),
        (error: unknown) => {
          assert.ok(ExtensionErrors.is(error, 'invalid_extension'));
          assert.match(error.message, pattern);
          return true;
        },
      );
    }
    assert.equal(ran, false);
  });
});
