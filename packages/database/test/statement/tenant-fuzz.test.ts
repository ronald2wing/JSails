/**
 * A seeded fuzz of the tenant policy: random statements of every kind, with
 * nested EXISTS and IN subqueries, joins whose ON holds subqueries, window
 * limits and upserts over a mix of tenant-scoped and global tables. After
 * `applyPolicies` the coverage checker must find no tenant-scoped reference
 * without the tenant condition, every statement must render on all three
 * dialects with one tenant parameter per tenant-scoped reference, and with
 * no tenant a read touching a tenant table must be empty as a whole (its
 * outermost `WHERE` is `1 = 0`), a read of global tables must be left as it
 * was, and a write touching a tenant table throws. A mutation run hides one table's tenant column from
 * the rewrite and requires the checker to report every reference to it, so
 * a checker that saw nothing could not pass.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ColumnRef,
  Dialect,
  Predicate,
  SelectStatement,
  Statement,
} from '../../src/engine/index.js';
import {
  applyPolicies,
  compileGuarded,
  createStatementCatalog,
  findUnscopedReferences,
  ir,
  tableReferences,
  TenantScopeErrors,
  type PolicyTables,
  type TenantScopeState,
} from '../../src/index.js';
import { MODELS } from './fixtures/tenant-models.js';

const DIALECTS: readonly Dialect[] = ['sqlite', 'postgres', 'mariadb'];
const TENANT = 7_777_777;
const SCOPED: TenantScopeState = Object.freeze({ tenantId: TENANT, unscoped: false });
const NONE: TenantScopeState = Object.freeze({ tenantId: undefined, unscoped: false });
const STATEMENTS = 1500;

const catalogs = new Map(
  DIALECTS.map((dialect) => [dialect, createStatementCatalog({ dialect, models: MODELS })]),
);
const sqlite = catalogs.get('sqlite') as ReturnType<typeof createStatementCatalog>;

/** The tables of the fixture with an integer `id` and whether they are tenant-scoped. */
const TABLES = ['st_authors', 'st_posts', 'st_comments', 'st_tags', 'st_post_tags'] as const;

/** mulberry32: a small seeded generator, so a failure names a reproducible seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Fuzzer {
  #aliases = 0;

  constructor(private readonly random: () => number) {}

  int(limit: number): number {
    return Math.floor(this.random() * limit);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }

  chance(probability: number): boolean {
    return this.random() < probability;
  }

  alias(): string {
    this.#aliases += 1;
    return `q${this.#aliases}`;
  }

  /** A predicate over the qualifiers in reach, with subqueries below `depth`. */
  predicate(depth: number, qualifiers: readonly string[]): Predicate {
    const ref = (): ColumnRef => ir.col(this.pick(qualifiers), 'id');
    const choice = this.int(depth > 0 ? 8 : 5);
    switch (choice) {
      case 0:
        return ir.compare(ref(), this.pick(['=', '<', '>=', '<>'] as const), this.int(1000));
      case 1:
        return ir.inList(ref(), [this.int(1000), this.int(1000)], this.chance(0.3));
      case 2:
        return ir.isNull(ref(), this.chance(0.5));
      case 3:
        return ir.rowCompare([ref(), ref()], '>', [this.int(1000), this.int(1000)]);
      case 4:
        return qualifiers.length > 1
          ? ir.compareColumns(ref(), '=', ref())
          : ir.compare(ref(), '=', this.int(1000));
      case 5:
        return ir.exists(this.select(depth - 1, qualifiers, true), this.chance(0.3));
      case 6:
        return ir.inSelect(ref(), this.select(depth - 1, qualifiers, true), this.chance(0.3));
      default: {
        const items = [
          this.predicate(depth - 1, qualifiers),
          this.predicate(depth - 1, qualifiers),
        ];
        const op = this.int(3);
        if (op === 0) return ir.and(...items);
        if (op === 1) return ir.or(...items);
        return ir.not(items[0] as Predicate);
      }
    }
  }

  /** A select; a subquery projects one column and may correlate with `outer`. */
  select(depth: number, outer: readonly string[], subquery: boolean): SelectStatement {
    const name = this.pick(TABLES);
    const alias = this.chance(0.7) ? this.alias() : undefined;
    const qualifier = alias ?? name;
    const inReach = [...outer, qualifier];
    const joins = [];
    for (let index = this.int(depth > 0 ? 3 : 2); index > 0; index -= 1) {
      const joined = ir.table(this.pick(TABLES), this.alias());
      joins.push(
        ir.join(
          joined,
          this.predicate(Math.max(depth - 1, 0), [...inReach, joined.alias as string]),
          this.chance(0.5) ? 'inner' : 'left',
        ),
      );
      inReach.push(joined.alias as string);
    }
    const where = this.chance(0.8) ? this.predicate(depth, inReach) : undefined;
    const window = !subquery && this.chance(0.2);
    return ir.select(ir.table(name, alias), {
      columns: [{ column: ir.col(qualifier, 'id'), ...(window ? { as: 'id' } : {}) }],
      ...(joins.length === 0 ? {} : { joins }),
      ...(where === undefined ? {} : { where }),
      ...(window
        ? {
            orderBy: [{ column: ir.col(qualifier, 'id') }],
            windowLimit: { partitionBy: [ir.col(qualifier, 'id')], limit: 1 + this.int(5) },
          }
        : {}),
    });
  }

  statement(): Statement {
    const depth = 1 + this.int(4);
    const kind = this.int(10);
    if (kind < 5) return this.select(depth, [], false);
    const name = this.pick(TABLES);
    if (kind < 7) {
      return ir.update(
        name,
        [{ column: 'id', add: 0 }],
        this.chance(0.9) ? this.predicate(depth, [name]) : ir.TRUE,
      );
    }
    if (kind < 9) return ir.deleteFrom(name, this.predicate(depth, [name]));
    if (name === 'st_tags' || name === 'st_authors') {
      return ir.insert(name, ['name'], [[`n${this.int(1000)}`]]);
    }
    const tenant = name === 'st_posts' || name === 'st_comments' || name === 'st_post_tags';
    return ir.insert(name, ['id'], [[this.int(1000)], [this.int(1000)]], {
      ...(this.chance(0.5)
        ? {
            onConflict: tenant
              ? { target: ['tenant_id', 'id'], action: 'update', update: ['id'] }
              : { target: ['id'], action: 'nothing' },
          }
        : {}),
    });
  }
}

