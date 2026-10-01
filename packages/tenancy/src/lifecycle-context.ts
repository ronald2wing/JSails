/**
 * What every tenancy lifecycle operation shares: the clock, the transaction
 * runner, the authorization step, audit appends and event emission.
 *
 * Authorization happens inside the operation's transaction, after the tenant
 * row is locked, so the role it reads cannot change before the write it
 * guards (no time-of-check to time-of-use gap). An {@link AccessRule} states,
 * per operation:
 *
 * - the permission a user actor's membership role must hold (or `null` when
 *   membership alone suffices), and the tenant statuses a user may act in;
 *   a member acting on an inactive tenant gets `tenant_inactive`;
 * - whether an operator may act, and whether they need an open grant (any,
 *   or one allowing writes);
 * - whether a system actor may act.
 *
 * A user who is not a member and a tenant that does not exist both give a
 * user `not_permitted`, so the lifecycle is not an oracle for which tenant
 * ids exist; operators and system actors get `not_found`. Nobody acts on a
 * tenant that is being purged (`purge_in_progress`) unless the rule says so.
 *
 * {@link LifecycleContext.transaction} retries an operation that lost a
 * deadlock or a lock wait (`transaction_conflict`). That is safe because an
 * operation's only side effects are its writes and its events, and events are
 * queued with `afterCommit`, so a retried attempt leaves nothing behind.
 *
 * The app's event listener runs after the commit and is isolated from it: a
 * throw, or a rejection of the promise an async listener returns, goes to
 * `onEmitError` (and a failing `onEmitError` to `process.emitWarning`), so a
 * mail outage can neither crash the process nor fail an operation that has
 * already committed.
 */

import type { CheckedActor } from './tenancy-actor.js';
import { TenancyError, type TenancyErrorCode } from './tenancy-error.js';
import type { TenancyEvent } from './tenancy-events.js';
import {
  enforcedLimits,
  warnEmitError,
  type EnforcedLimits,
  type ResolvedLifecycleOptions,
} from './tenancy-lifecycle-options.js';
import type { TenantAuditAction, TenantSummary } from './tenancy-records.js';
import type { TenancyTx } from './tenancy-store.js';
import { isTenantId, type TenantId } from './tenant-id.js';
import { OWNER_ROLE, type TenancyPermission } from './tenant-roles.js';
import type { TenantStatus } from './tenant-status.js';

/** Who may perform one operation, and on a tenant in which status. */
export interface AccessRule<P extends string> {
  /** Whether a user actor may act at all; `true` when omitted. */
  readonly user?: boolean;
  /** The permission a user's role must hold; `null` when membership suffices. */
  readonly permission: P | TenancyPermission | null;
  /** Statuses a user may act in; `['active']` when omitted. */
  readonly userStatuses?: readonly TenantStatus[];
  /** Whether an operator may act, and with which grant. */
  readonly operator: 'refused' | 'allowed' | 'grant' | 'write_grant';
  readonly system: boolean;
  /** Whether the operation may run on a tenant that is being purged. */
  readonly purging?: boolean;
  /** Lock the tenant row (every operation that writes); a read passes `false`. */
  readonly lock?: boolean;
}

/** The outcome of authorization: the tenant as locked and the actor's role. */
export interface Access<R extends string> {
  readonly tenant: TenantSummary;
  /** The user's stored role; `null` for an operator or system actor. */
  readonly role: R | typeof OWNER_ROLE | null;
}

const ACTIVE_ONLY: readonly TenantStatus[] = Object.freeze(['active']);

/** The `code` of a thrown value, if it has one. */
export function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof Reflect.get(value, 'then') === 'function'
  );
}

/** Refuse with a tenancy code. */
export function refuse(code: TenancyErrorCode): never {
  throw new TenancyError(code);
}

/** A tenant id from a caller. Throws `invalid_tenant_id`. */
export function requireTenantId(value: unknown): TenantId {
  if (!isTenantId(value)) {
    refuse('invalid_tenant_id');
  }
  return value;
}

