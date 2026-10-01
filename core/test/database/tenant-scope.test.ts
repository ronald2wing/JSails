/**
 * The tenant query guard: reads, writes, joins, relation loads, and the
 * explicit opt-outs for a `tenantScoped` model over a real sqljs database.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  BaseEntity,
  Column,
  DataSource,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { QueryResultCache } from 'typeorm/cache/QueryResultCache.js';
import type { QueryResultCacheOptions } from 'typeorm/cache/QueryResultCacheOptions.js';

import { query } from '../../src/database/model-query.js';
import { or, qEq } from '../../src/database/query-expressions.js';
import { loadRelations } from '../../src/database/relation-loader/index.js';
import { whereHas } from '../../src/database/relation-query.js';
import {
  runWithTenant,
  TenantScopeError,
  withoutTenantScope,
} from '../../src/database/tenant-context.js';
import type * as TenantContextModule from '../../src/database/tenant-context.js';
import { tenantScopeColumn, tenantScoped } from '../../src/database/tenant-scope.js';
import type * as TenantScopeModule from '../../src/database/tenant-scope.js';
import type { JsailsDataSource } from '../../src/database/data-source.js';
import { createEmptyDataSource } from '../../src/testing/test-database.js';

@Entity('ts_owners')
class TsOwner extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @OneToMany(() => TsProject, (project) => project.owner)
  projects!: TsProject[];
}

@Entity('ts_projects')
class TsProject extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  tenantId!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @ManyToOne(() => TsOwner, (owner) => owner.projects, { nullable: true })
  @JoinColumn({ name: 'owner_id' })
  owner!: TsOwner | null;
}
tenantScoped('tenantId')(TsProject);

/** Registered only after it has been queried (late registration). */
@Entity('ts_late')
class TsLate extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  tenantId!: number;
}

/** Registered through a second loaded copy of the tenant modules. */
@Entity('ts_copied')
class TsCopied extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  tenantId!: number;
}

/**
 * Load a fresh module instance of `path` (relative to this file), as a second
 * copy of jsails in the dependency tree would be.
 */
async function loadCopy(path: string): Promise<unknown> {
  return import(new URL(`${path}?copy=second`, import.meta.url).href) as Promise<unknown>;
}

/** A model whose declared tenant column does not exist. */
@Entity('ts_broken')
class TsBroken extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;
}
tenantScoped('missing')(TsBroken);

function isCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof TenantScopeError && error.code === code;
}

function names(rows: readonly { name: string }[]): string[] {
  return rows.map((row) => row.name).sort();
}

