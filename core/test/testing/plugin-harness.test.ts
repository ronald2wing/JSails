/**
 * `testPlugin`: the inert-setup harness. Each trap (network, file writes,
 * subprocesses, recurring timers, opening a substrate resource) fails the run
 * with a value-free `plugin_harness.inert_violation`, even when setup swallows
 * the throw; work setup leaves behind (a pending timer or immediate, an
 * unawaited promise chain, a side effect committed before close) fails the
 * run or its close, whatever the timing; work outside a watched setup is
 * untouched; the traps come off when the last run closes.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { createServiceToken } from '../../src/extensions/services.js';
import { definePlugin } from '../../src/plugins/contract/define-plugin.js';
import { PluginErrors } from '../../src/plugins/contract/errors.js';
import {
  lazy,
  type PluginSetup,
  type SubstrateHandle,
} from '../../src/plugins/contract/instance.js';
import { envVar } from '../../src/plugins/contract/option-schemas.js';
import { PluginHarnessErrors, testPlugin } from '../../src/testing/plugin-harness.js';
import { publicAccess } from '../../src/api/access-ref.js';
import type { HttpRoutes } from '../../src/server/http-routes.js';

const SECRET_PATH = join(tmpdir(), 'jsails-harness-never-written-secret');

/** Assert `run` fails with an inert violation of `kind` at `operation`, echoing no argument. */
async function assertViolation(
  run: Promise<unknown>,
  kind: string,
  operation: string,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(PluginHarnessErrors.is(error, 'inert_violation'), String(error));
    assert.equal(error.context['kind'], kind);
    assert.equal(error.context['operation'], operation);
    assert.ok(!String(error).includes('never-written-secret'), String(error));
    return true;
  });
}

function pluginWith(setup: PluginSetup) {
  return definePlugin({ name: 'probe', setup })();
}

describe('testPlugin: traps', () => {
  it('catches opening a socket', async () => {
    await assertViolation(
      testPlugin(
        pluginWith(() => {
          net.connect({ port: 9, host: '127.0.0.1' });
        }),
      ),
      'network',
      'net.connect',
    );
  });

  it('catches listening', async () => {
    await assertViolation(
      testPlugin(
        pluginWith(() => {
          net.createServer().listen(0);
        }),
      ),
      'network',
      'net.listen',
    );
  });

  it('catches fetch', async () => {
    await assertViolation(
      testPlugin(
        pluginWith(async () => {
          await fetch('http://127.0.0.1:9/');
        }),
      ),
      'network',
      'fetch',
    );
  });

  it('catches file writes through callbacks, sync calls and named promise imports', async () => {
    await assertViolation(
      testPlugin(pluginWith(() => fs.writeFileSync(SECRET_PATH, 'x'))),
      'fs_write',
      'fs.writeFile',
    );
    await assertViolation(
      testPlugin(pluginWith(async () => writeFile(SECRET_PATH, 'x'))),
      'fs_write',
      'fs.writeFile',
    );
    await assertViolation(
      testPlugin(pluginWith(() => fs.open(SECRET_PATH, 'w', () => undefined))),
      'fs_write',
      'fs.open',
    );
    assert.equal(fs.existsSync(SECRET_PATH), false);
  });

  it('lets setup open a file for reading', async () => {
    const run = await testPlugin(
      pluginWith(() => {
        fs.closeSync(fs.openSync(import.meta.filename, 'r'));
      }),
    );
    await run.close();
  });

  it('catches a subprocess and a recurring timer', async () => {
    await assertViolation(
      testPlugin(
        pluginWith(() => {
          spawnSync(process.execPath, ['--version']);
        }),
      ),
      'subprocess',
      'child_process.spawnSync',
    );
    await assertViolation(
      testPlugin(
        pluginWith(() => {
          setInterval(() => undefined, 1_000);
        }),
      ),
      'timer',
      'timers.setInterval',
    );
  });

  it('catches opening a substrate resource during setup, and opens it afterwards', async () => {
    const pool = createServiceToken<SubstrateHandle<string>>('probe.pool');
    let opened = 0;
    const declare = () => [
      {
        token: pool,
        create: () => {
          opened += 1;
          return 'connection';
        },
        close: () => undefined,
      },
    ];
    const eager = definePlugin({
      name: 'eager',
      substrate: declare,
      async setup({ services }) {
        await services.get(pool).get();
      },
    });
    await assertViolation(testPlugin(eager()), 'substrate', 'substrate.open');
    assert.equal(opened, 0);

    const inert = definePlugin({ name: 'inert', substrate: declare, setup() {} });
    const run = await testPlugin(inert());
    try {
      assert.deepEqual(run.substrate, [pool]);
      assert.equal(await run.services.get(pool).get(), 'connection');
      assert.equal(opened, 1);
    } finally {
      await run.close();
    }
  });

  it('declares substrate with the root it hands setup', async () => {
    const roots: string[] = [];
    const rooted = definePlugin({
      name: 'rooted',
      substrate: ({ rootDir }) => {
        roots.push(rootDir);
        return [];
      },
      setup({ rootDir }) {
        roots.push(rootDir);
      },
    });
    const rootDir = resolve('/', 'probe-app');
    await (await testPlugin(rooted(), { rootDir })).close();
    await (await testPlugin(rooted())).close();
    assert.equal(roots[0], rootDir);
    assert.equal(roots[1], rootDir);
    assert.equal(roots[2], roots[3]);
    assert.notEqual(roots[2], rootDir);
  });

  it('fails even when setup swallows the trap', async () => {
    await assertViolation(
      testPlugin(
        pluginWith(() => {
          try {
            fs.mkdirSync(SECRET_PATH);
          } catch {
            // The plugin hides the failure; the harness still reports it.
          }
        }),
      ),
      'fs_write',
      'fs.mkdir',
    );
  });

  it('watches the evaluation of a lazy setup module', async () => {
    const plugin = definePlugin({
      name: 'lazy-writer',
      setup: lazy(async () => {
        fs.writeFileSync(SECRET_PATH, 'x');
        return { default: () => undefined };
      }),
    });
    await assertViolation(testPlugin(plugin()), 'fs_write', 'fs.writeFile');
  });

  it('runs the cleanup of a setup that violated', async () => {
    const events: string[] = [];
    await assertViolation(
      testPlugin(
        pluginWith(() => {
          try {
            fs.rmSync(SECRET_PATH, { force: true });
          } catch {
            // Swallowed on purpose: the cleanup must still run.
          }
          return () => {
            events.push('cleanup');
          };
        }),
      ),
      'fs_write',
      'fs.rm',
    );
    assert.deepEqual(events, ['cleanup']);
  });
});

