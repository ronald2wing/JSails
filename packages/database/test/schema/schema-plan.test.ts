/**
 * The planner and its pieces, offline: ownership decides what may be
 * dropped or changed, each operation's classification and digest, the
 * digest's binding to the live table it describes, the units of operations
 * that apply whole or not at all and what a push defers, type widening, default
 * comparison across server spellings, the test-database name rule, and
 * push option validation before any connection opens.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveDatabaseConfig, type Dialect } from '../../src/engine/index.js';
import { column, defineModel, defineTable, type TableState } from '../../src/model/index.js';
import { canonicalJson } from '../../src/schema/canonical-json.js';
import { parseLiveDefault, sameDefault } from '../../src/schema/column-default.js';
import { declaredTables } from '../../src/schema/declared-tables.js';
import {
  isTestDatabaseName,
  planSchema,
  pushSchema,
  SchemaErrors,
  type LiveTable,
  type PlannedOperation,
  type SchemaOperationKind,
  type SchemaState,
} from '../../src/schema/index.js';
import { isWidening, planDeferrals } from '../../src/schema/schema-plan.js';

const DIALECTS: readonly Dialect[] = ['postgres', 'mariadb', 'sqlite'];

const Items = defineTable({
  table: 'plan_items',
  columns: { name: column.string(40) },
});

function liveTable(name: string, extra: Partial<LiveTable> = {}): LiveTable {
  return {
    name,
    columns: [{ name: 'id', type: 'integer', nullable: false, identity: true }],
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: [],
    ...extra,
  };
}

function state(dialect: Dialect, tables: readonly LiveTable[]): SchemaState {
  return { dialect, tables };
}

/** The live table a push of `table` leaves, for declarations without defaults. */
function liveOf(table: TableState): LiveTable {
  return {
    name: table.name,
    columns: table.columns.map((declared) => ({
      name: declared.name,
      type: declared.type,
      nullable: declared.nullable,
      identity: declared.identity,
      ...(declared.collation === undefined ? {} : { collation: declared.collation }),
      ...(declared.check === undefined ? {} : { check: declared.check }),
    })),
    primaryKey: table.primaryKey,
    indexes: table.indexes.map((index) => ({
      name: index.name,
      columns: index.columns,
      unique: index.unique,
      valid: true,
      partial: false,
      constraint: false,
    })),
    foreignKeys: table.foreignKeys.map((key) => ({
      name: key.name,
      columns: key.columns,
      referencedTable: key.referencedTable,
      referencedColumns: key.referencedColumns,
      onDelete: key.onDelete,
    })),
  };
}

/** The plan from `before`, as pushed, to `after`, all owned by the app. */
function change(dialect: Dialect, before: readonly TableState[], after: readonly TableState[]) {
  return planSchema({
    dialect,
    owner: 'app',
    declared: after,
    live: state(dialect, before.map(liveOf)),
    ownership: new Map(before.map((table) => [table.name, 'app'])),
  });
}

function only(
  operations: readonly PlannedOperation[],
  kind: SchemaOperationKind,
): PlannedOperation {
  const matching = operations.filter((op) => op.operation.kind === kind);
  assert.equal(matching.length, 1, `one ${kind}`);
  return matching[0] as PlannedOperation;
}

/** What `planDeferrals` defers when exactly `approved` is approved, by digest. */
function deferrals(
  operations: readonly PlannedOperation[],
  approved: readonly PlannedOperation[],
): [string, string][] {
  const digests = new Set(approved.map((op) => op.digest));
  const deferred = planDeferrals(operations, (digest) => digests.has(digest));
  return operations.flatMap((op): [string, string][] => {
    const reason = deferred.get(op.digest);
    return reason === undefined ? [] : [[op.operation.kind, reason]];
  });
}

const SERVERS: readonly Dialect[] = ['postgres', 'mariadb'];

