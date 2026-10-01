/**
 * `defineSchemaConfig` and the `db:push`/`db:diff` command modules it
 * carries, on a SQLite file beside the config module: the brand core
 * dispatches on, the printed plan with its approval digests (after a push,
 * every deferred digest the next push must approve), exit 0 for a
 * complete push and 3 for one that deferred work, JSON output, the
 * environment gate on `--approve-all`, and flag validation.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFERRED_EXIT_CODE,
  defineSchemaConfig,
  SCHEMA_CONFIG,
  type SchemaCommandIo,
  type SchemaConfig,
} from '../../src/cli/index.js';
import { column, defineTable } from '../../src/model/index.js';
import { SchemaErrors } from '../../src/schema/index.js';

const Kept = defineTable({ table: 'cli_kept', columns: { name: column.string(20) } });
const Dropped = defineTable({ table: 'cli_dropped', columns: { name: column.string(20) } });
const LoginByEmail = defineTable({
  table: 'cli_logins',
  columns: { email: column.string(40), team: column.string(20) },
  indexes: [{ columns: ['email'], unique: true, name: 'cli_logins_login' }],
});
const LoginByTeam = defineTable({
  table: 'cli_logins',
  columns: { email: column.string(40), team: column.string(20) },
  indexes: [{ columns: ['email', 'team'], unique: true, name: 'cli_logins_login' }],
});

function project(t: { after(callback: () => unknown): void }): string {
  const directory = mkdtempSync(join(tmpdir(), 'jsails-schema-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function terminal(
  directory: string,
  env: Record<string, string> = {},
): SchemaCommandIo & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    configPath: join(directory, 'jsails.database.js'),
    env,
    stdout: (line) => lines.push(line),
  };
}

function config(models: SchemaConfig['models']): SchemaConfig {
  // Relative to the config module's directory.
  return defineSchemaConfig({ database: { file: 'app.sqlite' }, models });
}

describe('defineSchemaConfig', () => {
  it('brands the config with its command table under the global symbol', () => {
    const schema = config([Kept]);
    assert.equal(SCHEMA_CONFIG, Symbol.for('jsails.database.schema-config'));
    assert.equal(typeof schema[SCHEMA_CONFIG]['db:push'], 'function');
    assert.equal(typeof schema[SCHEMA_CONFIG]['db:diff'], 'function');
    assert.deepEqual(Object.keys(schema), ['database', 'models', 'owner']);
    assert.ok(Object.isFrozen(schema));
  });

  it('refuses a config without models', () => {
    assert.throws(
      () => defineSchemaConfig({} as never),
      (error: unknown) => SchemaErrors.is(error, 'invalid_config_module'),
    );
  });
});

describe('db:push and db:diff', () => {
  it('prints the plan, pushes it, and defers a drop until it is approved', async (t) => {
    const directory = project(t);
    const first = terminal(directory);
    assert.equal(
      await config([Kept, Dropped])[SCHEMA_CONFIG]['db:diff']({ json: false }, first),
      0,
    );
    assert.match(first.lines.join('\n'), /create table cli_dropped/);

    const push = terminal(directory);
    assert.equal(
      await config([Kept, Dropped])[SCHEMA_CONFIG]['db:push'](
        { approve: [], approveAll: false, json: false },
        push,
      ),
      0,
    );
    assert.match(push.lines.join('\n'), /is up to date/);

    const diff = terminal(directory);
    await config([Kept])[SCHEMA_CONFIG]['db:diff']({ json: true }, diff);
    const plan = JSON.parse(diff.lines.join('\n')) as {
      operations: { digest: string; classification: string; summary: string }[];
    };
    assert.deepEqual(
      plan.operations.map((op) => [op.classification, op.summary]),
      [['destructive', 'drop table cli_dropped']],
    );
    const digest = plan.operations[0]?.digest ?? '';

    const deferred = terminal(directory);
    assert.equal(
      await config([Kept])[SCHEMA_CONFIG]['db:push'](
        { approve: [], approveAll: false, json: false },
        deferred,
      ),
      DEFERRED_EXIT_CODE,
    );
    assert.match(deferred.lines.join('\n'), new RegExp(`--approve ${digest}`));

    const approved = terminal(directory);
    assert.equal(
      await config([Kept])[SCHEMA_CONFIG]['db:push'](
        { approve: [digest], approveAll: false, json: true },
        approved,
      ),
      0,
    );
    const report = JSON.parse(approved.lines.join('\n')) as { complete: boolean };
    assert.equal(report.complete, true);
  });

  it('asks again for an approved operation that waited with its unit', async (t) => {
    const directory = project(t);
    await config([LoginByEmail])[SCHEMA_CONFIG]['db:push'](
      { approve: [], approveAll: true, json: false },
      terminal(directory),
    );
    const diff = terminal(directory);
    await config([LoginByTeam])[SCHEMA_CONFIG]['db:diff']({ json: true }, diff);
    const plan = JSON.parse(diff.lines.join('\n')) as {
      operations: { digest: string; operation: { kind: string } }[];
    };
    const digestOf = (kind: string): string =>
      plan.operations.find((op) => op.operation.kind === kind)?.digest ?? '';
    const drop = digestOf('drop_index');
    const creation = digestOf('create_index');

    const partial = terminal(directory);
    assert.equal(
      await config([LoginByTeam])[SCHEMA_CONFIG]['db:push'](
        { approve: [drop], approveAll: false, json: false },
        partial,
      ),
      DEFERRED_EXIT_CODE,
    );
    const hint = partial.lines.find((line) => line.startsWith('Approve with:'));
    assert.equal(hint, `Approve with: jsails db:push --approve ${drop} --approve ${creation}`);

    assert.equal(
      await config([LoginByTeam])[SCHEMA_CONFIG]['db:push'](
        { approve: [drop, creation], approveAll: false, json: false },
        terminal(directory),
      ),
      0,
      'the printed approvals complete the push',
    );
  });

  it('accepts --approve-all only in development and test', async (t) => {
    const directory = project(t);
    await assert.rejects(
      config([Kept])[SCHEMA_CONFIG]['db:push'](
        { approve: [], approveAll: true, json: false },
        terminal(directory, { JSAILS_ENV: 'production' }),
      ),
      (error: unknown) => SchemaErrors.is(error, 'approve_all_refused'),
    );
    assert.equal(
      await config([Kept])[SCHEMA_CONFIG]['db:push'](
        { approve: [], approveAll: true, json: false },
        terminal(directory),
      ),
      0,
      'an unset JSAILS_ENV is development',
    );
  });

  it('refuses a malformed --wait-lock', async (t) => {
    const directory = project(t);
    for (const waitLock of ['', 'soon', '-1', '1e3']) {
      await assert.rejects(
        config([Kept])[SCHEMA_CONFIG]['db:push'](
          { approve: [], approveAll: false, json: false, waitLock },
          terminal(directory),
        ),
        (error: unknown) => SchemaErrors.is(error, 'invalid_options'),
      );
    }
  });
});
