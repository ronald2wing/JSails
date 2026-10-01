/**
 * The `database()` plugin: its data source is a substrate resource under
 * `databaseToken`, registered before any setup and owned by the kernel.
 * Declaring it resolves the configuration (from the options, the declared
 * `DATABASE_*` variables and the application root only) and binds nothing;
 * the first `get()` constructs the data source, binding the models and
 * connecting nothing; the kernel closes it after the last cleanup, which
 * unbinds them. A malformed connection fails before any setup, its option
 * schema is data only, and invalid options are refused echoing no input.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runExtensions } from 'jsails/extensions';
import { checkOptionSchema, ConfigErrors, definePlugin } from 'jsails/kernel';
import { testPlugin } from 'jsails/testing';

import { database, databaseToken, JsailsDataSource } from '../../src/index.js';
import { unguarded } from '../../src/unguarded/index.js';
import { Author, MODELS, Post } from '../query/fixtures/query-models.js';

describe('database()', () => {
  it('declares the data source as a substrate resource that binds its models when opened', async () => {
    const run = await testPlugin(database({ file: ':memory:', models: () => MODELS }));
    const handle = run.services.get(databaseToken);
    let dataSource: JsailsDataSource;
    try {
      assert.deepEqual(run.substrate, [databaseToken]);
      assert.deepEqual(run.provided, []);
      assert.throws(() => Post.all(), { code: 'data_source.not_bound' });
      dataSource = await handle.get();
      assert.equal(await handle.get(), dataSource);
      assert.ok(dataSource instanceof JsailsDataSource);
      assert.equal(dataSource.dialect, 'sqlite');
      assert.deepEqual(dataSource.models, MODELS);
      assert.doesNotThrow(() => Post.all());
    } finally {
      await run.close();
    }
    assert.equal(handle.closed, true);
    assert.equal(dataSource.closed, true);
    assert.throws(() => Author.all(), { code: 'data_source.not_bound' });
  });

  it('is reachable before every setup and closed by the kernel after every cleanup', async () => {
    const events: string[] = [];
    const reader = definePlugin({
      name: 'reader',
      requires: [databaseToken],
      setup({ services }) {
        const handle = services.get(databaseToken);
        events.push(`setup reader, open: ${String(!handle.closed)}`);
        return async () => {
          const dataSource = await handle.get();
          events.push(`cleanup reader, bound: ${String(dataSource.models.includes(Author))}`);
        };
      },
    });
    const runtime = await runExtensions(
      [reader(), database({ file: ':memory:', models: () => [Author] })],
      { rootDir: tmpdir() },
    );
    const dataSource = await runtime.services.get(databaseToken).get();
    assert.doesNotThrow(() => Author.all());
    await runtime.close();
    assert.equal(dataSource.closed, true);
    assert.throws(() => Author.all(), { code: 'data_source.not_bound' });
    assert.deepEqual(events, ['setup reader, open: true', 'cleanup reader, bound: true']);
  });

  it('resolves a relative SQLite file against the application root', async () => {
    const base = mkdtempSync(join(tmpdir(), 'jsails-db-plugin-'));
    try {
      // The root is reached through a link, as on macOS, where the temporary
      // directory lies under /var -> /private/var: SQLite may report either
      // spelling of the file, so the two are compared resolved.
      const real = join(base, 'real');
      mkdirSync(real);
      const root = join(base, 'link');
      symlinkSync(real, root, 'junction');
      const run = await testPlugin(database({ file: 'app.sqlite', models: () => [Author] }), {
        rootDir: root,
      });
      try {
        const raw = unguarded(await run.services.get(databaseToken).get());
        const { rows } = await raw.sql`PRAGMA database_list`;
        const file = rows.find((row) => row['name'] === 'main')?.['file'];
        assert.equal(typeof file, 'string');
        assert.equal(realpathSync(file as string), realpathSync(join(root, 'app.sqlite')));
      } finally {
        await run.close();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reads the connection from DATABASE_URL and DATABASE_PASSWORD, and nothing else', async () => {
    const run = await testPlugin(
      database({ dialect: 'postgres', host: 'options.invalid', models: () => [Author] }),
      {
        env: {
          DATABASE_URL: 'postgres://app@db.invalid:5433/app',
          DATABASE_PASSWORD: 'pw',
          JSAILS_DATABASE_URL: 'postgres://ignored@ignored.invalid/ignored',
        },
      },
    );
    try {
      const dataSource = await run.services.get(databaseToken).get();
      assert.equal(dataSource.dialect, 'postgres');
    } finally {
      await run.close();
    }
  });

  it('refuses a malformed connection before any setup, echoing no value', async () => {
    const SECRET = 'zz-secret-url';
    let setups = 0;
    const later = definePlugin({
      name: 'later',
      setup() {
        setups += 1;
      },
    });
    await assert.rejects(
      runExtensions([later(), database({ models: () => [Author] })], {
        rootDir: tmpdir(),
        env: { DATABASE_URL: `ftp://${SECRET}` },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'invalid_config');
        assert.ok(!`${String(error)}${JSON.stringify(error)}`.includes(SECRET));
        return true;
      },
    );
    assert.equal(setups, 0);
    assert.throws(() => Author.all(), { code: 'data_source.not_bound' });
  });

  it('has an options schema of data only', () => {
    assert.deepEqual(checkOptionSchema(database.definition.options!), []);
  });

  const SECRET = 'zz-secret-input';
  const cases: readonly { readonly name: string; readonly input: unknown }[] = [
    { name: 'a non-object', input: SECRET },
    { name: 'missing models', input: { file: SECRET } },
    { name: 'an unknown option', input: { [SECRET]: 1, models: () => [] } },
    { name: 'a password option', input: { password: SECRET, models: () => [] } },
    { name: 'a mistyped port', input: { port: SECRET, models: () => [] } },
  ];
  for (const { name, input } of cases) {
    it(`refuses ${name} with config.invalid_options, echoing no input`, () => {
      const factory = database as unknown as (input: unknown) => unknown;
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