class TeamV1 {}
class TeamV2 {}
defineModel(TeamV1, {
  table: 'plan_teams',
  primaryKey: ['code'],
  columns: { code: column.integer() },
});
defineModel(TeamV2, {
  table: 'plan_teams',
  primaryKey: ['code'],
  columns: { code: column.bigint() },
});
const PlayersV1 = defineTable({
  table: 'plan_players',
  columns: { teamCode: column.integer() },
  relations: { team: { kind: 'belongsTo', target: () => TeamV1, foreignKey: 'teamCode' } },
});
const PlayersV2 = defineTable({
  table: 'plan_players',
  columns: { teamCode: column.bigint() },
  relations: { team: { kind: 'belongsTo', target: () => TeamV2, foreignKey: 'teamCode' } },
});
const PlayersCascade = defineTable({
  table: 'plan_players',
  columns: { teamCode: column.integer() },
  relations: {
    team: { kind: 'belongsTo', target: () => TeamV1, foreignKey: 'teamCode', onDelete: 'cascade' },
  },
});
const MembersV1 = defineTable({
  table: 'plan_members',
  columns: { email: column.string(80) },
  indexes: [{ columns: ['email'], unique: true, name: 'plan_members_login' }],
});
const MembersV2 = defineTable({
  table: 'plan_members',
  columns: { email: column.string(80), tenantId: column.integer() },
  indexes: [{ columns: ['email', 'tenantId'], unique: true, name: 'plan_members_login' }],
});
const MembersRenamed = defineTable({
  table: 'plan_members',
  columns: { email: column.string(80) },
  indexes: [{ columns: ['email'], unique: true, name: 'plan_members_email_unique' }],
});

describe('planSchema', () => {
  it('creates a declared table that is missing, safely', () => {
    for (const dialect of DIALECTS) {
      const plan = planSchema({
        dialect,
        owner: 'app',
        declared: declaredTables([Items], dialect),
        live: state(dialect, []),
        ownership: new Map(),
      });
      assert.deepEqual(
        plan.operations.map((op) => [op.operation.kind, op.classification]),
        [['create_table', 'safe']],
      );
      assert.ok(plan.operations[0]?.statements.some((sql) => sql.startsWith('CREATE TABLE')));
    }
  });

  it('drops only an owned table, as a destructive operation, and leaves the rest unmanaged', () => {
    const plan = planSchema({
      dialect: 'postgres',
      owner: 'app',
      declared: [],
      live: state('postgres', [liveTable('mine'), liveTable('theirs'), liveTable('nobodys')]),
      ownership: new Map([
        ['mine', 'app'],
        ['theirs', 'plugin:other'],
      ]),
    });
    assert.deepEqual(
      plan.operations.map((op) => [op.operation.kind, op.classification]),
      [['drop_table', 'destructive']],
    );
    assert.match(plan.operations[0]?.digest ?? '', /^[0-9a-f]{16}$/);
    assert.deepEqual(plan.unmanaged, ['nobodys']);
  });

  it('binds a digest to the live table it describes', () => {
    const digestOf = (table: LiveTable): string | undefined =>
      planSchema({
        dialect: 'postgres',
        owner: 'app',
        declared: [],
        live: state('postgres', [table]),
        ownership: new Map([[table.name, 'app']]),
      }).operations[0]?.digest;
    const before = digestOf(liveTable('mine'));
    const after = digestOf(
      liveTable('mine', {
        columns: [
          { name: 'id', type: 'integer', nullable: false, identity: true },
          { name: 'added', type: 'integer', nullable: true, identity: false },
        ],
      }),
    );
    assert.equal(typeof before, 'string');
    assert.notEqual(before, after, 'a changed table invalidates its approval');
    assert.equal(before, digestOf(liveTable('mine')), 'and an unchanged one keeps it');
  });

  it('refuses to manage a table another owner owns', () => {
    assert.throws(
      () =>
        planSchema({
          dialect: 'sqlite',
          owner: 'app',
          declared: declaredTables([Items], 'sqlite'),
          live: state('sqlite', [liveTable('plan_items')]),
          ownership: new Map([['plan_items', 'plugin:other']]),
        }),
      (error: unknown) => SchemaErrors.is(error, 'owned_by_another'),
    );
  });
});

