/**
 * Tests for the leak harness: a cycle that leaves a timer or a process
 * listener behind is reported by kind, a clean one is not; a plugin whose unit
 * leaves a timer running is caught through the kernel stages and through a
 * served application, and a serve hook that does through the served one; and fifty
 * create/serve/close cycles of an application with routing, pages and the
 * health route leave the process holding nothing more.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createApplication } from '../../src/app/application.js';
import { createLoadedApp } from '../../src/kernel/load-app.js';
import { documentOutcome } from '../../src/pages/page.js';
import { definePlugin as defineLegacyPlugin } from '../../src/extensions/plugin-contract.js';
import { definePlugin } from '../../src/plugins/contract/define-plugin.js';
import { measureLeaks, measurePluginLeaks } from '../../src/testing/leak-harness.js';

describe('measureLeaks', () => {
  it('reports a timer and a process listener left behind each cycle', async () => {
    const timers: NodeJS.Timeout[] = [];
    const listener = (): void => undefined;
    try {
      const report = await measureLeaks(
        async () => {
          timers.push(setInterval(() => undefined, 60_000));
          process.on('beforeExit', listener);
        },
        { cycles: 10, warmup: 1 },
      );
      assert.equal(report.leaked, true);
      assert.equal(report.cycles, 10);
      assert.equal(report.growth['resource:Timeout'], 10);
      assert.equal(report.growth['listener:beforeExit'], 10);
    } finally {
      for (const timer of timers) clearInterval(timer);
      while (process.listeners('beforeExit').includes(listener)) {
        process.off('beforeExit', listener);
      }
    }
  });

  it('reports nothing for a cycle that releases what it took', async () => {
    const report = await measureLeaks(
      async () => {
        const timer = setInterval(() => undefined, 60_000);
        clearInterval(timer);
      },
      { cycles: 20, warmup: 2 },
    );
    assert.deepEqual(report, { cycles: 20, growth: {}, leaked: false });
  });

  it('refuses a malformed option', async () => {
    await assert.rejects(
      measureLeaks(async () => undefined, { cycles: 0 }),
      TypeError,
    );
  });
});

describe('measurePluginLeaks', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'jsails-leak-plugins-'));
  after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(join(rootDir, 'package.json'), JSON.stringify({ name: 'leak-plugins' }));

  /** A plugin whose unit starts a timer, and stops it only when `clean`. */
  function timerPlugin(clean: boolean, timers: NodeJS.Timeout[]) {
    return definePlugin({
      name: 'ticker',
      setup({ lifecycle }) {
        let timer: NodeJS.Timeout | undefined;
        lifecycle.register(['worker'], {
          name: 'ticker',
          start() {
            timer = setInterval(() => undefined, 60_000);
            timers.push(timer);
          },
          drain() {
            if (clean) clearInterval(timer);
          },
          abort() {
            clearInterval(timer);
          },
        });
      },
    });
  }

  for (const roles of [['worker'], ['web', 'worker']] as const) {
    it(`catches a unit that leaves its timer running, and passes one that stops it (${roles.join('+')})`, async () => {
      const timers: NodeJS.Timeout[] = [];
      try {
        const leaking = timerPlugin(false, timers);
        const leaked = await measurePluginLeaks(() => [leaking()], {
          rootDir,
          roles,
          cycles: 10,
          warmup: 1,
        });
        assert.equal(leaked.leaked, true);
        assert.equal(leaked.growth['resource:Timeout'], 10);

        const clean = timerPlugin(true, timers);
        const passed = await measurePluginLeaks(() => [clean()], {
          rootDir,
          roles,
          cycles: 10,
          warmup: 1,
        });
        assert.equal(passed.leaked, false, JSON.stringify(passed.growth));
      } finally {
        for (const timer of timers) clearInterval(timer);
      }
    });
  }

  /** A legacy plugin whose serve hook starts a timer, and whose cleanup stops it only when `clean`. */
  function serveTimerPlugin(clean: boolean, timers: NodeJS.Timeout[]) {
    return () =>
      defineLegacyPlugin({
        name: 'serve-ticker',
        setup({ onServe }) {
          let timer: NodeJS.Timeout | undefined;
          onServe(() => {
            timer = setInterval(() => undefined, 60_000);
            timers.push(timer);
          });
          return () => {
            if (clean) clearInterval(timer);
          };
        },
      });
  }

  it('serves the plugins for the web role, so what a serve hook leaves running is caught', async () => {
    const timers: NodeJS.Timeout[] = [];
    try {
      const leaking = serveTimerPlugin(false, timers);
      const leaked = await measurePluginLeaks(() => [leaking()], {
        rootDir,
        roles: ['web'],
        cycles: 10,
        warmup: 1,
      });
      assert.equal(leaked.leaked, true);
      assert.equal(leaked.growth['resource:Timeout'], 10);

      const clean = serveTimerPlugin(true, timers);
      const passed = await measurePluginLeaks(() => [clean()], {
        rootDir,
        roles: ['web'],
        cycles: 10,
        warmup: 1,
      });
      assert.equal(passed.leaked, false, JSON.stringify(passed.growth));

      // The kernel stages alone never serve, so the same leak goes unseen there.
      const unserved = await measurePluginLeaks(() => [leaking()], {
        rootDir,
        roles: ['worker'],
        cycles: 10,
        warmup: 1,
      });
      assert.equal(unserved.leaked, false, JSON.stringify(unserved.growth));
    } finally {
      for (const timer of timers) clearInterval(timer);
    }
  });
});

/** The status of a GET on a connection of its own, closed after the response. */
function statusOf(url: URL): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = get(url, { agent: false }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
}

describe('an application served and closed fifty times', () => {
  const appRoot = mkdtempSync(join(tmpdir(), 'jsails-leak-app-'));
  after(() => rmSync(appRoot, { recursive: true, force: true }));
  mkdirSync(join(appRoot, 'pages'), { recursive: true });
  writeFileSync(
    join(appRoot, 'pages', 'index.js'),
    'export default function Page() { return null; }\n',
  );
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'leak-app' }));

  it('leaves no server, socket, timer or listener behind', async () => {
    const report = await measureLeaks(
      async () => {
        const app = await createApplication(
          createLoadedApp(
            {
              rootDir: appRoot,
              port: 0,
              host: '127.0.0.1',
              renderer: {
                render: (entry) => documentOutcome(`<html><body>${entry.route}</body></html>`),
              },
            },
            { cwd: appRoot },
          ),
          { roles: ['web'] },
        );
        try {
          const { url } = await app.serve();
          for (const path of ['/', '/up']) {
            assert.equal(await statusOf(new URL(path, url)), 200, path);
          }
        } finally {
          await app.close();
        }
      },
      { cycles: 50, warmup: 5 },
    );
    assert.equal(report.leaked, false, JSON.stringify(report.growth));
  });
});