describe('tenantScoped', () => {
  let dataSource: JsailsDataSource;
  let owner: TsOwner;
  let alphaOne: TsProject;
  let alphaTwo: TsProject;

  before(async () => {
    dataSource = await createEmptyDataSource([TsOwner, TsProject, TsBroken, TsLate, TsCopied]);
  });

  after(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await withoutTenantScope(async () => {
      await TsProject.createQueryBuilder().delete().execute();
      await TsOwner.createQueryBuilder().delete().execute();
      owner = await TsOwner.create({ name: 'shared owner' }).save();
      alphaOne = await TsProject.create({ tenantId: 1, name: 'one-a', owner }).save();
      await TsProject.create({ tenantId: 1, name: 'one-b', owner }).save();
      alphaTwo = await TsProject.create({ tenantId: 2, name: 'two-a', owner }).save();
    });
  });

  describe('registration', () => {
    it('reports the declared column, inherited by subclasses', () => {
      class Child extends TsProject {}
      assert.equal(tenantScopeColumn(TsProject), 'tenantId');
      assert.equal(tenantScopeColumn(Child), 'tenantId');
      assert.equal(tenantScopeColumn(TsOwner), undefined);
    });

    it('rejects an invalid column name and a second registration', () => {
      assert.throws(() => tenantScoped(''), isCode('invalid_column'));
      assert.throws(() => tenantScoped('tenant.id'), isCode('invalid_column'));
      assert.throws(() => tenantScoped('tenantId')(TsProject), isCode('duplicate_registration'));
    });

    it('filters a model queried before its registration ran', async () => {
      await withoutTenantScope(() => TsLate.insert([{ tenantId: 1 }, { tenantId: 2 }]));
      assert.equal(await TsLate.count(), 2);
      tenantScoped('tenantId')(TsLate);
      assert.equal(await TsLate.count(), 0);
      assert.equal(await runWithTenant(1, () => TsLate.count()), 1);
    });

    it('shares the registry and the ambient tenant with a second loaded copy', async () => {
      const scopeCopy = (await loadCopy(
        '../../src/database/tenant-scope.js',
      )) as typeof TenantScopeModule;
      const contextCopy = (await loadCopy(
        '../../src/database/tenant-context.js',
      )) as typeof TenantContextModule;
      assert.notEqual(scopeCopy.tenantScoped, tenantScoped);
      assert.notEqual(contextCopy.runWithTenant, runWithTenant);
      scopeCopy.tenantScoped('tenantId')(TsCopied);
      assert.equal(tenantScopeColumn(TsCopied), 'tenantId');
      await contextCopy.withoutTenantScope(() =>
        TsCopied.insert([{ tenantId: 1 }, { tenantId: 2 }]),
      );
      assert.equal(await TsCopied.count(), 0);
      assert.equal(await contextCopy.runWithTenant(2, () => TsCopied.count()), 1);
      assert.equal(await runWithTenant(1, () => TsCopied.count()), 1);
    });

    it('rejects a query on a model whose tenant column does not exist', async () => {
      await assert.rejects(
        runWithTenant(1, () => TsBroken.find()),
        isCode('invalid_column'),
      );
    });
  });

  describe('reads', () => {
    it('filters Active Record reads to the current tenant', async () => {
      await runWithTenant(1, async () => {
        assert.deepEqual(names(await TsProject.find()), ['one-a', 'one-b']);
        assert.equal(await TsProject.count(), 2);
        assert.equal(await TsProject.findOneBy({ id: alphaTwo.id }), null);
        assert.equal(await TsProject.existsBy({ id: alphaTwo.id }), false);
      });
      await runWithTenant(2, async () => {
        assert.deepEqual(names(await TsProject.find()), ['two-a']);
      });
    });

    it('cannot be widened by naming another tenant in the criteria', async () => {
      await runWithTenant(1, async () => {
        assert.deepEqual(await TsProject.findBy({ tenantId: 2 }), []);
        assert.deepEqual(await query<TsProject>(TsProject).where(qEq('tenantId', 2)).getMany(), []);
      });
    });

    it('keeps an OR predicate inside the tenant filter', async () => {
      await runWithTenant(1, async () => {
        const rows = await query<TsProject>(TsProject)
          .where(or(qEq('name', 'one-a'), qEq('name', 'two-a')))
          .getMany();
        assert.deepEqual(names(rows), ['one-a']);
      });
    });

    it('survives a raw builder whose where() replaces earlier conditions', async () => {
      await runWithTenant(1, async () => {
        const rows = await TsProject.createQueryBuilder('p')
          .where('p.name LIKE :pattern', { pattern: '%-a' })
          .getMany();
        assert.deepEqual(names(rows), ['one-a']);
        const count = await TsProject.createQueryBuilder('p').where('1 = 1').getCount();
        assert.equal(count, 2);
      });
    });

    it('applies the tenant current when the query runs, not when it was built', async () => {
      const builder = query<TsProject>(TsProject);
      assert.deepEqual(names(await runWithTenant(2, () => builder.getMany())), ['two-a']);
    });

    it('filters a tenant-scoped table added with addFrom()', async () => {
      const build = () =>
        TsOwner.createQueryBuilder('o')
          .addFrom(TsProject, 'p')
          .select('p.name', 'name')
          .getRawMany<{ name: string }>();
      assert.deepEqual(names(await runWithTenant(1, build)), ['one-a', 'one-b']);
      assert.deepEqual(await build(), []);
    });

    it('filters a paginated read that joins a relation', async () => {
      const rows = await runWithTenant(1, () =>
        TsProject.find({ relations: { owner: true }, take: 5, order: { name: 'ASC' } }),
      );
      assert.deepEqual(names(rows), ['one-a', 'one-b']);
    });

    it('fails closed with no current tenant', async () => {
      assert.deepEqual(await TsProject.find(), []);
      assert.equal(await TsProject.count(), 0);
      assert.equal(await TsProject.findOneBy({ id: alphaOne.id }), null);
      assert.deepEqual(await query<TsProject>(TsProject).getMany(), []);
      assert.equal(await TsProject.createQueryBuilder('p').getCount(), 0);
    });

    it('leaves models that are not tenant-scoped alone', async () => {
      assert.equal(await TsOwner.count(), 1);
    });
  });

  describe('relation loading', () => {
    it('scopes a join onto a tenant-scoped relation', async () => {
      const [loaded] = await runWithTenant(1, () =>
        TsOwner.find({ relations: { projects: true } }),
      );
      assert.deepEqual(names(loaded?.projects ?? []), ['one-a', 'one-b']);
      const [none] = await TsOwner.find({ relations: { projects: true } });
      assert.deepEqual(none?.projects, []);
    });

    it('scopes batched relation loads and includes()', async () => {
      await runWithTenant(2, async () => {
        const owners = await TsOwner.find();
        const [loaded] = await loadRelations(owners, { with: { projects: true } });
        assert.deepEqual(names((loaded as TsOwner).projects), ['two-a']);
        const [included] = await query<TsOwner>(TsOwner).includes({ projects: true }).getMany();
        assert.deepEqual(names(included?.projects ?? []), ['two-a']);
      });
    });

    it('scopes a relation predicate subquery', async () => {
      const matching = await runWithTenant(2, () =>
        whereHas<TsOwner>(TsOwner, 'projects', (q) => q.where('name', 'one-a')).getMany(),
      );
      assert.deepEqual(matching, []);
      const own = await runWithTenant(1, () =>
        whereHas<TsOwner>(TsOwner, 'projects', (q) => q.where('name', 'one-a')).getMany(),
      );
      assert.equal(own.length, 1);
    });

    it('holds a relation subquery to the tenant current when the query runs', async () => {
      const build = () => whereHas<TsOwner>(TsOwner, 'projects', (q) => q.where('name', 'one-a'));
      const outside = build();
      assert.equal((await runWithTenant(1, () => outside.getMany())).length, 1);
      const underOne = runWithTenant(1, build);
      assert.deepEqual(await runWithTenant(2, () => underOne.getMany()), []);
      const unscoped = withoutTenantScope(build);
      assert.deepEqual(await runWithTenant(2, () => unscoped.getMany()), []);
      assert.deepEqual(await outside.getMany(), []);
    });

    it('lifts the subquery filter for ModelQuery.withoutTenantScope()', async () => {
      const rows = await runWithTenant(2, () =>
        query<TsOwner>(TsOwner)
          .whereHas('projects', (q) => q.where('name', 'one-a'))
          .withoutTenantScope()
          .getMany(),
      );
      assert.equal(rows.length, 1);
      const scoped = await runWithTenant(2, () =>
        query<TsOwner>(TsOwner)
          .whereHas('projects', (q) => q.where('name', 'one-a'))
          .getMany(),
      );
      assert.deepEqual(scoped, []);
    });
  });

  describe('writes', () => {
    it('stamps the current tenant on save() and insert()', async () => {
      const created = await runWithTenant(2, () => TsProject.create({ name: 'two-b' }).save());
      assert.equal(created.tenantId, 2);
      await runWithTenant(2, () => TsProject.insert({ name: 'two-c' }));
      const rows = await withoutTenantScope(() => TsProject.findBy({ tenantId: 2 }));
      assert.deepEqual(names(rows), ['two-a', 'two-b', 'two-c']);
    });

    it('refuses to create a row for another tenant', async () => {
      await assert.rejects(
        runWithTenant(1, () => TsProject.create({ tenantId: 2, name: 'stray' }).save()),
        isCode('tenant_mismatch'),
      );
      await assert.rejects(
        runWithTenant(1, () => TsProject.insert({ tenantId: 2, name: 'stray' })),
        isCode('tenant_mismatch'),
      );
    });

    it('refuses a write with no current tenant', async () => {
      await assert.rejects(TsProject.create({ name: 'orphan' }).save(), isCode('no_tenant'));
      await assert.rejects(TsProject.insert({ name: 'orphan' }), isCode('no_tenant'));
      await assert.rejects(
        TsProject.update({ id: alphaOne.id }, { name: 'x' }),
        isCode('no_tenant'),
      );
      await assert.rejects(TsProject.delete({ id: alphaOne.id }), isCode('no_tenant'));
    });

    it('does not update or delete another tenant’s row', async () => {
      await runWithTenant(1, async () => {
        const updated = await TsProject.update({ id: alphaTwo.id }, { name: 'hijacked' });
        assert.equal(updated.affected ?? 0, 0);
        await TsProject.delete({ id: alphaTwo.id });
        await TsProject.createQueryBuilder()
          .delete()
          .where('id = :id', { id: alphaTwo.id })
          .execute();
      });
      const row = await withoutTenantScope(() => TsProject.findOneBy({ id: alphaTwo.id }));
      assert.equal(row?.name, 'two-a');
    });

    it('updates and deletes its own rows', async () => {
      await runWithTenant(1, async () => {
        await TsProject.update({ id: alphaOne.id }, { name: 'one-renamed' });
        const row = await TsProject.findOneByOrFail({ id: alphaOne.id });
        row.name = 'one-saved';
        await row.save();
        await row.remove();
      });
      assert.equal(await withoutTenantScope(() => TsProject.count()), 2);
    });

    it('never moves a row to another tenant', async () => {
      await runWithTenant(1, async () => {
        await assert.rejects(
          TsProject.update({ id: alphaOne.id }, { tenantId: 2 }),
          isCode('tenant_mismatch'),
        );
        const row = await TsProject.findOneByOrFail({ id: alphaOne.id });
        row.tenantId = 2;
        await assert.rejects(row.save(), isCode('tenant_mismatch'));
        await TsProject.update({ id: alphaOne.id }, { tenantId: 1, name: 'same tenant' });
      });
      const row = await withoutTenantScope(() => TsProject.findOneBy({ id: alphaOne.id }));
      assert.equal(row?.tenantId, 1);
    });

    it('refuses an upsert, whose conflict branch could rewrite another tenant’s row', async () => {
      await assert.rejects(
        runWithTenant(1, () =>
          TsProject.upsert({ id: alphaTwo.id, name: 'taken' }, { conflictPaths: ['id'] }),
        ),
        isCode('unsupported_write'),
      );
    });
  });

  describe('opt-outs', () => {
    it('withoutTenantScope() reads and writes every tenant', async () => {
      await withoutTenantScope(async () => {
        assert.equal(await TsProject.count(), 3);
        assert.equal((await TsProject.createQueryBuilder('p').getMany()).length, 3);
        await TsProject.update({ id: alphaTwo.id }, { name: 'operator edit' });
      });
      const row = await runWithTenant(2, () => TsProject.findOneBy({ id: alphaTwo.id }));
      assert.equal(row?.name, 'operator edit');
    });

    it('runWithTenant inside withoutTenantScope scopes again', async () => {
      const rows = await withoutTenantScope(() => runWithTenant(2, () => TsProject.find()));
      assert.deepEqual(names(rows), ['two-a']);
    });

    it('ModelQuery.withoutTenantScope() opts out one query only', async () => {
      await runWithTenant(1, async () => {
        const all = await query<TsProject>(TsProject).withoutTenantScope().getMany();
        assert.equal(all.length, 3);
        assert.equal(await query<TsProject>(TsProject).withoutTenantScope().count(), 3);
        assert.equal(await query<TsProject>(TsProject).count(), 2);
      });
    });
  });
});

