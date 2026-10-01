/**
 * The write guarantee matrix, on the run's driver. Every member of the
 * records-and-queries public surface (`public-surface.ts`, which the surface
 * test keeps equal to the classes), and every function a public entry point
 * of the package exports (each subpath of `package.json` `exports`, with the
 * function members of the objects it exports, error registries aside), is
 * classified here; a new member, function or subpath without a
 * classification fails, and every write entry point needs at least one row.
 *
 * Each row runs one write entry point with tenant 1 current, beside an
 * identical tenant-2 data set, and asserts the four guarantees:
 *
 * - codec: every value the write stored in an encrypted column is a seal
 *   envelope in the raw bytes (a delete stores none);
 * - tenant: every statement on a tenant table names the tenant column, and
 *   tenant 2's rows are byte-for-byte unchanged;
 * - effects: the board counter cache equals `COUNT(*)` afterwards, and a set
 *   write on cards (which declare a hook) was first refused without
 *   `{ skipHooks: true }`; record hooks ran for record writes only;
 * - change records: the coalesced records are exactly the expected ones,
 *   each with the tenant.
 *
 * What writes outside the pipeline by design is classified as such rather
 * than given a row: raw SQL (`unguarded(ds)`, an engine from `createEngine`),
 * a statement run on a connection the caller holds (`executeStatement`: the
 * tenant policy, but no codec, effect or record), and the schema commands.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, beforeEach, describe, it } from 'node:test';

import {
  dataHandle,
  runWithTenant,
  withoutTenantScope,
  type DataHandle,
  type JsailsDataSource,
} from '../../../src/index.js';
import * as queryBarrel from '../../../src/query/index.js';
import { forEachDriver } from '../../../src/testing/index.js';
import { unguarded, type Unguarded } from '../../../src/unguarded/index.js';
import { suiteLifecycle } from '../../query/fixtures/open-data-source.js';
import {
  DATA_HANDLE_MEMBERS,
  DATA_SOURCE_MEMBERS,
  MODEL_QUERY_METHODS,
  RECORD_METHODS,
  RECORD_STATICS,
  UNGUARDED_MEMBERS,
} from '../../query/fixtures/public-surface.js';
import {
  describeRecord,
  isSealed,
  openWriteSource,
  recordChanges,
  statementsOf,
  TEST_SEAL,
} from '../../record/fixtures/open-write-source.js';
import { Board, Card, SAVED_CARDS, WRITE_MODELS } from './fixtures/write-models.js';

/** How a surface member relates to writes. */
type Classification =
  /** Writes rows through the pipeline: it needs a matrix row. */
  | 'write'
  /** Reads, or builds a query, predicate or record without writing. */
  | 'read'
  /** Raw SQL, outside the pipeline by design, with no guarantee. */
  | 'unguarded'
  /**
   * Runs a statement the caller built on a connection the caller holds: the
   * guarded compile applies the tenant policy, but no codec, effect, hook or
   * change record runs (the layer under the pipeline).
   */
  | 'statement'
  /** Reads or changes the schema and its own bookkeeping (the `db:*` commands). */
  | 'schema'
  /**
   * Inserts rows a test states as stored: the codecs apply, but no hook,
   * validation, effect or tenant policy runs (a row names its tenant), so no
   * matrix row applies; the testing suite's rollback coverage covers it.
   */
  | 'fixture'
  /** Lifecycle, transactions, the feed, metadata or a pure helper: writes nothing itself. */
  | 'other';