function tenantReferences(statement: Statement): number {
  return tableReferences(statement).filter(
    (reference) => sqlite.tenant(reference.table) !== undefined,
  ).length;
}

function isWrite(statement: Statement): boolean {
  return statement.kind !== 'select';
}

/** The catalog with `hidden`'s tenant column invisible: a rewrite that forgot one table. */
function hiding(hidden: string): PolicyTables {
  return {
    has: (table) => sqlite.has(table),
    tenant: (table) => (table === hidden ? undefined : sqlite.tenant(table)),
  };
}

describe('tenant policy fuzz', () => {
  it(`covers every tenant-scoped reference of ${STATEMENTS} random statements`, () => {
    const fuzzer = new Fuzzer(generator(0x5eed05));
    let references = 0;
    let subqueries = 0;
    for (let index = 0; index < STATEMENTS; index += 1) {
      const statement = fuzzer.statement();
      const context = `statement #${index}: ${JSON.stringify(statement)}`;
      const guarded = applyPolicies(statement, { tables: sqlite, scope: SCOPED });
      assert.deepEqual(findUnscopedReferences(guarded, sqlite, SCOPED), [], context);
      const referenced = tenantReferences(statement);
      references += referenced;
      // An insert binds the tenant once per stamped row.
      const expected =
        statement.kind === 'insert' && referenced > 0 ? statement.rows.length : referenced;
      subqueries += tableReferences(statement).filter((reference) => reference.depth > 0).length;
      for (const dialect of DIALECTS) {
        const catalog = catalogs.get(dialect) as ReturnType<typeof createStatementCatalog>;
        const compiled = compileGuarded(catalog, statement, SCOPED);
        const tenantParams = compiled.params.filter((param) => param === TENANT).length;
        assert.equal(tenantParams, expected, `${dialect} ${context}`);
      }
    }
    assert.ok(references > STATEMENTS, `the run met ${references} tenant-scoped references`);
    assert.ok(subqueries > STATEMENTS / 2, `the run met ${subqueries} subquery references`);
  });

  it('with no tenant, empties every read and refuses every write that touches a tenant table', () => {
    const fuzzer = new Fuzzer(generator(0xfa11));
    let refused = 0;
    let emptied = 0;
    for (let index = 0; index < STATEMENTS; index += 1) {
      const statement = fuzzer.statement();
      const context = `statement #${index}: ${JSON.stringify(statement)}`;
      if (isWrite(statement) && tenantReferences(statement) > 0) {
        assert.throws(
          () => applyPolicies(statement, { tables: sqlite, scope: NONE }),
          (error: unknown) => TenantScopeErrors.is(error, 'no_tenant'),
          context,
        );
        refused += 1;
        continue;
      }
      const guarded = applyPolicies(statement, { tables: sqlite, scope: NONE });
      assert.deepEqual(findUnscopedReferences(guarded, sqlite, NONE), [], context);
      if (statement.kind === 'select' && tenantReferences(statement) > 0) {
        // The read as a whole is empty, not only its tenant-scoped
        // references: under NOT or a left join those would match every row.
        assert.deepEqual((guarded as SelectStatement).where, ir.FALSE, context);
        emptied += 1;
      } else {
        assert.deepEqual(guarded, statement, context);
      }
      for (const dialect of DIALECTS) {
        const catalog = catalogs.get(dialect) as ReturnType<typeof createStatementCatalog>;
        compileGuarded(catalog, statement, NONE);
      }
    }
    assert.ok(refused > 0);
    assert.ok(emptied > 0);
  });

  it('the checker reports every reference a rewrite left out', () => {
    const fuzzer = new Fuzzer(generator(0xc0ffee));
    let reported = 0;
    for (let index = 0; index < STATEMENTS; index += 1) {
      const statement = fuzzer.statement();
      const hidden = fuzzer.pick(['st_posts', 'st_comments', 'st_post_tags']);
      const missed = tableReferences(statement).filter((reference) => reference.table === hidden);
      const guarded = applyPolicies(statement, { tables: hiding(hidden), scope: SCOPED });
      const gaps = findUnscopedReferences(guarded, sqlite, SCOPED);
      assert.equal(gaps.length, missed.length, `statement #${index}: ${JSON.stringify(statement)}`);
      assert.ok(gaps.every((gap) => gap.table === hidden));
      reported += gaps.length;
    }
    assert.ok(reported > STATEMENTS / 3, `the checker reported ${reported} gaps`);
  });
});