describe('testPlugin: deferred work', () => {
  /** Resolve after `ms`, outside any watched setup. */
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  it('fails on a timer setup leaves pending, and cancels it so it never acts', async () => {
    for (const delay of [0, 20]) {
      let ran = false;
      await assertViolation(
        testPlugin(
          pluginWith(() => {
            setTimeout(() => {
              ran = true;
              net.connect({ port: 9, host: '127.0.0.1' });
            }, delay);
          }),
        ),
        'timer',
        'timers.setTimeout',
      );
      await pause(delay + 50);
      assert.equal(ran, false);
    }
  });

  it('fails on a pending immediate, whether or not its work is harmful', async () => {
    let ran = false;
    await assertViolation(
      testPlugin(
        pluginWith(() => {
          setImmediate(() => {
            ran = true;
          });
        }),
      ),
      'timer',
      'timers.setImmediate',
    );
    await pause(20);
    assert.equal(ran, false);
  });

  it('accepts a timer setup awaits or clears before it resolves', async () => {
    const run = await testPlugin(
      pluginWith(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
        clearTimeout(setTimeout(() => undefined, 1_000));
        clearImmediate(setImmediate(() => undefined));
      }),
    );
    await run.close();
  });

  it('reports a trap inside a timer that fires during setup as a failed run', async () => {
    await assertViolation(
      testPlugin(
        pluginWith(async () => {
          setTimeout(() => {
            fs.writeFileSync(SECRET_PATH, 'x');
          }, 0);
          // A timer callback may be async, as plugin code writes it; the trap
          // then rejects its promise instead of throwing.
          const writeLater: () => unknown = async () => {
            await fs.promises.writeFile(SECRET_PATH, 'x');
          };
          setTimeout(writeLater, 0);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 30);
          });
        }),
      ),
      'fs_write',
      'fs.writeFile',
    );
    assert.equal(fs.existsSync(SECRET_PATH), false);
  });

  it('runs promise chains setup did not await under the traps before returning', async () => {
    await assertViolation(
      testPlugin(
        pluginWith(() => {
          let chain = Promise.resolve();
          for (let hop = 0; hop < 50; hop += 1) chain = chain.then(() => undefined);
          chain
            .then(() => {
              fs.writeFileSync(SECRET_PATH, 'x');
            })
            .catch(() => {
              // The plugin hides the failure; the harness still reports it.
            });
        }),
      ),
      'fs_write',
      'fs.writeFile',
    );
  });

  it('fails close when work setup left running commits a side effect before it', async () => {
    let attempted!: () => void;
    const attempt = new Promise<void>((resolve) => {
      attempted = resolve;
    });
    const plugin = pluginWith(() => {
      fs.promises
        .readFile(import.meta.filename)
        .then(() => {
          fs.writeFileSync(SECRET_PATH, 'x');
        })
        .catch(() => {
          // Swallowed on purpose: the harness records the trap either way.
        })
        .finally(attempted);
    });
    let run: Awaited<ReturnType<typeof testPlugin>>;
    try {
      run = await testPlugin(plugin);
    } catch (error) {
      // The read finished before setup's work settled: the run itself failed.
      assert.ok(PluginHarnessErrors.is(error, 'inert_violation'), String(error));
      return;
    }
    await attempt;
    await assertViolation(run.close(), 'fs_write', 'fs.writeFile');
    assert.equal(fs.existsSync(SECRET_PATH), false);
  });

  it('keeps promisified timers working while the traps are installed', async () => {
    const run = await testPlugin(pluginWith(() => undefined));
    try {
      assert.equal(await promisify(setTimeout)(1, 'value'), 'value');
    } finally {
      await run.close();
    }
  });
});