const OTHER_ROOT_FUNCTIONS = [
  'ApplicationRecord',
  'DatabaseError',
  'FileDataSource',
  'JsailsDataSource',
  'ModelQuery',
  'applyPolicies',
  'assertKnownTables',
  'chainCodecs',
  'compileGuarded',
  'compileOrder',
  'compileStatement',
  'compileWhere',
  'createQueryLedger',
  'createRecordState',
  'createStatementCatalog',
  'currentQueryLedger',
  'currentTenantScope',
  'dataContractCodec',
  'dataHandle',
  'database',
  'databaseToken.named',
  'decodeColumn',
  'decodeRow',
  'detached',
  'encodeAssignments',
  'encodeColumn',
  'encodeInsertRows',
  'enumCodec',
  'findUnscopedReferences',
  'forEachTableReference',
  'hydrate',
  'isDatabaseError',
  'modelCodecs',
  'modelColumns',
  'persistedState',
  'quoteIdentifier',
  'recordState',
  'resolveDatabaseConfig',
  'runWithTenant',
  'runWithoutTenant',
  'sameSqlValue',
  'setRecordState',
  'statementShape',
  'supports',
  'tableReferences',
  'touchesTenantTable',
  'transaction',
  'withQueryLedger',
  'withTestTransaction',
  'withoutTenantScope',
  // The statement builders: they build a statement, which runs only through
  // a query, the guarded compile or `executeStatement`.
  ...[
    'and',
    'col',
    'compare',
    'compareColumns',
    'deleteFrom',
    'eq',
    'exists',
    'freezeStatement',
    'inList',
    'inSelect',
    'insert',
    'isNull',
    'join',
    'like',
    'not',
    'or',
    'rowCompare',
    'select',
    'table',
    'update',
  ].map((name) => `ir.${name}`),
];

const MODEL_FUNCTIONS = [
  'ColumnValueError',
  'ModelSpecError',
  'compareCodePoints',
  'compareValues',
  'defineModel',
  'defineTable',
  'describeType',
  'encryptedCapacity',
  'encryptedStorage',
  'foreignKeyName',
  'indexEntryBytes',
  'indexKeyBytes',
  'indexName',
  'isOrdered',
  'modelDefinition',
  'modelSpec',
  'normalizeSpec',
  'physicalTable',
  'physicalType',
  'portableCodec',
  'portableType',
  'sameType',
  'snakeCase',
  'storedType',
  'unindexedColumns',
  ...[
    'id',
    'string',
    'text',
    'integer',
    'bigint',
    'decimal',
    'float',
    'boolean',
    'timestamp',
    'date',
    'time',
    'json',
    'uuid',
    'binary',
  ].map((name) => `column.${name}`),
];

const SCHEMA_COMMANDS = [
  'appliedDataMigrations',
  'assertTestDatabase',
  'bootstrapLedger',
  'connectedDatabase',
  'diffSchema',
  'introspect',
  'markTestDatabase',
  'planSchema',
  'pushSchema',
  'readMeta',
  'readOwnership',
  'recordDataMigration',
  'runDbDiff',
  'runDbPush',
  'verifySchema',
  'writeMeta',
];

const CLASSIFICATION: Readonly<Record<string, Classification>> = {
  'ModelQuery#count': 'read',
  'ModelQuery#deleteAll': 'write',
  'ModelQuery#exists': 'read',
  'ModelQuery#findEach': 'read',
  'ModelQuery#getMany': 'read',
  'ModelQuery#getOne': 'read',
  'ModelQuery#has': 'read',
  'ModelQuery#inBatches': 'read',
  'ModelQuery#includes': 'read',
  'ModelQuery#limit': 'read',
  'ModelQuery#lock': 'read',
  'ModelQuery#offset': 'read',
  'ModelQuery#orderBy': 'read',
  'ModelQuery#pluck': 'read',
  'ModelQuery#scope': 'read',
  'ModelQuery#select': 'read',
  'ModelQuery#updateAll': 'write',
  'ModelQuery#where': 'read',
  'ModelQuery#whereHas': 'read',
  'ModelQuery#withoutTenantScope': 'read',
  'ApplicationRecord.all': 'read',
  'ApplicationRecord.build': 'read',
  'ApplicationRecord.create': 'write',
  'ApplicationRecord.find': 'read',
  'ApplicationRecord.findBy': 'read',
  'ApplicationRecord.insertAll': 'write',
  'ApplicationRecord.where': 'read',
  'ApplicationRecord#changed': 'read',
  'ApplicationRecord#destroy': 'write',
  'ApplicationRecord#isPersisted': 'read',
  'ApplicationRecord#reload': 'read',
  'ApplicationRecord#save': 'write',
  'ApplicationRecord#was': 'read',
  'JsailsDataSource#changes': 'other',
  'JsailsDataSource#close': 'other',
  'JsailsDataSource#closed': 'other',
  'JsailsDataSource#dialect': 'other',
  'JsailsDataSource#models': 'other',
  'JsailsDataSource#transaction': 'other',
  'JsailsDataSource#withTestTransaction': 'other',
  'unguarded#lease': 'unguarded',
  'unguarded#sql': 'unguarded',
  'DataHandle#insertAll': 'write',
  'DataHandle#query': 'write',
  'DataHandle#read': 'read',
  'DataHandle#transaction': 'other',
  'root:attachmentOf': 'read',
  'root:createEngine': 'unguarded',
  'root:defineScope': 'read',
  'root:executeStatement': 'statement',
  'root:insertAll': 'write',
  'root:loadRelation': 'read',
  'root:loadRelationMap': 'read',
  'root:query': 'read',
  'root:relationCount': 'read',
  'root:Q.and': 'read',
  'root:Q.not': 'read',
  'root:Q.or': 'read',
  ...Object.fromEntries(OTHER_ROOT_FUNCTIONS.map((name) => [`root:${name}`, 'other'])),
  ...Object.fromEntries(MODEL_FUNCTIONS.map((name) => [`model:${name}`, 'other'])),
  ...Object.fromEntries(SCHEMA_COMMANDS.map((name) => [`schema:${name}`, 'schema'])),
  'schema:defineSchemaConfig': 'other',
  'schema:emit': 'other',
  'schema:isTestDatabaseName': 'other',
  'schema:schemaDigest': 'other',
  'testing:DriverMatrixError': 'other',
  'testing:countStatements': 'other',
  'testing:createMatrixDatabase': 'schema',
  'testing:createTestDataSource': 'schema',
  'testing:defineFactory': 'other',
  'testing:defineFixture': 'other',
  'testing:defineSeeder': 'other',
  'testing:driverSkipReason': 'other',
  'testing:forEachDriver': 'other',
  'testing:lastInFirstOut': 'other',
  'testing:loadFixtures': 'fixture',
  'testing:matrixDriver': 'other',
  'testing:matrixServer': 'other',
  'testing:matrixServerUrl': 'other',
  'testing:matrixTestDatabase': 'other',
  'testing:openMatrixDataSource': 'other',
  'testing:runSeeders': 'other',
  'testing:storeContract': 'other',
  'testing:testDatabaseName': 'other',
  'testing:transactionalTests': 'other',
  'testing:withTestTransaction': 'other',
  'unguarded:unguarded': 'unguarded',
};