describe('tenantScoped — the query result cache', () => {
  @Entity('ts_cached')
  class TsCached extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'integer' })
    tenantId!: number;
  }
  tenantScoped('tenantId')(TsCached);

  /** An in-memory result cache: whatever is stored under an id is served for it. */
  function memoryCache(): QueryResultCache & { stored: number } {
    const entries = new Map<string, QueryResultCacheOptions>();
    const cache = {
      stored: 0,
      connect: async () => undefined,
      disconnect: async () => undefined,
      synchronize: async () => undefined,
      getFromCache: async (options: QueryResultCacheOptions) =>
        entries.get(options.identifier ?? options.query ?? ''),
      storeInCache: async (options: QueryResultCacheOptions) => {
        cache.stored += 1;
        entries.set(options.identifier ?? options.query ?? '', options);
      },
      isExpired: () => false,
      clear: async () => entries.clear(),
      remove: async () => undefined,
    };
    return cache;
  }

  let dataSource: DataSource;
  let cache: ReturnType<typeof memoryCache>;

  before(async () => {
    cache = memoryCache();
    // A plain TypeORM DataSource: JsailsDataSource refuses the cache outright,
    // but the guard patches every query builder, so it must hold here too.
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [TsCached],
      synchronize: true,
      cache: { provider: () => cache },
    });
    await dataSource.initialize();
    await withoutTenantScope(() => dataSource.getRepository(TsCached).save([{ tenantId: 1 }]));
  });

  after(async () => {
    await dataSource.destroy();
  });

  it('refuses a cached read of a tenant-scoped model, value-free', async () => {
    const repository = dataSource.getRepository(TsCached);
    await assert.rejects(
      runWithTenant(1, () => repository.find({ cache: { id: 'shared', milliseconds: 60_000 } })),
      (error: unknown) =>
        error instanceof TenantScopeError &&
        error.code === 'unsupported_query' &&
        !error.message.includes('shared'),
    );
    await assert.rejects(
      runWithTenant(2, () => repository.createQueryBuilder('c').cache('shared', 60_000).getMany()),
      TenantScopeError,
    );
    assert.equal(cache.stored, 0);
  });

  it('still reads without the cache, and outside the tenant scope', async () => {
    const repository = dataSource.getRepository(TsCached);
    assert.equal((await runWithTenant(1, () => repository.find())).length, 1);
    assert.equal((await runWithTenant(2, () => repository.find())).length, 0);
    const all = await withoutTenantScope(() =>
      repository.find({ cache: { id: 'operator', milliseconds: 60_000 } }),
    );
    assert.equal(all.length, 1);
  });
});