describe('plan units', () => {
  it('drops a foreign key for a type change only with the change and its re-addition', () => {
    for (const dialect of SERVERS) {
      const plan = change(
        dialect,
        declaredTables([TeamV1, PlayersV1], dialect),
        declaredTables([TeamV2, PlayersV2], dialect),
      );
      const ops = plan.operations;
      const drop = only(ops, 'drop_foreign_key');
      const addition = only(ops, 'add_foreign_key');
      const alters = ops.filter((op) => op.operation.kind === 'alter_column');
      assert.equal(alters.length, 2, `${dialect}: both sides of the key change type`);
      assert.deepEqual(
        [...drop.appliesWith].sort(),
        [addition, ...alters].map((op) => op.digest).sort(),
        dialect,
      );
      assert.deepEqual(
        deferrals(ops, []),
        [
          ['drop_foreign_key', 'dependency'],
          ['alter_column', 'approval'],
          ['alter_column', 'approval'],
          ['add_foreign_key', 'approval'],
        ],
        `${dialect}: an unapproved push keeps the key`,
      );
      assert.deepEqual(
        deferrals(ops, alters),
        [
          ['drop_foreign_key', 'dependency'],
          ['alter_column', 'dependency'],
          ['alter_column', 'dependency'],
          ['add_foreign_key', 'approval'],
        ],
        `${dialect}: approving the type changes without the re-addition keeps the key`,
      );
      assert.deepEqual(deferrals(ops, [...alters, addition]), [], dialect);
    }
  });

  it('drops a replaced index only with its replacement, and with what the replacement needs', () => {
    for (const dialect of SERVERS) {
      const ops = change(
        dialect,
        declaredTables([MembersV1], dialect),
        declaredTables([MembersV2], dialect),
      ).operations;
      const drop = only(ops, 'drop_index');
      const creation = only(ops, 'create_index');
      const addition = only(ops, 'add_column');
      assert.equal(drop.classification, 'blocking');
      assert.deepEqual(drop.appliesWith, [creation.digest], dialect);
      assert.deepEqual(creation.appliesWith, [drop.digest], dialect);
      assert.deepEqual(
        deferrals(ops, [drop]),
        [
          ['drop_index', 'dependency'],
          ['add_column', 'approval'],
          ['create_index', 'approval'],
        ],
        `${dialect}: approving the drop alone applies nothing`,
      );
      assert.deepEqual(
        deferrals(ops, [drop, creation]),
        [
          ['drop_index', 'dependency'],
          ['add_column', 'approval'],
          ['create_index', 'dependency'],
        ],
        `${dialect}: the drop waits for the column its replacement needs`,
      );
      assert.deepEqual(deferrals(ops, [drop, creation, addition]), [], dialect);
    }
  });

  it('drops a unique index renamed with the same columns only with its successor', () => {
    for (const dialect of DIALECTS) {
      const ops = change(
        dialect,
        declaredTables([MembersV1], dialect),
        declaredTables([MembersRenamed], dialect),
      ).operations;
      const drop = only(ops, 'drop_index');
      const creation = only(ops, 'create_index');
      assert.equal(drop.classification, 'safe');
      assert.deepEqual(drop.appliesWith, [creation.digest], dialect);
      assert.deepEqual(
        deferrals(ops, []),
        [
          ['create_index', 'approval'],
          ['drop_index', 'dependency'],
        ],
        `${dialect}: the old unique index stays while the new one waits`,
      );
    }
  });

  it('drops a foreign key redefined under its name only with its redefinition', () => {
    for (const dialect of SERVERS) {
      const ops = change(
        dialect,
        declaredTables([TeamV1, PlayersV1], dialect),
        declaredTables([TeamV1, PlayersCascade], dialect),
      ).operations;
      const drop = only(ops, 'drop_foreign_key');
      const addition = only(ops, 'add_foreign_key');
      assert.deepEqual(drop.appliesWith, [addition.digest], dialect);
      assert.deepEqual(
        deferrals(ops, []),
        [
          ['drop_foreign_key', 'dependency'],
          ['add_foreign_key', 'approval'],
        ],
        dialect,
      );
      assert.deepEqual(deferrals(ops, [addition]), [], dialect);
    }
  });

  it('keeps independent work out of a unit', () => {
    for (const dialect of DIALECTS) {
      const ops = change(
        dialect,
        declaredTables([MembersV1, Items], dialect),
        declaredTables([MembersRenamed], dialect),
      ).operations;
      assert.deepEqual(only(ops, 'drop_table').appliesWith, [], dialect);
    }
  });
});