/** The package root, from the compiled test file (`dist/test/conformance/write/`). */
const PACKAGE_ROOT = new URL('../../../../', import.meta.url);

/** An error registry (`defineErrors`): its `Error` class and `is` guard write nothing. */
function isErrorRegistry(name: string, value: object): boolean {
  const registry = value as Readonly<Record<string, unknown>>;
  return (
    name.endsWith('Errors') &&
    typeof registry.domain === 'string' &&
    typeof registry.Error === 'function' &&
    typeof registry.is === 'function'
  );
}

/** The functions a barrel exports, and those of the plain objects it exports. */
function exportedFunctions(prefix: string, barrel: Readonly<Record<string, unknown>>): string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(barrel)) {
    if (typeof value === 'function') names.push(`${prefix}:${name}`);
    else if (value !== null && typeof value === 'object' && !isErrorRegistry(name, value)) {
      for (const [member, inner] of Object.entries(value)) {
        if (typeof inner === 'function') names.push(`${prefix}:${name}.${member}`);
      }
    }
  }
  return names;
}

/** Every public entry point of the package (`exports`), by the prefix its functions take. */
async function entryPoints(): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
  const manifest = JSON.parse(await readFile(new URL('package.json', PACKAGE_ROOT), 'utf8')) as {
    readonly exports: Readonly<Record<string, string | { readonly default?: string }>>;
  };
  const barrels = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (typeof target === 'string') continue;
    assert.ok(target.default !== undefined, `the ${subpath} entry point names its module`);
    const prefix = subpath === '.' ? 'root' : subpath.slice('./'.length);
    barrels.set(
      prefix,
      (await import(new URL(target.default, PACKAGE_ROOT).href)) as Record<string, unknown>,
    );
  }
  return barrels;
}

/** The surface as the classes and entry points have it now. */
async function liveSurface(): Promise<string[]> {
  const functions: string[] = [];
  for (const [prefix, barrel] of await entryPoints()) {
    functions.push(...exportedFunctions(prefix, barrel));
  }
  return [
    ...MODEL_QUERY_METHODS.map((name) => `ModelQuery#${name}`),
    ...RECORD_STATICS.map((name) => `ApplicationRecord.${name}`),
    ...RECORD_METHODS.map((name) => `ApplicationRecord#${name}`),
    ...DATA_SOURCE_MEMBERS.map((name) => `JsailsDataSource#${name}`),
    ...UNGUARDED_MEMBERS.map((name) => `unguarded#${name}`),
    ...DATA_HANDLE_MEMBERS.map((name) => `DataHandle#${name}`),
    ...functions,
  ].toSorted();
}

