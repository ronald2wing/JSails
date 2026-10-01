/**
 * Audit finding "Tenant guard escape through TypeORM's result cache with an
 * explicit cache id", on every driver: a read cached under an explicit id is
 * served to whoever asks for that id next, whatever tenant scope the asker
 * runs in. M0 made JsailsDataSource refuse the `cache` option and the tenant
 * guard refuse a cached read of a scoped model; DAT-05 moves tenant policy into
 * a statement rewrite, and the owned API has no result cache.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { JsailsDataSource } from '../../../src/database/data-source.js';
import {
  runWithTenant,
  TenantScopeError,
  withoutTenantScope,
} from '../../../src/database/tenant-context.js';
import { tenantScoped } from '../../../src/database/tenant-scope.js';
import { MigrationError } from '../../../src/migrations/schema-types.js';
import { matrixDriver, matrixServer, openMatrixDataSource } from './matrix-database.js';

function makeInvoice() {
  @Entity('regression_invoices')
  class Invoice extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'integer' })
    tenantId!: number;
  }
  tenantScoped('tenantId')(Invoice);
  return Invoice;
}

describe('the TypeORM query result cache and the tenant guard', () => {
  it('JsailsDataSource refuses the cache option for this driver', () => {
    const driver = matrixDriver();
    const connection =
      driver === 'sqlite'
        ? ({ type: 'sqljs', location: 'never-opened.sqlite' } as const)
        : { ...matrixServer(), database: 'never_opened' };
    assert.throws(
      () => new JsailsDataSource({ ...connection, cache: true }),
      (error: unknown) => error instanceof MigrationError && error.code === 'invalid_options',
    );
  });

  it('a read cached under an explicit id is never served to another tenant', async (t) => {
    const Invoice = makeInvoice();
    const dataSource = await openMatrixDataSource(t, { entities: [Invoice] });
    const repository = dataSource.getRepository(Invoice);
    await withoutTenantScope(() => repository.save([{ tenantId: 1 }, { tenantId: 2 }]));
    const cachedRead = () => repository.find({ cache: { id: 'invoices', milliseconds: 60_000 } });

    const first = await runWithTenant(1, cachedRead).catch((error: unknown) => error);
    const second = await runWithTenant(2, cachedRead).catch((error: unknown) => error);

    // Either the guard refuses the cached read, or each tenant gets its own rows.
    for (const [tenant, outcome] of [
      [1, first],
      [2, second],
    ] as const) {
      if (outcome instanceof TenantScopeError) {
        assert.equal(outcome.code, 'unsupported_query');
      } else {
        assert.ok(
          Array.isArray(outcome),
          `tenant ${tenant}'s cached read failed: ${String(outcome)}`,
        );
        assert.deepEqual(
          outcome.map((invoice) => invoice.tenantId),
          [tenant],
        );
      }
    }
  });
});
