/**
 * The tenancy lifecycle service: every change to tenants, memberships,
 * invitations, domains and operator grants, on the store port.
 *
 * {@link createTenancyLifecycle} composes the operation groups
 * (`tenant-operations.ts`, `membership-operations.ts`,
 * `domain-operations.ts`, `operator-grants.ts`, `tenancy-sweep.ts`) over one
 * {@link LifecycleContext}. Every operation keeps the same discipline:
 *
 * - one store transaction, which locks the tenant row before it reads what
 *   it is about to change, so concurrent operations on a tenant serialise and
 *   checks such as seats, the single owner and the rank rule cannot race;
 * - the actor's role is read inside that transaction and the role set's
 *   permission, rank and owner rules are enforced there (`not_permitted`,
 *   `role_not_assignable`, `owner_required`), so a route policy that calls the
 *   same role set and the service never disagree;
 * - every committed change appends its audit record in the same transaction;
 * - events are queued with `afterCommit`, so a rolled-back operation emits
 *   nothing.
 *
 * The service is internal for now: it is not exported from the package
 * barrel until the access context and plugin wiring land, because its actor
 * and options types follow those.
 */

import { domainOperations, type DomainOperations } from './domain-operations.js';
import { LifecycleContext } from './lifecycle-context.js';
import { membershipOperations, type MembershipOperations } from './membership-operations.js';
import { operatorGrantOperations, type OperatorGrantOperations } from './operator-grants.js';
import {
  resolveLifecycleOptions,
  type TenancyLifecycleOptions,
} from './tenancy-lifecycle-options.js';
import { tenancySweep, type TenancySweep } from './tenancy-sweep.js';
import { tenantOperations, type TenantOperations } from './tenant-operations.js';

/** The tenancy lifecycle service. */
export interface TenancyLifecycle<R extends string, S>
  extends
    TenantOperations<S>,
    MembershipOperations<R>,
    DomainOperations,
    OperatorGrantOperations,
    TenancySweep {}

/**
 * Build a lifecycle on a store. Throws `invalid_lifecycle_options` when an
 * option is missing or out of range.
 */
export function createTenancyLifecycle<R extends string, P extends string, S>(
  options: TenancyLifecycleOptions<R, P, S>,
): TenancyLifecycle<R, S> {
  const ctx = new LifecycleContext(resolveLifecycleOptions(options));
  const tenants = tenantOperations(ctx);
  return Object.freeze({
    ...tenants,
    ...membershipOperations(ctx),
    ...domainOperations(ctx),
    ...operatorGrantOperations(ctx),
    ...tenancySweep(ctx, tenants),
  });
}