interface RowContext {
  readonly handle: DataHandle;
  /** The two tenant-1 boards every row starts with. */
  readonly boards: readonly [Board, Board];
}

interface MatrixRow {
  readonly entry: string;
  readonly name: string;
  /** Whether the write stores values (and so must have sealed them). */
  readonly stores: boolean;
  /** Whether it is a set write on cards, refused until hooks are acknowledged. */
  readonly refusedWithoutSkipHooks: boolean;
  /** Run the write with tenant 1 current; resolves with what the expected records need. */
  act(context: RowContext, acknowledged: boolean): Promise<readonly string[]>;
}

const ROWS: readonly MatrixRow[] = [
  {
    entry: 'ApplicationRecord.create',
    name: 'Card.create',
    stores: true,
    refusedWithoutSkipHooks: false,
    act: async ({ boards: [a] }) => {
      const card = await Card.create({ title: 'new', secret: 's', boardId: a.id });
      assert.equal(card.tenantId, 1, 'the tenant is stamped');
      assert.deepEqual(SAVED_CARDS, [card.id]);
      return [`insert gm_cards ${card.id} @1`, `update gm_boards ${a.id} @1`];
    },
  },
  {
    entry: 'ApplicationRecord#save',
    name: 'save of a built record (insert)',
    stores: true,
    refusedWithoutSkipHooks: false,
    act: async ({ boards: [a] }) => {
      const card = Card.build({ title: 'built', secret: 's', boardId: a.id });
      await card.save();
      return [`insert gm_cards ${card.id} @1`, `update gm_boards ${a.id} @1`];
    },
  },
  {
    entry: 'ApplicationRecord#save',
    name: 'save of a loaded record (update, re-parented)',
    stores: true,
    refusedWithoutSkipHooks: false,
    act: async ({ boards: [a, b] }) => {
      const card = await Card.findBy({ title: 'shared' });
      assert.ok(card !== null && card.boardId === a.id);
      card.secret = 'rotated';
      card.boardId = b.id;
      await card.save();
      return [
        `update gm_cards ${card.id} @1`,
        `update gm_boards ${a.id} @1`,
        `update gm_boards ${b.id} @1`,
      ];
    },
  },
  {
    entry: 'ApplicationRecord#destroy',
    name: 'destroy of a card',
    stores: false,
    refusedWithoutSkipHooks: false,
    act: async ({ boards: [a] }) => {
      const card = await Card.findBy({ title: 'shared' });
      assert.ok(card !== null);
      await card.destroy();
      return [`delete gm_cards ${card.id} @1`, `update gm_boards ${a.id} @1`];
    },
  },
  {
    entry: 'ApplicationRecord#destroy',
    name: 'destroy of a board (its cards detached by the foreign-key action)',
    stores: false,
    refusedWithoutSkipHooks: false,
    act: async ({ boards: [a] }) => {
      await a.destroy();
      return [`delete gm_boards ${a.id} @1`, 'invalidate gm_cards @1'];
    },
  },
  {
    entry: 'ApplicationRecord.insertAll',
    name: 'Card.insertAll',
    stores: true,
    refusedWithoutSkipHooks: true,
    act: async ({ boards: [a] }, acknowledged) => {
      await Card.insertAll(
        [
          { title: 'bulk 1', secret: 's1', boardId: a.id },
          { title: 'bulk 2', secret: 's2', boardId: a.id },
        ],
        acknowledged ? { skipHooks: true } : undefined,
      );
      return insertedThen(a);
    },
  },
  {
    entry: 'root:insertAll',
    name: 'insertAll(Card, rows)',
    stores: true,
    refusedWithoutSkipHooks: true,
    act: async ({ boards: [a] }, acknowledged) => {
      await queryBarrel.insertAll(
        Card,
        [{ title: 'bulk 1', secret: 's1', boardId: a.id }],
        acknowledged ? { skipHooks: true } : undefined,
      );
      return insertedThen(a);
    },
  },
  {
    entry: 'DataHandle#insertAll',
    name: "the handle's insertAll",
    stores: true,
    refusedWithoutSkipHooks: true,
    act: async ({ handle, boards: [a] }, acknowledged) => {
      await handle.insertAll(
        Card,
        [{ title: 'bulk 1', secret: 's1', boardId: a.id }],
        acknowledged ? { skipHooks: true } : undefined,
      );
      return insertedThen(a);
    },
  },
  {
    entry: 'ModelQuery#updateAll',
    name: 'updateAll by a condition, moving rows between boards',
    stores: true,
    refusedWithoutSkipHooks: true,
    act: async ({ boards: [a, b] }, acknowledged) => {
      const result = await Card.where({ title: 'shared' }).updateAll(
        { secret: 'moved', boardId: b.id },
        acknowledged ? { skipHooks: true } : undefined,
      );
      assert.equal(result.affected, 1);
      return [
        'invalidate gm_cards @1',
        `update gm_boards ${a.id} @1`,
        `update gm_boards ${b.id} @1`,
      ];
    },
  },
  {
    entry: 'ModelQuery#updateAll',
    name: 'updateAll by primary key',
    stores: true,
    refusedWithoutSkipHooks: true,
    act: async ({ boards: [a] }, acknowledged) => {
      const card = await Card.findBy({ title: 'shared' });
      assert.ok(card !== null);
      await Card.where({ id: card.id }).updateAll(
        { secret: 'keyed' },
        acknowledged ? { skipHooks: true } : undefined,
      );
      return [`update gm_cards ${card.id} @1`, `update gm_boards ${a.id} @1`];
    },
  },
  {
    entry: 'ModelQuery#deleteAll',
    name: 'deleteAll by a condition',
    stores: false,
    refusedWithoutSkipHooks: true,
    act: async ({ boards: [a] }, acknowledged) => {
      await Card.where({ title: 'shared' }).deleteAll(
        acknowledged ? { skipHooks: true } : undefined,
      );
      return ['invalidate gm_cards @1', `update gm_boards ${a.id} @1`];
    },
  },
  {
    entry: 'ModelQuery#deleteAll',
    name: 'deleteAll of boards by key (cards detached by the foreign-key action)',
    stores: false,
    refusedWithoutSkipHooks: false,
    act: async ({ boards: [a] }) => {
      await Board.where({ id: a.id }).deleteAll();
      return [`delete gm_boards ${a.id} @1`, 'invalidate gm_cards @1'];
    },
  },
  {
    entry: 'DataHandle#query',
    name: "the handle's query: updateAll",
    stores: true,
    refusedWithoutSkipHooks: true,
    act: async ({ handle, boards: [a] }, acknowledged) => {
      await handle
        .query(Card)
        .where({ title: 'shared' })
        .updateAll({ secret: 'handled' }, acknowledged ? { skipHooks: true } : undefined);
      return ['invalidate gm_cards @1', `update gm_boards ${a.id} @1`];
    },
  },
  {
    entry: 'DataHandle#query',
    name: "the handle's query: deleteAll",
    stores: false,
    refusedWithoutSkipHooks: true,
    act: async ({ handle, boards: [a] }, acknowledged) => {
      await handle
        .query(Card)
        .where({ title: 'shared' })
        .deleteAll(acknowledged ? { skipHooks: true } : undefined);
      return ['invalidate gm_cards @1', `update gm_boards ${a.id} @1`];
    },
  },
];

