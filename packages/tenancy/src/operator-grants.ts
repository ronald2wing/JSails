/**
 * Time-boxed operator access to a tenant.
 *
 * An operator (app staff, authorised by the app's own policy before calling
 * in) opens a grant on one tenant with a reason and a duration no longer than
 * the configured maximum (one hour by default). A grant is read-only unless
 * `write` is requested, which is audited as its own action. It is not
 * impersonation: the operator stays the actor of everything they do, and the
 * lifecycle requires a write grant before an operator changes a tenant's
 * content (members, settings, domains, name, plan, ownership).
 *
 * Opening a grant closes the operator's earlier open grants on the same
 * tenant, so an operator holds at most one at a time. A grant ends at its
 * expiry or when closed early by the operator, another operator, a system
 * actor, or a tenant user who holds `members.remove` (the people who can take
 * access away from a member can take it from staff too).
 */

import { checkActor, type TenancyActor } from './tenancy-actor.js';
import {
  refuse,
  requireTenantId,
  type AccessRule,
  type LifecycleContext,
} from './lifecycle-context.js';
import type { OperatorGrant } from './tenancy-records.js';
import type { TenantId } from './tenant-id.js';
import { TENANT_STATUSES, type TenantStatus } from './tenant-status.js';

/** The shortest grant. */
const MIN_GRANT_MS = 60_000;

/** The input of `openOperatorGrant`. */
export interface OperatorGrantRequest {
  /** From one minute to the configured maximum. */
  readonly durationMs: number;
  /** Whether the grant allows changes; `false` by default. */
  readonly write?: boolean;
}

/** The operator-grant operations of the lifecycle. */
export interface OperatorGrantOperations {
  /** Open a grant for the acting operator; the actor's reason is the grant's reason. */
  openOperatorGrant(
    tenantId: TenantId,
    request: OperatorGrantRequest,
    by: TenancyActor,
  ): Promise<OperatorGrant>;
  /** Close a grant early; `false` when it had already ended. */
  closeOperatorGrant(tenantId: TenantId, grantId: number, by: TenancyActor): Promise<boolean>;
}

const NOT_PURGING: readonly TenantStatus[] = Object.freeze(
  TENANT_STATUSES.filter((status) => status !== 'purging'),
);

/** Build the operator-grant operations on a lifecycle context. */
export function operatorGrantOperations<R extends string, P extends string, S>(
  ctx: LifecycleContext<R, P, S>,
): OperatorGrantOperations {
  const open: AccessRule<P> = Object.freeze({
    user: false,
    permission: null,
    operator: 'allowed',
    system: false,
  });
  const close: AccessRule<P> = Object.freeze({
    permission: 'members.remove',
    operator: 'allowed',
    system: true,
    userStatuses: NOT_PURGING,
  });

  return {
    async openOperatorGrant(tenantId, request, by) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      if (actor.actor.kind !== 'operator' || actor.reason === null) {
        refuse('not_permitted');
      }
      const operatorId = actor.actor.userId;
      const reason = actor.reason;
      if (typeof request !== 'object' || request === null) {
        refuse('invalid_grant');
      }
      const { durationMs } = request;
      const write = request.write ?? false;
      if (
        !Number.isSafeInteger(durationMs) ||
        durationMs < MIN_GRANT_MS ||
        durationMs > ctx.options.operatorGrantMaxMs ||
        typeof write !== 'boolean'
      ) {
        refuse('invalid_grant');
      }
      const at = ctx.now();
      return ctx.transaction(async (tx) => {
        await ctx.access(tx, id, actor, open, at);
        if ((await tx.closeOperatorGrants(id, operatorId, at)) > 0) {
          await ctx.audit(tx, id, at, actor, 'operator.access_closed', operatorId);
        }
        const grant = await tx.insertOperatorGrant({
          tenantId: id,
          operatorId,
          reason,
          write,
          openedAt: at,
          expiresAt: new Date(at.getTime() + durationMs),
        });
        await ctx.audit(
          tx,
          id,
          at,
          actor,
          write ? 'operator.write_access_opened' : 'operator.access_opened',
          String(grant.id),
        );
        ctx.emit(tx, {
          type: 'operator_grant',
          tenantId: id,
          grantId: grant.id,
          operatorId,
          change: 'opened',
        });
        return grant;
      });
    },

    async closeOperatorGrant(tenantId, grantId, by) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      const at = ctx.now();
      return ctx.transaction(async (tx) => {
        await ctx.access(tx, id, actor, close, at);
        const grant =
          Number.isSafeInteger(grantId) && grantId > 0 ? await tx.operatorGrant(grantId) : null;
        if (grant === null || grant.tenantId !== id) {
          refuse('not_found');
        }
        if (grant.closedAt !== null || grant.expiresAt.getTime() <= at.getTime()) {
          return false;
        }
        await tx.closeOperatorGrant(grant.id, at);
        await ctx.audit(tx, id, at, actor, 'operator.access_closed', String(grant.id));
        ctx.emit(tx, {
          type: 'operator_grant',
          tenantId: id,
          grantId: grant.id,
          operatorId: grant.operatorId,
          change: 'closed',
        });
        return true;
      });
    },
  };
}
