/**
 * The built-in `db:push`/`db:diff` commands on a database config module
 * that default-exports a branded schema config (what `defineSchemaConfig`
 * from `@jsails/database` returns): the commands it carries receive the
 * parsed flags and the config path, their exit status is the command's,
 * the TypeORM path's flags are refused on it, the schema path's flags are
 * refused on a `JsailsDataSource` config, and the schema flags are refused on
 * every other command.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runCli } from '../../../src/cli/index.js';
import { schemaCommandTable } from '../../../src/cli/config-loader.js';

interface Recorded {
  readonly command: string;
  readonly flags: Record<string, unknown>;
  readonly configPath: string;
}

const RECORD = Symbol.for('jsails.test.schema-config-record');

function recorded(): Recorded[] {
  const holder = globalThis as unknown as Record<symbol, Recorded[] | undefined>;
  holder[RECORD] ??= [];
  return holder[RECORD];
}

/** A config module whose commands record their call and exit with `status`. */
function schemaConfigModule(t: { after(callback: () => unknown): void }, status: number): string {
  const directory = mkdtempSync(join(tmpdir(), 'jsails-schema-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'jsails.database.js');
  writeFileSync(
    path,
    `const record = (command) => async (flags, io) => {
  globalThis[Symbol.for('jsails.test.schema-config-record')].push({ command, flags, configPath: io.configPath });
  return ${status};
};
export default {
  [Symbol.for('jsails.database.schema-config')]: { 'db:push': record('db:push'), 'db:diff': record('db:diff') },
};
`,
  );
  return path;
}

describe('db:push and db:diff on a schema config', () => {
  it('recognizes only a complete command table', () => {
    const brand = Symbol.for('jsails.database.schema-config');
    const run = async () => 0;
    assert.ok(schemaCommandTable({ [brand]: { 'db:push': run, 'db:diff': run } }));
    assert.equal(schemaCommandTable({ [brand]: { 'db:push': run } }), undefined);
    assert.equal(schemaCommandTable({}), undefined);
    assert.equal(schemaCommandTable(null), undefined);
  });

  it('hands db:push its flags and returns the command status', async (t) => {
    const path = schemaConfigModule(t, 3);
    const calls = recorded();
    calls.length = 0;
    const status = await runCli([
      'db:push',
      '--config',
      path,
      '--approve',
      '0123456789abcdef',
      '--approve',
      'fedcba9876543210',
      '--wait-lock',
      '5',
      '--json',
    ]);
    assert.equal(status, 3);
    assert.deepEqual(calls, [
      {
        command: 'db:push',
        flags: {
          approve: ['0123456789abcdef', 'fedcba9876543210'],
          approveAll: false,
          json: true,
          waitLock: '5',
        },
        configPath: path,
      },
    ]);
  });

  it('hands db:diff its flags', async (t) => {
    const path = schemaConfigModule(t, 0);
    const calls = recorded();
    calls.length = 0;
    assert.equal(await runCli(['db:diff', '--config', path]), 0);
    assert.deepEqual(calls, [{ command: 'db:diff', flags: { json: false }, configPath: path }]);
  });

  it("refuses the TypeORM path's flags", async (t) => {
    const path = schemaConfigModule(t, 0);
    const calls = recorded();
    calls.length = 0;
    assert.equal(await runCli(['db:push', '--config', path, '--dry-run']), 2);
    assert.equal(await runCli(['db:push', '--config', path, '--allow-destructive']), 2);
    assert.equal(await runCli(['db:diff', '--config', path, '--sql']), 2);
    assert.deepEqual(calls, [], 'no command ran');
  });

  it('refuses the schema flags on other commands', async () => {
    assert.equal(await runCli(['db:diff', '--approve', '0123456789abcdef']), 2);
    assert.equal(await runCli(['db:diff', '--approve-all']), 2);
    assert.equal(await runCli(['seed', '--wait-lock', '1']), 2);
  });
});