/** The records of an insert of cards on board `a`: each inserted key, then the recount. */
async function insertedThen(a: Board): Promise<readonly string[]> {
  const inserted = await Card.where({ title: { like: 'bulk%' } })
    .orderBy('id')
    .getMany();
  return [
    ...inserted.map((card) => `insert gm_cards ${card.id} @1`),
    `update gm_boards ${a.id} @1`,
  ];
}

/** Rows of a table with raw values as text, for comparing snapshots. */
function snapshot(rows: readonly Readonly<Record<string, unknown>>[]): string {
  return JSON.stringify(rows, (_, value: unknown) => {
    if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
    if (typeof value === 'bigint') return value.toString();
    return value;
  });
}

describe('the write guarantee matrix', () => {
  it('classifies every member of the public write surface', async () => {
    assert.deepEqual(Object.keys(CLASSIFICATION).toSorted(), await liveSurface());
    // A write helper added to any barrel, or to an object one exports, is unclassified.
    const added = exportedFunctions('root', {
      upsertRows: () => undefined,
      writers: { put: () => undefined },
    });
    assert.deepEqual(
      added.filter((entry) => !Object.hasOwn(CLASSIFICATION, entry)),
      ['root:upsertRows', 'root:writers.put'],
    );
    const covered = new Set(ROWS.map((row) => row.entry));
    const writes = Object.entries(CLASSIFICATION)
      .filter(([, kind]) => kind === 'write')
      .map(([entry]) => entry);
    assert.deepEqual(
      writes.filter((entry) => !covered.has(entry)),
      [],
      'every write entry point has a row',
    );
    assert.deepEqual(
      [...covered].filter((entry) => CLASSIFICATION[entry] !== 'write'),
      [],
      'every row names a write entry point',
    );
  });
});