describe('isWidening', () => {
  it('accepts only changes that keep every value', () => {
    assert.ok(isWidening('character varying(40)', 'character varying(120)'));
    assert.ok(isWidening('varchar(40)', 'longtext'));
    assert.ok(isWidening('integer', 'bigint'));
    assert.ok(isWidening('numeric(12,2)', 'numeric(14,3)'));
    assert.ok(!isWidening('character varying(120)', 'character varying(40)'));
    assert.ok(!isWidening('bigint', 'integer'));
    assert.ok(!isWidening('numeric(12,2)', 'numeric(12,3)'));
    assert.ok(!isWidening('text', 'integer'));
  });
});

describe('column defaults', () => {
  it('parses each server spelling of a literal', () => {
    assert.deepEqual(parseLiveDefault("'a''b'::character varying", 'postgres'), {
      kind: 'literal',
      text: "a'b",
    });
    assert.deepEqual(parseLiveDefault("'a\\\\b'", 'mariadb'), { kind: 'literal', text: 'a\\b' });
    assert.deepEqual(parseLiveDefault('(5)', 'sqlite'), { kind: 'literal', text: '5' });
    assert.deepEqual(parseLiveDefault('NULL', 'mariadb'), undefined);
    assert.deepEqual(parseLiveDefault('current_timestamp(3)', 'mariadb'), { kind: 'now' });
    assert.deepEqual(parseLiveDefault("nextval('seq'::regclass)", 'postgres')?.kind, 'expression');
  });

  it('compares values, not spellings', () => {
    const decimal = { kind: 'decimal', precision: 12, scale: 2 } as const;
    assert.ok(
      sameDefault(
        { kind: 'value', value: '10.50' },
        { kind: 'literal', text: '10.5' },
        decimal,
        'postgres',
      ),
    );
    assert.ok(
      sameDefault(
        { kind: 'value', value: true },
        { kind: 'literal', text: 'true' },
        { kind: 'boolean' },
        'postgres',
      ),
    );
    assert.ok(
      sameDefault(
        { kind: 'value', value: '{"b":1,"a":2}' },
        { kind: 'literal', text: '{"a": 2, "b": 1}' },
        { kind: 'json' },
        'postgres',
      ),
    );
    assert.ok(
      !sameDefault(
        { kind: 'value', value: 1 },
        { kind: 'literal', text: '2' },
        { kind: 'integer' },
        'sqlite',
      ),
    );
    assert.ok(
      !sameDefault(undefined, { kind: 'literal', text: '0' }, { kind: 'integer' }, 'sqlite'),
    );
  });

  it('spells JSON with sorted keys', () => {
    assert.equal(
      canonicalJson({ b: [1, { d: 1, c: 2 }], a: null }),
      '{"a":null,"b":[1,{"c":2,"d":1}]}',
    );
  });
});

describe('isTestDatabaseName', () => {
  it('accepts only a test stem', () => {
    for (const name of ['test', 'app_test', 'app-tests', 'app.testing', '/tmp/x/app_test.sqlite']) {
      assert.ok(isTestDatabaseName(name), name);
    }
    for (const name of ['app', 'test_app', 'contest', 'latest', '/tmp/test/app.sqlite']) {
      assert.ok(!isTestDatabaseName(name), name);
    }
  });
});

describe('pushSchema options', () => {
  // Never opened: every refusal comes first.
  const source = {
    config: resolveDatabaseConfig({ file: '/nonexistent/never_opened_test.sqlite' }, { env: {} }),
    models: [Items],
  };

  it('refuses invalid options before connecting', async () => {
    for (const [options, code] of [
      [{ approve: ['not-a-digest'] }, 'invalid_options'],
      [{ waitLockSeconds: -1 }, 'invalid_options'],
      [{ owner: 'Not An Owner' }, 'invalid_options'],
      [{ approve: 'all' }, 'approve_all_refused'],
      [{ approve: 'all', environment: 'staging' }, 'approve_all_refused'],
    ] as const) {
      await assert.rejects(pushSchema(source, options), (error: unknown) =>
        SchemaErrors.is(error, code),
      );
    }
  });

  it('refuses an in-memory database', async () => {
    await assert.rejects(
      pushSchema({
        config: resolveDatabaseConfig({ file: ':memory:' }, { env: {} }),
        models: [Items],
      }),
      (error: unknown) => SchemaErrors.is(error, 'memory_database'),
    );
  });
});
