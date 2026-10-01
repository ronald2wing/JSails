/**
 * The ambient tenant behind `tenantScoped` models: a key of the execution
 * context (`jsails/context`) holding the current tenant id and whether the
 * tenant scope is switched off.
 *
 * `@jsails/tenancy` sets the tenant for a request once membership is enforced;
 * a job, a command, or a test sets it explicitly with {@link runWithTenant}.
 * The query guard (tenant-scope.ts) reads {@link tenantScopeState} every time
 * it generates SQL for a tenant-scoped model, so the tenant that applies is the
 * one current when the query runs (a subquery built earlier reads it through
 * parameters the outer query binds as it runs). Its own module so the guard
 * and the tenancy plugin share one key without importing each other.
 *
 * The tenant is a propagated key: a job dispatched while a tenant is current
 * carries that tenant id and runs in it. Only the id travels; a switched-off
 * scope ({@link withoutTenantScope}) never leaves the process, so a carrier
 * can at most name a tenant, and a carried id is validated like any other
 * before it applies.
 *
 * The execution context and the guard's registry are each shared by every
 * loaded copy of jsails (the context's storage and key registry on
 * `globalThis`, the registry in one object there too), so when two copies are
 * loaded (an app's and a plugin's nested one), a model registered or a tenant
 * set through either copy is seen by the one guard installed on TypeORM's
 * query builders. Module-local state would let the installed guard read a
 * registry the app never wrote to and fail open.
 */

import type { EntityMetadata } from 'typeorm';
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata.js';

import { createContextKey, getContext, withContext } from '../context/execution-context.js';
import { JsailsError } from '../errors/jsails-error.js';

/** A tenant's primary key as the tenant column stores it. */
export type TenantId = string | number;

/** Machine-readable reason for a {@link TenantScopeError}. */
export type TenantScopeErrorCode =
  | 'invalid_tenant'
  | 'invalid_column'
  | 'duplicate_registration'
  | 'no_tenant'
  | 'tenant_mismatch'
  | 'unsupported_write'
  | 'unsupported_query';

/** Raised for a tenant-scope declaration or a query the guard refuses. Value-free. */
export class TenantScopeError extends JsailsError {
  constructor(
    readonly code: TenantScopeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What the guard sees for the current async context. */
export interface TenantScopeState {
  /** The current tenant, or `undefined` when none was set. */
  readonly tenantId: TenantId | undefined;
  /** True inside {@link withoutTenantScope}: tenant-scoped models are not filtered. */
  readonly unscoped: boolean;
}

const NO_TENANT: TenantScopeState = Object.freeze({ tenantId: undefined, unscoped: false });

/** A resolved tenant column, valid while no further model has been registered. */
export interface CachedTenantColumn {
  /** The registration count the lookup was made at. */
  readonly generation: number;
  /** The tenant column, or `null` for an entity that is not scoped. */
  readonly column: ColumnMetadata | null;
}

/** The guard state every loaded copy of jsails shares. */
export interface TenantScopeShared {
  /** The tenant column (a property name) per model constructor. */
  readonly registry: WeakMap<Function, string>;
  /** Resolved tenant columns per entity metadata. */
  readonly columns: WeakMap<EntityMetadata, CachedTenantColumn>;
  /** How many models were registered; also invalidates {@link columns}. */
  generation: number;
}

const SHARED_KEY = Symbol.for('jsails.tenantScope.state.v2');

function createShared(): TenantScopeShared {
  return {
    registry: new WeakMap(),
    columns: new WeakMap(),
    generation: 0,
  };
}

const holder = globalThis as unknown as Record<symbol, TenantScopeShared | undefined>;
const shared: TenantScopeShared = (holder[SHARED_KEY] ??= createShared());

/** The guard state shared across loaded copies (read by tenant-scope.ts). */
export function tenantScopeShared(): TenantScopeShared {
  return shared;
}

function assertTenantId(tenantId: unknown): asserts tenantId is TenantId {
  const valid =
    (typeof tenantId === 'string' && tenantId.length > 0) ||
    (typeof tenantId === 'number' && Number.isFinite(tenantId));
  if (!valid) {
    throw new TenantScopeError(
      'invalid_tenant',
      'tenant id must be a non-empty string or a finite number',
    );
  }
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
  const valid =
    (typeof tenantId === 'string' && tenantId.length > 0) ||
    (typeof tenantId === 'number' && Number.isFinite(tenantId));
  return valid ? Object.freeze({ tenantId: tenantId as TenantId, unscoped: false }) : undefined;
}

const tenantKey = createContextKey<TenantScopeState>('jsails.tenant', {
  propagate: {
    encode: (state) => (state.tenantId === undefined ? undefined : JSON.stringify(state.tenantId)),
    decode: decodeTenant,
  },
});

/**
 * Run `fn` with `tenantId` as the current tenant. Every tenant-scoped query
 * made inside it, including from promises it starts, is filtered to that
 * tenant and every insert is stamped with it. It also re-enables the scope
 * inside a {@link withoutTenantScope} body.
 *
 * @throws {TenantScopeError} (`invalid_tenant`) for an empty or non-finite id.
 */
export function runWithTenant<T>(tenantId: TenantId, fn: () => T): T {
  assertTenantId(tenantId);
  return withContext(tenantKey, Object.freeze({ tenantId, unscoped: false }), fn);
}

/**
 * Run `fn` with the tenant scope switched off: tenant-scoped models read and
 * write every tenant's rows, and inserts keep the tenant column they were
 * given. This is the explicit opt-out for cross-tenant work (an operator
 * report, a maintenance job); keep the call visible at the site that needs it.
 */
export function withoutTenantScope<T>(fn: () => T): T {
  const current = getContext(tenantKey) ?? NO_TENANT;
  return withContext(tenantKey, Object.freeze({ tenantId: current.tenantId, unscoped: true }), fn);
}

/**
 * Run `fn` with no current tenant and the scope on, whatever the caller's
 * context: tenant-scoped reads return nothing and writes are refused until
 * `fn` sets a tenant itself. Background work started from a request (a job
 * run in-process, a timer, a poll) uses it so it never inherits the tenant
 * of whichever request happened to start it.
 */
export function runWithoutTenant<T>(fn: () => T): T {
  return withContext(tenantKey, NO_TENANT, fn);
}

/** The current tenant id, or `undefined` outside {@link runWithTenant}. */
export function currentTenantId(): TenantId | undefined {
  return getContext(tenantKey)?.tenantId;
}

/** The guard's view of the current async context. */
export function tenantScopeState(): TenantScopeState {
  return getContext(tenantKey) ?? NO_TENANT;
}