/** The state shared by every operation of one lifecycle. */
export class LifecycleContext<R extends string, P extends string, S> {
  readonly options: ResolvedLifecycleOptions<R, P, S>;

  constructor(options: ResolvedLifecycleOptions<R, P, S>) {
    this.options = options;
  }

  /** The current time. Throws `invalid_lifecycle_options` when the clock gives no valid date. */
  now(): Date {
    const value: unknown = this.options.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      refuse('invalid_lifecycle_options');
    }
    return new Date(value.getTime());
  }

  /** Run `body` in a store transaction, retrying a lost deadlock or lock wait. */
  async transaction<T>(body: (tx: TenancyTx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.options.store.transaction(body);
      } catch (error) {
        if (
          attempt >= this.options.conflictRetries ||
          errorCode(error) !== 'transaction_conflict'
        ) {
          throw error;
        }
      }
    }
  }

  /** Queue an event for after the commit. */
  emit(tx: TenancyTx, event: TenancyEvent): void {
    const frozen = Object.freeze(event);
    tx.afterCommit(() => this.deliver(frozen));
  }

  /** Hand one committed event to the listener; never throws or leaves a rejection unhandled. */
  private deliver(event: TenancyEvent): void {
    const failed = (error: unknown): void => {
      try {
        this.options.onEmitError(error, event.type);
      } catch (reportError) {
        warnEmitError(reportError, event.type);
      }
    };
    try {
      const returned: unknown = this.options.emit(event);
      if (isThenable(returned)) {
        returned.then(undefined, failed);
      }
    } catch (error) {
      failed(error);
    }
  }

  /** Append an audit record in the operation's transaction. */
  async audit(
    tx: TenancyTx,
    tenantId: TenantId,
    at: Date,
    actor: CheckedActor,
    action: TenantAuditAction,
    target: string | null,
  ): Promise<void> {
    await tx.appendAudit({
      tenantId,
      at,
      actor: actor.audit,
      action,
      target,
      reason: actor.reason,
      traceId: null,
    });
  }

  /** The limits of a tenant, as the app's hook gives them. */
  async limits(tenant: TenantSummary): Promise<EnforcedLimits> {
    return enforcedLimits(await this.options.limits(tenant));
  }

  /**
   * Lock (or read) the tenant and check that `actor` may perform an operation
   * under `rule` at `at`. Throws `not_permitted`, `not_found`,
   * `tenant_inactive` or `purge_in_progress`.
   */
  async access(
    tx: TenancyTx,
    tenantId: TenantId,
    actor: CheckedActor,
    rule: AccessRule<P>,
    at: Date,
  ): Promise<Access<R>> {
    const tenant =
      rule.lock === false ? await tx.tenantById(tenantId) : await tx.lockTenant(tenantId);
    const subject = actor.actor;
    if (subject.kind === 'user') {
      if (tenant === null || rule.user === false) {
        refuse('not_permitted');
      }
      const membership = await tx.membership(tenantId, subject.userId);
      const role = membership === null ? null : this.options.roles.parse(membership.role);
      if (role === null) {
        refuse('not_permitted');
      }
      if (rule.permission !== null && !this.options.roles.allows(role, rule.permission)) {
        refuse('not_permitted');
      }
      if (!(rule.userStatuses ?? ACTIVE_ONLY).includes(tenant.status)) {
        refuse(tenant.status === 'purging' ? 'purge_in_progress' : 'tenant_inactive');
      }
      return Object.freeze({ tenant, role });
    }
    if (subject.kind === 'operator' ? rule.operator === 'refused' : !rule.system) {
      refuse('not_permitted');
    }
    if (tenant === null) {
      refuse('not_found');
    }
    if (tenant.status === 'purging' && rule.purging !== true) {
      refuse('purge_in_progress');
    }
    if (subject.kind === 'operator' && rule.operator !== 'allowed') {
      const grant = await tx.activeOperatorGrant(tenantId, subject.userId, at);
      if (grant === null || (rule.operator === 'write_grant' && !grant.write)) {
        refuse('not_permitted');
      }
    }
    return Object.freeze({ tenant, role: null });
  }
}