void forEachDriver('the write guarantee matrix', () => {
  const lifecycle = suiteLifecycle();
  let dataSource: JsailsDataSource;
  let raw: Unguarded;
  let handle: DataHandle;
  let boards: readonly [Board, Board];

  before(async () => {
    dataSource = await openWriteSource(lifecycle, WRITE_MODELS, { seal: TEST_SEAL });
    raw = unguarded(dataSource);
    handle = dataHandle(dataSource, { models: WRITE_MODELS });
  });

  beforeEach(async () => {
    await withoutTenantScope(async () => {
      await Card.all().deleteAll({ skipHooks: true });
      await Board.all().deleteAll();
    });
    // The same data set for both tenants: two boards, a card on the first.
    for (const tenant of [2, 1]) {
      boards = await runWithTenant(tenant, async () => {
        const a = await Board.create({ name: 'a', motto: 'm' });
        const b = await Board.create({ name: 'b' });
        await Card.create({ title: 'shared', secret: 'x', boardId: a.id });
        return [await Board.find(a.id), await Board.find(b.id)] as const;
      });
    }
    SAVED_CARDS.length = 0;
  });

  async function tenantRows(tenant: number): Promise<string> {
    const cards = await raw.sql`SELECT * FROM gm_cards WHERE tenant_id = ${tenant} ORDER BY id`;
    const boardRows =
      await raw.sql`SELECT * FROM gm_boards WHERE tenant_id = ${tenant} ORDER BY id`;
    return snapshot([...cards.rows, ...boardRows.rows]);
  }

  async function assertSealed(): Promise<void> {
    const cards = await raw.sql`SELECT secret FROM gm_cards`;
    const mottos = await raw.sql`SELECT motto FROM gm_boards WHERE motto IS NOT NULL`;
    for (const row of [...cards.rows, ...mottos.rows]) {
      const value = row.secret ?? row.motto;
      assert.ok(isSealed(value), 'every stored encrypted value is a seal envelope');
    }
  }

  async function assertCounters(): Promise<void> {
    await withoutTenantScope(async () => {
      for (const board of await Board.all().getMany()) {
        assert.equal(board.cardsCount, await Card.where({ boardId: board.id }).count());
      }
    });
  }

  for (const row of ROWS) {
    it(`${row.entry}: ${row.name}`, async () => {
      const context: RowContext = { handle, boards };
      const otherTenant = await tenantRows(2);
      if (row.refusedWithoutSkipHooks) {
        await assert.rejects(
          runWithTenant(1, () => row.act(context, false)),
          { code: 'query.set_write_skips_hooks' },
        );
      }
      const changes = recordChanges(dataSource);
      let expected: readonly string[] = [];
      let statements: string[];
      try {
        statements = await statementsOf(async () => {
          expected = await runWithTenant(1, () => row.act(context, true));
        });
        // codec
        if (row.stores) await assertSealed();
        // tenant
        const tenantTables = statements.filter((sql) => /gm_(cards|boards)/.test(sql));
        assert.ok(tenantTables.length > 0);
        for (const sql of tenantTables) assert.match(sql, /tenant_id/, sql);
        assert.equal(await tenantRows(2), otherTenant, "tenant 2's rows are unchanged");
        // effects
        await assertCounters();
        if (row.refusedWithoutSkipHooks)
          assert.deepEqual(SAVED_CARDS, [], 'set writes run no hooks');
        // change records
        assert.deepEqual(changes.take().map(describeRecord).toSorted(), [...expected].toSorted());
      } finally {
        changes.stop();
      }
    });
  }
});
