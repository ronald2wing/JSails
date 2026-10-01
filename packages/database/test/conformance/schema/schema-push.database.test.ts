/**
 * The schema push on the run's driver (SQLite in the default suite, MariaDB
 * and PostgreSQL in the database suite's legs):
 *
 * - every portable type and index form pushes into an empty database and
 *   introspects back to an empty plan, MariaDB's foreign key with its own
 *   index included;
 * - a second declaration reconciles column, index and key changes, with
 *   blocking and destructive work deferred until approved;
 * - a table nobody owns (hand-created) or another owner owns (a plugin, even
 *   one removed from plugins.use) is never planned for a drop or a change,
 *   and does not block anything;
 * - approving one drop applies that drop and no other, and a digest that no
 *   longer matches the plan refuses the whole push;
 * - an index replaced under its name, and a foreign key dropped so the
 *   columns it joins can change type, are never dropped while what replaces
 *   them waits;
 * - a complete push records the declared digest, which the boot check
 *   compares: production refuses an unpushed database.
 */

import assert from 'node:assert/strict';
import { it } from 'node:test';

import { createEngine, type DatabaseConfig, type Engine } from '../../../src/engine/index.js';
import type { ModelTarget } from '../../../src/model/index.js';
import {
  diffSchema,
  introspect,
  pushSchema,
  SchemaErrors,
  verifySchema,
  type LiveTable,
  type PushReport,
} from '../../../src/schema/index.js';
import { forEachDriver, lastInFirstOut } from '../../../src/testing/index.js';
import { exec, matrixEngineConfig } from '../engine/fixtures/matrix-engine.js';
import {
  CATALOG,
  CatalogTypes,
  MembersV1,
  MembersV2,
  NotesV1,
  NotesV2,
  PlayersV1,
  PlayersV2,
  Scratch,
  Scratch2,
  TeamV1,
  TeamV2,
} from './fixtures/schema-models.js';

type Lifecycle = Parameters<typeof matrixEngineConfig>[0];

/** A fresh database; engines opened on it close before it is removed. */
interface Fresh {
  readonly config: DatabaseConfig;
  open(): Promise<Engine>;
}

async function freshDatabase(t: Lifecycle): Promise<Fresh> {
  const ordered = lastInFirstOut(t);
  const config = await matrixEngineConfig(ordered);
  return {
    config,
    async open() {
      const engine = await createEngine(config);
      ordered.after(() => engine.close());
      return engine;
    },
  };
}

function push(
  config: DatabaseConfig,
  models: readonly ModelTarget[],
  approve: readonly string[] | 'all' = [],
): Promise<PushReport> {
  return pushSchema({ config, models }, { approve, environment: 'development' });
}

async function liveTables(engine: Engine): Promise<readonly LiveTable[]> {
  const conn = await engine.lease();
  try {
    return (await introspect(conn, engine.dialect)).tables;
  } finally {
    await conn.release();
  }
}

async function liveTableNames(engine: Engine): Promise<string[]> {
  return (await liveTables(engine)).map((table) => table.name);
}

async function liveTable(engine: Engine, name: string): Promise<LiveTable> {
  const table = (await liveTables(engine)).find((candidate) => candidate.name === name);
  assert.ok(table !== undefined, `${name} exists`);
  return table;
}

