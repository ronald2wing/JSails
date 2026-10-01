/**
 * The ambient tenant: runWithTenant, runWithoutTenant, withoutTenantScope,
 * their nesting, and the state shared across loaded copies.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  currentTenantId,
  runWithTenant,
  runWithoutTenant,
  tenantScopeShared,
  tenantScopeState,
  TenantScopeError,
  withoutTenantScope,
} from '../../src/database/tenant-context.js';

describe('tenant context', () => {
  it('has no tenant outside runWithTenant', () => {
    assert.equal(currentTenantId(), undefined);
    assert.deepEqual(tenantScopeState(), { tenantId: undefined, unscoped: false });
  });

  it('carries the tenant across awaits and returns the body result', async () => {
    const result = await runWithTenant('acme', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return currentTenantId();
    });
    assert.equal(result, 'acme');
    assert.equal(currentTenantId(), undefined);
  });

  it('nests: the innermost tenant wins and the outer one is restored', () => {
    runWithTenant(1, () => {
      runWithTenant(2, () => assert.equal(currentTenantId(), 2));
      assert.equal(currentTenantId(), 1);
    });
  });

  it('withoutTenantScope keeps the tenant but switches the scope off', () => {
    runWithTenant(7, () => {
      withoutTenantScope(() => {
        assert.deepEqual(tenantScopeState(), { tenantId: 7, unscoped: true });
        runWithTenant(8, () =>
          assert.deepEqual(tenantScopeState(), { tenantId: 8, unscoped: false }),
        );
      });
      assert.equal(tenantScopeState().unscoped, false);
    });
  });

  it('runWithoutTenant drops an inherited tenant and opt-out', async () => {
    await runWithTenant(3, () =>
      withoutTenantScope(async () => {
        const inner = await runWithoutTenant(async () => {
          await new Promise((resolve) => setImmediate(resolve));
          return tenantScopeState();
        });
        assert.deepEqual(inner, { tenantId: undefined, unscoped: false });
        assert.deepEqual(tenantScopeState(), { tenantId: 3, unscoped: true });
      }),
    );
  });

  it('keeps its state on globalThis so every loaded copy shares it', () => {
    const key = Symbol.for('jsails.tenantScope.state.v1');
    assert.equal((globalThis as unknown as Record<symbol, unknown>)[key], tenantScopeShared());
  });

  it('rejects an empty or non-finite tenant id', () => {
    for (const bad of ['', Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}]) {
      assert.throws(
        () => runWithTenant(bad as never, () => undefined),
        (error: unknown) => error instanceof TenantScopeError && error.code === 'invalid_tenant',
      );
    }
  });
});
