/**
 * The ambient tenant the statement policy reads: a key of the execution
 * context (`jsails/context`) holding the current tenant id and whether the
 * scope is switched off.
 *
 * The key is `jsails.tenant`, the one the old data stack and
 * `@jsails/tenancy` already write. `createContextKey` hands every caller the
 * key registered under a name, so `runWithTenant` from either stack sets the
 * one slot both read, and there is no second store. The value keeps the
 * shape the old stack writes (`{ tenantId, unscoped }`), and the propagation
 * codec is the same: only the id travels into a job, a switched-off scope
 * never leaves the process, and a carried id is checked like any other.
 */

import { createContextKey, getContext, withContext } from 'jsails/context';

import { TenantScopeErrors } from './statement-errors.js';

/** A tenant's primary key as the application holds it. */
export type TenantId = string | number;

/** The tenant scope of the current async context. */
export interface TenantScopeState {
  /** The current tenant, or `undefined` when none is set. */
  readonly tenantId: TenantId | undefined;
  /** True inside {@link withoutTenantScope}: statements are not scoped. */
  readonly unscoped: boolean;
}

const NO_TENANT: TenantScopeState = Object.freeze({ tenantId: undefined, unscoped: false });

function isTenantId(value: unknown): value is TenantId {
  return (
    (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** A carried tenant id: its JSON text, so a numeric id comes back a number. */
function decodeTenant(text: string): TenantScopeState | undefined {
  let tenantId: unknown;
  try {
    tenantId = JSON.parse(text);
  } catch {
    // Not JSON, so not a tenant this process wrote: the restore refuses it.
    return undefined;
  }
  return isTenantId(tenantId) ? Object.freeze({ tenantId, unscoped: false }) : undefined;
}

const tenantKey = createContextKey<TenantScopeState>('jsails.tenant', {
  propagate: {
    encode: (state) => (state.tenantId === undefined ? undefined : JSON.stringify(state.tenantId)),
    decode: decodeTenant,
  },
});

/**
 * Run `fn` with `tenantId` as the current tenant: every statement on a
 * tenant-scoped table made inside it, including from promises it starts, is
 * filtered to that tenant and every insert is stamped with it. It also
 * switches the scope back on inside a {@link withoutTenantScope} body.
 *
 * @throws `tenant_scope.invalid_tenant_id` for an empty or non-finite id.
 */
export function runWithTenant<T>(tenantId: TenantId, fn: () => T): T {
  if (!isTenantId(tenantId)) throw new TenantScopeErrors.Error('invalid_tenant_id');
  return withContext(tenantKey, Object.freeze({ tenantId, unscoped: false }), fn);
}

/**
 * Run `fn` with the tenant scope switched off: statements read and write
 * every tenant's rows and inserts keep the tenant they name. This is the only
 * opt-out; every statement it lets through on a tenant-scoped table is
 * recorded in the query ledger with the origin {@link TENANT_UNSCOPED_ORIGIN}.
 */
export function withoutTenantScope<T>(fn: () => T): T {
  const current = getContext(tenantKey) ?? NO_TENANT;
  return withContext(tenantKey, Object.freeze({ tenantId: current.tenantId, unscoped: true }), fn);
}

/**
 * Run `fn` with no current tenant and the scope on, whatever the caller's
 * context: tenant-scoped reads return nothing and writes are refused until
 * `fn` sets a tenant. Background work started from a request uses it so it
 * never inherits that request's tenant.
 */
export function runWithoutTenant<T>(fn: () => T): T {
  return withContext(tenantKey, NO_TENANT, fn);
}

/** The tenant scope of the current async context. */
export function currentTenantScope(): TenantScopeState {
  return getContext(tenantKey) ?? NO_TENANT;
}

/** The query-ledger origin of a statement {@link withoutTenantScope} let through unscoped. */
export const TENANT_UNSCOPED_ORIGIN = 'tenant-unscoped';