describe('testPlugin: isolation', () => {
  it('leaves work outside a watched setup alone, during and after a run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsails-harness-'));
    try {
      const run = await testPlugin(pluginWith(() => undefined));
      await writeFile(join(dir, 'during.txt'), 'ok');
      await run.close();
      await writeFile(join(dir, 'after.txt'), 'ok');
      assert.equal(fs.readFileSync(join(dir, 'during.txt'), 'utf8'), 'ok');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes the traps when the last run closes', async () => {
    const original = fs.writeFileSync;
    const first = await testPlugin(pluginWith(() => undefined));
    const second = await testPlugin(pluginWith(() => undefined));
    assert.notEqual(fs.writeFileSync, original);
    await first.close();
    assert.notEqual(fs.writeFileSync, original);
    await second.close();
    assert.equal(fs.writeFileSync, original);
  });

  it('reads the environment only from the options', async () => {
    let seen: unknown;
    const plugin = definePlugin({
      name: 'configured',
      env: { PATH: envVar.string().optional() },
      setup({ env }) {
        seen = env.PATH;
      },
    });
    const run = await testPlugin(plugin());
    await run.close();
    assert.equal(seen, undefined, 'the process PATH is not read');
  });
});

describe('testPlugin: the run', () => {
  it('provides stand-in services and records units for every role', async () => {
    const config = createServiceToken<number>('probe.config');
    const answer = createServiceToken<number>('probe.answer');
    const plugin = definePlugin({
      name: 'worker',
      requires: [config],
      provides: [answer],
      setup({ services, lifecycle, roles }) {
        services.provide(answer, services.get(config) * 2);
        lifecycle.register(['worker'], {
          name: 'probe.unit',
          start() {},
          drain() {},
          abort() {},
        });
        assert.ok(roles.has('web'));
      },
    });
    const run = await testPlugin(plugin(), { services: [[config, 21]], roles: ['web'] });
    try {
      assert.equal(run.services.get(answer), 42);
      assert.deepEqual(run.provided, [answer]);
      assert.deepEqual(
        run.units.map((registration) => [registration.unit.name, registration.roles]),
        [['probe.unit', ['worker']]],
      );
    } finally {
      await run.close();
    }
  });

  it('reports what the runner reports, and refuses a non-instance', async () => {
    const config = createServiceToken<number>('probe.config');
    const plugin = definePlugin({ name: 'reader', requires: [config], setup() {} });
    await assert.rejects(testPlugin(plugin()), (error: unknown) =>
      PluginErrors.is(error, 'missing_service'),
    );
    await assert.rejects(testPlugin({} as never), (error: unknown) =>
      PluginHarnessErrors.is(error, 'not_a_plugin'),
    );
  });

  it('returns the routes setup registered and closes the registrar when setup returns', async () => {
    let kept: HttpRoutes | undefined;
    const plugin = definePlugin({
      name: 'routed',
      setup({ routes }) {
        kept = routes;
        routes.add({
          methods: ['GET'],
          path: '/probe',
          access: publicAccess('probe route'),
          handler: () => new Response('ok'),
        });
        routes.transform(['page', 'api'], (response) => response);
      },
    });
    const run = await testPlugin(plugin());
    try {
      assert.deepEqual(
        run.http.routes.map((route) => [route.type, route.owner, route.origin]),
        [['route', 'routed', 'code-plugin']],
      );
      assert.deepEqual(
        run.http.transforms.map((entry) => entry.kinds),
        [['page', 'api']],
      );
      assert.throws(
        () => kept?.guard(() => undefined),
        (error: unknown) => PluginErrors.is(error, 'routes_closed'),
      );
    } finally {
      await run.close();
    }
  });

  it('derives the mode from the NODE_ENV of the given environment, production without one', async () => {
    const seen: string[] = [];
    const plugin = definePlugin({
      name: 'moded',
      setup({ mode }) {
        seen.push(mode);
      },
    });
    for (const env of [undefined, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }]) {
      const run = await testPlugin(plugin(), env === undefined ? {} : { env });
      await run.close();
    }
    assert.deepEqual(seen, ['production', 'development', 'test']);
  });
});
