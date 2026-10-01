/**
 * Diagnostics plugin tests: service wiring through the extension runner,
 * recorder options, disabled/no-op mode, the `definePlugin` contract
 * (value-free option validation before any setup, an inert setup),
 * idempotent close, and the `diagnostics` section the plugin feeds to
 * `GET /_jsails/introspect`. No connection, database, or external service is
 * opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diagnosticsToken, type Diagnostics } from 'jsails/diagnostics';
import { runExtensions, type JsailsExtension } from 'jsails/extensions';
import { checkOptionSchema, ConfigErrors } from 'jsails/kernel';
import { createTestApp, testPlugin, type JsailsAppConfig } from 'jsails/testing';
import { diagnosticsPlugin } from '../src/plugin.js';

describe('diagnosticsPlugin', () => {
  it('has name "diagnostics" and a stable token', () => {
    assert.equal(diagnosticsToken.name, 'diagnostics');
    assert.equal(diagnosticsPlugin().name, 'diagnostics');
  });

  it('provides a Diagnostics service under the token', async () => {
    const runtime = await runExtensions([diagnosticsPlugin()], { rootDir: import.meta.dirname });
    try {
      const diag: Diagnostics = runtime.services.get(diagnosticsToken);
      assert.equal(typeof diag.record, 'function');
      assert.equal(typeof diag.entries, 'function');

      // Default state: empty.
      assert.deepEqual(diag.entries(), []);
      assert.deepEqual(diag.stats(), { total: 0, byType: {}, withDuration: 0 });
    } finally {
      await runtime.close();
    }
  });

  it('records and reads entries through the service', async () => {
    const runtime = await runExtensions([diagnosticsPlugin({})], { rootDir: import.meta.dirname });
    try {
      const diag = runtime.services.get(diagnosticsToken);

      diag.record({ type: 'query' });
      diag.record({ type: 'http', durationMs: 10 });
      diag.record({ type: 'query' });

      const queries = diag.entries({ type: 'query' });
      assert.equal(queries.length, 2);

      const s = diag.stats();
      assert.equal(s.total, 3);
      assert.equal(s.byType['query'], 2);
      assert.equal(s.byType['http'], 1);
      assert.equal(s.withDuration, 1);
    } finally {
      await runtime.close();
    }
  });

  it('configures the plugin-owned recorder from its options', async () => {
    let now = 1000;
    const run = await testPlugin(
      diagnosticsPlugin({
        maxEntries: 2,
        clock: () => now,
        monitored: ['slow'],
        tags: [
          { name: 'slow', when: (entry) => (entry.durationMs ?? 0) > 100, value: () => 'yes' },
        ],
      }),
    );
    try {
      const diag = run.services.get(diagnosticsToken);
      diag.record({ type: 'http', durationMs: 500 });
      now = 2000;
      diag.record({ type: 'http', durationMs: 5 });
      diag.record({ type: 'query' });
      assert.equal(diag.stats().total, 2, 'maxEntries bounds the buffer');
      assert.equal(diag.entries()[0]!.at, 2000, 'the clock stamps entries');
    } finally {
      await run.close();
    }
  });
});

describe('disabled plugin', () => {
  it('when enabled is false, the service records nothing', async () => {
    const runtime = await runExtensions([diagnosticsPlugin({ enabled: false })], {
      rootDir: import.meta.dirname,
    });
    try {
      const diag = runtime.services.get(diagnosticsToken);

      assert.equal(typeof diag.record, 'function');
      assert.equal(typeof diag.entries, 'function');

      diag.record({ type: 'query' });
      diag.record({ type: 'http', durationMs: 42 });

      assert.deepEqual(diag.entries(), []);
      assert.deepEqual(diag.entries({ type: 'query' }), []);
      assert.deepEqual(diag.stats(), { total: 0, byType: {}, withDuration: 0 });
    } finally {
      await runtime.close();
    }
  });

  it('disabled service clear is a no-op', async () => {
    const runtime = await runExtensions([diagnosticsPlugin({ enabled: false })], {
      rootDir: import.meta.dirname,
    });
    try {
      const diag = runtime.services.get(diagnosticsToken);

      diag.record({ type: 'anything' });
      diag.clear();

      // Still empty — clear is a no-op on a no-op.
      assert.deepEqual(diag.entries(), []);
    } finally {
      await runtime.close();
    }
  });

  it('still provides the service so consumers do not fail', async () => {
    const runtime = await runExtensions([diagnosticsPlugin({ enabled: false })], {
      rootDir: import.meta.dirname,
    });
    try {
      assert.ok(runtime.services.has(diagnosticsToken));
      const diag = runtime.services.get(diagnosticsToken);
      assert.ok(diag !== null && typeof diag === 'object');
    } finally {
      await runtime.close();
    }
  });
});

describe('the plugin contract', () => {
  it('sets up inertly and provides only diagnosticsToken', async () => {
    const run = await testPlugin(diagnosticsPlugin());
    try {
      assert.deepEqual(run.provided, [diagnosticsToken]);
    } finally {
      await run.close();
    }
  });

  it('has an options schema of data and sanctioned callbacks only', () => {
    assert.deepEqual(checkOptionSchema(diagnosticsPlugin.definition.options!), []);
  });

  const SECRET = 'zz-secret-input';
  const cases: readonly { readonly name: string; readonly input: unknown }[] = [
    { name: 'a non-object', input: SECRET },
    { name: 'an array', input: [SECRET] },
    { name: 'a recorder instance', input: { recorder: { record() {}, label: SECRET } } },
    { name: 'a non-boolean enabled', input: { enabled: SECRET } },
    { name: 'a fractional maxEntries', input: { maxEntries: 1.5 } },
    { name: 'a clock that is not a function', input: { clock: SECRET } },
    { name: 'a tag without callbacks', input: { tags: [{ name: SECRET }] } },
  ];
  for (const { name, input } of cases) {
    it(`refuses ${name} with config.invalid_options before any setup, echoing no input`, () => {
      const factory = diagnosticsPlugin as unknown as (input: unknown) => unknown;
      assert.throws(
        () => factory(input),
        (error: unknown) => {
          assert.ok(ConfigErrors.is(error, 'invalid_options'), String(error));
          const rendered = `${String(error)}\n${JSON.stringify(error.payload)}`;
          assert.ok(!rendered.includes(SECRET), rendered);
          return true;
        },
      );
    });
  }
});

describe('idempotent close', () => {
  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([diagnosticsPlugin()], { rootDir: import.meta.dirname });
    await runtime.close();
    await runtime.close();
  });
});

describe('service + recorder integration', () => {
  it('the plugin-owned recorder is a true ring buffer', async () => {
    const runtime = await runExtensions([diagnosticsPlugin()], { rootDir: import.meta.dirname });
    try {
      const diag = runtime.services.get(diagnosticsToken);

      // The default is 1000 entries — verify boundedness by pushing many.
      for (let i = 0; i < 1500; i++) {
        diag.record({ type: 'query', data: { i } });
      }

      const s = diag.stats();
      assert.equal(s.total, 1000, 'buffer stays capped at the default 1000');
      assert.equal(s.byType['query'], 1000);

      // The earliest 500 should have been evicted.
      const all = diag.entries();
      const firstRemaining = all[0]!.data?.i as number;
      assert.ok(firstRemaining >= 500, `expected >= 500, got ${firstRemaining}`);
    } finally {
      await runtime.close();
    }
  });
});

describe('introspect diagnostics section', () => {
  /**
   * An app config whose introspect allowlist includes the diagnostics
   * section, with an extension that records `entries` into the service the
   * plugin provides (the runner orders the plugin first).
   */
  function configWithDiagnostics(
    entries: readonly Parameters<Diagnostics['record']>[0][],
  ): JsailsAppConfig {
    const seed: JsailsExtension = {
      name: 'seed',
      requires: [diagnosticsToken],
      setup({ services }) {
        const diagnostics = services.get(diagnosticsToken);
        for (const entry of entries) diagnostics.record(entry);
      },
    };
    return {
      rootDir: '.',
      pages: 'pages',
      public: 'public',
      out: 'out',
      port: 0,
      introspect: { enabled: true, authorize: () => true, sections: ['diagnostics'] },
      extensions: [seed, diagnosticsPlugin()],
    };
  }

  it('reports the recorder stats with the documented shape', async (t) => {
    const config = configWithDiagnostics([
      { type: 'http', durationMs: 42, data: { status: 'success' } },
      { type: 'query', durationMs: 12 },
    ]);
    const app = await createTestApp({ config, lifecycle: t });
    const res = await app.request('/_jsails/introspect?section=diagnostics');
    assert.equal(res.status, 200);
    const body = await res.json();
    const section = body.sections.diagnostics;
    assert.equal(section.status, 'ok');
    assert.equal(section.data.total, 2);
    assert.equal(section.data.withDuration, 2);
    assert.deepEqual(section.data.byType, { http: 1, query: 1 });
  });

  it('never serializes the raw entries', async (t) => {
    const config = configWithDiagnostics([
      { type: 'http', durationMs: 10, data: { route: '/secret' } },
    ]);
    const app = await createTestApp({ config, lifecycle: t });
    const res = await app.request('/_jsails/introspect?section=diagnostics');
    const text = await res.text();
    assert.ok(!text.includes('"entries"'));
    assert.ok(!text.includes('/secret'));
  });
});
