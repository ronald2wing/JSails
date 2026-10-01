/**
 * The periodic tenancy sweep: due purges, expired invitations and audit
 * retention.
 *
 * A scheduled job calls {@link TenancySweep.sweep} with the app's data purge.
 * Each part is bounded by `limit` per call, so one run never holds the store
 * for long; a backlog drains over successive runs.
 *
 * - Purges: every tenant whose deletion is due, and every tenant left
 *   `purging` by an interrupted purge, is purged (or resumed) as the system.
 *   One failing tenant does not stop the others; its error is returned with
 *   its id and the tenant stays `purging` for the next run.
 * - Invitations past their expiry are deleted and audited, so open
 *   invitations do not hold seats or addresses after they lapse.
 * - Audit records older than the retention period (400 days by default) are
 *   deleted, including those of purged tenants, so the trail of a deleted
 *   tenant does not outlive its documented retention.
 *
 * Domain re-verification needs DNS and has its own entry point,
 * `recheckDomains`.
 */

import { systemActor } from './tenancy-actor.js';
import { refuse, type LifecycleContext } from './lifecycle-context.js';
import type { TenantId } from './tenant-id.js';
import { MAX_BATCH_LIMIT } from './tenancy-store.js';
import type { PurgeData, TenantOperations } from './tenant-operations.js';

/** Options of one sweep run. */
export interface SweepOptions {
  readonly purgeData: PurgeData;
  /** Items per part, 1 to 1000; default 100. */
  readonly limit?: number;
}

/** A purge that failed during a sweep. */
export interface PurgeFailure {
  readonly tenantId: TenantId;
  readonly error: unknown;
}

/** What one sweep run did. */
export interface SweepReport {
  readonly purged: readonly TenantId[];
  readonly purgeFailures: readonly PurgeFailure[];
  readonly invitationsExpired: number;
  readonly auditPruned: number;
}

/** The sweep entry point of the lifecycle. */
export interface TenancySweep {
  sweep(options: SweepOptions): Promise<SweepReport>;
}

/** Build the sweep on a lifecycle context and its tenant operations. */
export function tenancySweep<R extends string, P extends string, S>(
  ctx: LifecycleContext<R, P, S>,
  tenants: Pick<TenantOperations<S>, 'purge'>,
): TenancySweep {
  const { store } = ctx.options;
  return {
    async sweep(options) {
      if (
        typeof options !== 'object' ||
        options === null ||
        typeof options.purgeData !== 'function'
      ) {
        refuse('invalid_lifecycle_options');
      }
      const limit = options.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_LIMIT) {
        refuse('invalid_lifecycle_options');
      }
      const at = ctx.now();

      const purged: TenantId[] = [];
      const purgeFailures: PurgeFailure[] = [];
      const retention = { kind: 'system', reason: 'deletion retention elapsed' } as const;
      for (const tenant of await store.tenantsDueForPurge(at, limit)) {
        try {
          await tenants.purge(tenant.id, retention, options.purgeData);
          purged.push(tenant.id);
        } catch (error) {
          purgeFailures.push(Object.freeze({ tenantId: tenant.id, error }));
        }
      }

      const expiry = systemActor('invitation expired');
      let invitationsExpired = 0;
      for (const invitation of await store.invitationsExpiredBefore(at, limit)) {
        const deleted = await ctx.transaction(async (tx) => {
          if (!(await tx.deleteInvitation(invitation.id))) {
            return false;
          }
          await ctx.audit(
            tx,
            invitation.tenantId,
            at,
            expiry,
            'member.invitation_expired',
            String(invitation.id),
          );
          return true;
        });
        if (deleted) {
          invitationsExpired += 1;
        }
      }

      const auditPruned = await ctx.transaction((tx) =>
        tx.deleteAuditBefore(new Date(at.getTime() - ctx.options.auditRetentionMs), limit),
      );

      return Object.freeze({
        purged: Object.freeze(purged),
        purgeFailures: Object.freeze(purgeFailures),
        invitationsExpired,
        auditPruned,
      });
    },
  };
}
