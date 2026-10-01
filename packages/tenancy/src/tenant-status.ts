/**
 * The tenant status machine.
 *
 * A stored tenant is `active`, `suspended`, `pending_deletion` or `purging`;
 * `purged` is the terminal outcome, after which the tenant row no longer
 * exists. {@link nextTenantStatus} is the one transition table every lifecycle
 * operation consults, and it is total: every status and transition pair gives
 * a next status or `null` (refused).
 *
 * - An operator suspends and resumes an active tenant.
 * - Deletion can be scheduled from `active` or `suspended`; access stops at
 *   once. Cancelling it within the retention window restores the status the
 *   tenant had, so a suspended tenant does not come back active: the caller
 *   says whether the tenant carries a suspension.
 * - A purge first moves `pending_deletion` to `purging` (recorded in its own
 *   transaction) and later from `purging` to `purged`. Nothing leaves
 *   `purging` except the end of the purge, so a crash part-way leaves a status
 *   the sweep resumes from and a deletion that can no longer be cancelled.
 *
 * Only `active` tenants are accessible.
 */

/** A stored tenant status. */
export type TenantStatus = 'active' | 'suspended' | 'pending_deletion' | 'purging';

/** A change of tenant status. */
export type TenantTransition =
  'suspend' | 'resume' | 'schedule_deletion' | 'cancel_deletion' | 'begin_purge' | 'finish_purge';

/** Every stored status. */
export const TENANT_STATUSES: readonly TenantStatus[] = Object.freeze([
  'active',
  'suspended',
  'pending_deletion',
  'purging',
]);

/** Every transition. */
export const TENANT_TRANSITIONS: readonly TenantTransition[] = Object.freeze([
  'suspend',
  'resume',
  'schedule_deletion',
  'cancel_deletion',
  'begin_purge',
  'finish_purge',
]);

/** Context for {@link nextTenantStatus}. */
export interface TenantTransitionContext {
  /** Whether the tenant carries a suspension (only `cancel_deletion` reads it). */
  readonly suspended?: boolean;
}

/** A stored status value, or `null` when the value is not one. */
export function parseTenantStatus(value: unknown): TenantStatus | null {
  return TENANT_STATUSES.find((status) => status === value) ?? null;
}

/** The status after `transition`, `purged` at the end of a purge, or `null` when refused. */
export function nextTenantStatus(
  from: TenantStatus,
  transition: TenantTransition,
  context: TenantTransitionContext = {},
): TenantStatus | 'purged' | null {
  switch (from) {
    case 'active':
      if (transition === 'suspend') return 'suspended';
      if (transition === 'schedule_deletion') return 'pending_deletion';
      return null;
    case 'suspended':
      if (transition === 'resume') return 'active';
      if (transition === 'schedule_deletion') return 'pending_deletion';
      return null;
    case 'pending_deletion':
      if (transition === 'cancel_deletion')
        return context.suspended === true ? 'suspended' : 'active';
      if (transition === 'begin_purge') return 'purging';
      return null;
    case 'purging':
      return transition === 'finish_purge' ? 'purged' : null;
    default:
      return null;
  }
}

/** Whether members can use a tenant in this status. */
export function isTenantAccessible(status: TenantStatus): boolean {
  return status === 'active';
}