forEachDriver('schema push', () => {
  it('pushes every portable type and index form and introspects back to an empty plan', async (t) => {
    const { config } = await freshDatabase(t);
    const report = await push(config, CATALOG);
    assert.equal(report.complete, true);
    assert.deepEqual(report.deferred, []);
    assert.ok(report.applied.every((op) => op.classification === 'safe'));

    const plan = await diffSchema({ config, models: CATALOG });
    assert.deepEqual(
      plan.operations.map((op) => op.summary),
      [],
      'a pushed schema re-introspects to an empty plan',
    );
    assert.deepEqual(plan.unmanaged, []);

    const again = await push(config, CATALOG);
    assert.deepEqual(again.applied, [], 'a second push has nothing to do');
    assert.equal(again.complete, true);
  });

  it('reconciles a changed declaration and defers what needs approval', async (t) => {
    const { config, open } = await freshDatabase(t);
    const engine = await open();
    await push(config, [NotesV1]);
    await exec(
      engine,
      "INSERT INTO catalog_notes (title, body, legacy, priority) VALUES ('a', 'b', 1, 2)",
    );

    const plan = await diffSchema({ config, models: [NotesV2] });
    const unsafe = plan.operations.filter((op) => op.classification !== 'safe');
    assert.ok(unsafe.length > 0, 'a narrowing-free change still has blocking work');
    assert.ok(
      plan.operations.some((op) => op.classification === 'destructive'),
      'dropping a column is destructive',
    );
    if (engine.dialect !== 'sqlite') {
      assert.deepEqual(
        plan.operations
          .filter((op) => op.classification === 'destructive')
          .map((op) => op.operation.kind),
        ['drop_column'],
        'widening a column keeps its values, so only the dropped column loses data',
      );
    }

    const partial = await push(config, [NotesV2]);
    assert.equal(partial.complete, false);
    assert.deepEqual(
      partial.deferred.map((op) => op.digest).sort(),
      unsafe.map((op) => op.digest).sort(),
      'exactly the blocking and destructive work waits',
    );
    assert.ok(partial.applied.every((op) => op.classification === 'safe'));

    const complete = await push(config, [NotesV2], 'all');
    assert.equal(complete.complete, true);
    const after = await diffSchema({ config, models: [NotesV2] });
    assert.deepEqual(
      after.operations.map((op) => op.summary),
      [],
    );

    const conn = await engine.lease();
    try {
      const { rows } = await conn.query('SELECT title, body FROM catalog_notes');
      assert.deepEqual(
        rows.map((row) => [row.title, row.body]),
        [['a', 'b']],
        'the change keeps the rows',
      );
    } finally {
      await conn.release();
    }
  });

  it('never plans a change to a table nobody owns', async (t) => {
    const { config, open } = await freshDatabase(t);
    const engine = await open();
    await exec(engine, 'CREATE TABLE hand_made (id INTEGER PRIMARY KEY, note VARCHAR(20))');
    const first = await push(config, [NotesV1]);
    assert.deepEqual(first.unmanaged, ['hand_made'], 'an unmanaged table is reported');

    const plan = await diffSchema({ config, models: [NotesV1] });
    assert.deepEqual(plan.operations, []);
    assert.deepEqual(plan.unmanaged, ['hand_made']);

    const later = await push(config, [NotesV1], 'all');
    assert.deepEqual(later.applied, [], 'approving everything still leaves it alone');
    assert.deepEqual(later.unmanaged, [], 'and it is reported once');
    assert.ok((await liveTableNames(engine)).includes('hand_made'));
  });

  it('applies safe work beside an owned table that is no longer declared', async (t) => {
    const { config, open } = await freshDatabase(t);
    const engine = await open();
    await push(config, [NotesV1, Scratch]);

    // The audit's "all-or-nothing" gate: one stray drop must not block a safe change.
    const report = await push(config, [NotesV1, Scratch2]);
    assert.deepEqual(
      report.applied.map((op) => op.summary),
      ['create table catalog_scratch2'],
    );
    assert.deepEqual(
      report.deferred.map((op) => op.summary),
      ['drop table catalog_scratch'],
    );
    assert.equal(report.complete, false);
    assert.ok((await liveTableNames(engine)).includes('catalog_scratch'));
  });

  it('adopts a matching unowned table without approval', async (t) => {
    const { config, open } = await freshDatabase(t);
    const first = await push(config, [Scratch]);
    assert.equal(first.complete, true);
    const engine = await open();
    await exec(engine, 'DELETE FROM jsails_schema_objects');

    const plan = await diffSchema({ config, models: [Scratch] });
    assert.deepEqual(
      plan.operations.map((op) => [op.operation.kind, op.classification]),
      [['adopt_table', 'safe']],
    );
    const report = await push(config, [Scratch]);
    assert.equal(report.complete, true);
  });

  it('applies only the approved drop, and refuses a stale approval', async (t) => {
    const { config, open } = await freshDatabase(t);
    const engine = await open();
    await push(config, [NotesV1, Scratch, Scratch2]);

    const plan = await diffSchema({ config, models: [NotesV1] });
    const drops = plan.operations.filter((op) => op.operation.kind === 'drop_table');
    assert.equal(drops.length, 2);
    const [first, second] = drops as [(typeof drops)[0], (typeof drops)[0]];

    const report = await push(config, [NotesV1], [first.digest]);
    assert.deepEqual(
      report.applied.map((op) => op.digest),
      [first.digest],
    );
    assert.deepEqual(
      report.deferred.map((op) => op.digest),
      [second.digest],
    );
    const tables = await liveTableNames(engine);
    const dropped = first.operation.kind === 'drop_table' ? first.operation.table : '';
    const kept = second.operation.kind === 'drop_table' ? second.operation.table : '';
    assert.ok(!tables.includes(dropped));
    assert.ok(tables.includes(kept), 'approving one drop does not apply another');

    // The table the second digest describes changes: its approval is stale.
    await exec(engine, `INSERT INTO ${kept} (value) VALUES (1)`);
    await exec(engine, `ALTER TABLE ${kept} ADD COLUMN extra INTEGER`);
    await assert.rejects(push(config, [NotesV1], [second.digest]), (error: unknown) =>
      SchemaErrors.is(error, 'stale_approval'),
    );
    assert.ok((await liveTableNames(engine)).includes(kept), 'a refused push changes nothing');
    await assert.rejects(
      push(config, [NotesV1], [first.digest]),
      (error: unknown) => SchemaErrors.is(error, 'stale_approval'),
      'an applied digest is stale too',
    );
  });

  it('drops an index replaced under its name only together with its replacement', async (t) => {
    const { config, open } = await freshDatabase(t);
    const engine = await open();
    await push(config, [MembersV1]);
    await exec(engine, "INSERT INTO catalog_members (email, team) VALUES ('a@example.test', 'x')");
    const login = async (): Promise<unknown> => {
      const index = (await liveTable(engine, 'catalog_members')).indexes.find(
        (candidate) => candidate.name === 'catalog_members_login',
      );
      return index === undefined ? undefined : [index.unique, index.columns];
    };

    const plan = await diffSchema({ config, models: [MembersV2] });
    const drop = plan.operations.find((op) => op.operation.kind === 'drop_index');
    const creation = plan.operations.find((op) => op.operation.kind === 'create_index');
    assert.ok(drop !== undefined && creation !== undefined);
    assert.deepEqual(drop.appliesWith, [creation.digest]);
    assert.deepEqual(creation.appliesWith, [drop.digest]);

    const partial = await push(config, [MembersV2], [drop.digest]);
    assert.deepEqual(partial.applied, [], 'approving the drop alone applies nothing');
    assert.deepEqual(
      partial.deferred.map((op) => [op.digest, op.reason]),
      [
        [drop.digest, 'dependency'],
        [creation.digest, 'approval'],
      ],
    );
    assert.deepEqual(await login(), [true, ['email']], 'the unique index stays');

    const complete = await push(config, [MembersV2], [drop.digest, creation.digest]);
    assert.equal(complete.complete, true);
    assert.deepEqual(await login(), [true, ['email', 'team']]);
  });

  it('drops a foreign key for a type change only together with the change and its re-addition', async (t) => {
    const { config, open } = await freshDatabase(t);
    const engine = await open();
    await push(config, [TeamV1, PlayersV1]);
    await exec(
      engine,
      'INSERT INTO catalog_teams (code) VALUES (1)',
      'INSERT INTO catalog_players (team_code) VALUES (1)',
    );
    const keys = async (): Promise<unknown> =>
      (await liveTable(engine, 'catalog_players')).foreignKeys.map((key) => [
        key.name,
        key.columns,
        key.referencedTable,
        key.referencedColumns,
      ]);
    const before = await keys();
    assert.equal((before as unknown[]).length, 1);

    const unapproved = await push(config, [TeamV2, PlayersV2]);
    assert.deepEqual(
      unapproved.applied.map((op) => op.summary),
      [],
      'nothing applies while the type changes wait',
    );
    assert.deepEqual(await keys(), before, 'the foreign key stays');

    const plan = await diffSchema({ config, models: [TeamV2, PlayersV2] });
    const unsafe = plan.operations.filter((op) => op.classification !== 'safe');
    const complete = await push(
      config,
      [TeamV2, PlayersV2],
      unsafe.map((op) => op.digest),
    );
    assert.equal(complete.complete, true);
    assert.deepEqual(await keys(), before, 'and is back after the change');
    const after = await diffSchema({ config, models: [TeamV2, PlayersV2] });
    assert.deepEqual(
      after.operations.map((op) => op.summary),
      [],
    );
  });

  it('refuses a table another owner owns', async (t) => {
    const { config } = await freshDatabase(t);
    await pushSchema({ config, models: [Scratch] }, { owner: 'plugin:notes' });
    await assert.rejects(push(config, [Scratch]), (error: unknown) =>
      SchemaErrors.is(error, 'owned_by_another'),
    );
    const other = await pushSchema({ config, models: [NotesV1] }, { owner: 'app' });
    assert.ok(
      other.deferred.length === 0 && other.unmanaged.length === 0,
      "another owner's table is neither dropped nor unmanaged",
    );
  });

  it("leaves a removed plugin's tables alone, without blocking the app's push", async (t) => {
    const { config, open } = await freshDatabase(t);
    // The plugin pushed its table under its own owner, then left plugins.use.
    await pushSchema({ config, models: [Scratch] }, { owner: 'plugin:notes' });
    const report = await push(config, [NotesV1], 'all');
    assert.equal(report.complete, true, "nothing destructive of the app's own: not blocked");
    assert.deepEqual(
      report.applied.map((op) => op.operation.kind),
      ['create_table'],
    );
    assert.deepEqual(report.unmanaged, []);
    assert.ok(
      (await liveTableNames(await open())).includes('catalog_scratch'),
      "approving everything of the app's own does not drop a plugin's table",
    );
  });

  it('accepts --approve-all only in development and test', async (t) => {
    const { config } = await freshDatabase(t);
    await assert.rejects(
      pushSchema({ config, models: [Scratch] }, { approve: 'all', environment: 'production' }),
      (error: unknown) => SchemaErrors.is(error, 'approve_all_refused'),
    );
  });

  it('records the declared digest, which the boot check compares', async (t) => {
    const { config, open } = await freshDatabase(t);
    const engine = await open();

    await assert.rejects(
      verifySchema(engine, CATALOG, { environment: 'production' }),
      (error: unknown) => SchemaErrors.is(error, 'schema_out_of_date'),
      'an app booted against an unpushed database fails in production',
    );
    const pending = await verifySchema(engine, CATALOG, { environment: 'development' });
    assert.equal(pending.status, 'pending');
    assert.ok(pending.status === 'pending' && pending.plan.operations.length > 0);

    const report = await push(config, CATALOG);
    assert.equal(typeof report.digest, 'string');
    const current = await verifySchema(engine, CATALOG, { environment: 'production' });
    assert.deepEqual(current, { status: 'current', digest: report.digest });

    await assert.rejects(
      verifySchema(engine, [...CATALOG, Scratch], { environment: 'production' }),
      (error: unknown) => SchemaErrors.is(error, 'schema_out_of_date'),
      'code that declares more than was pushed fails in production',
    );
    await assert.rejects(
      verifySchema(engine, [CatalogTypes], { environment: 'production' }),
      (error: unknown) => SchemaErrors.is(error, 'schema_out_of_date'),
    );
  });
});
