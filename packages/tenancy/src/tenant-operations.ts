/**
 * Lifecycle operations on the tenant row: create, rename, plan, settings,
 * ownership transfer, suspension, scheduled deletion and the purge.
 *
 * Ownership lives in the membership whose role is `owner`; the tenant row's
 * `ownerUserId` mirrors it and both change in the same locked transaction
 * (the store refuses to commit anything else). A transfer needs the new owner
 * to be a member already, and the old owner takes the most privileged defined
 * role, losing the open invitations that role could not have sent.
 *
 * Rename, plan and settings changes read their input only after
 * authorization, so someone who may not act on the tenant gets
 * `not_permitted` whatever they send, and the settings parser's issues never
 * reach them.
 *
 * Suspension is an operator or system action with a reason. Deletion is
 * scheduled by whoever holds `tenant.delete` (the owner, by default) and can
 * be cancelled until the purge starts; cancelling restores a suspension the
 * tenant carried, so scheduling and cancelling cannot lift one.
 *
 * The purge runs in three phases, because deleting every tenant-scoped row of
 * the app cannot be one transaction:
 *
 * 1. one transaction moves `pending_deletion` to `purging` (refused before
 *    the deletion is due) and records it;
 * 2. the injected `purgeData` deletes the app's data for the tenant, outside
 *    any lifecycle transaction; it must be idempotent, because
 * 3. only the final transaction deletes the tenancy rows and records
 *    `tenant.purged`. A crash in between leaves `purging`, which nothing
 *    but a purge leaves, so the next sweep resumes at phase 2.
 */

import { checkActor, parseUserId, type CheckedActor, type TenancyActor } from './tenancy-actor.js';
import {
  refuse,
  requireTenantId,
  type AccessRule,
  type LifecycleContext,
} from './lifecycle-context.js';
import { revokeUnsendableInvitations } from './membership-operations.js';
import { checkSlug, type SlugPolicy } from './slug-policy.js';
import type { TenantAuditAction, TenantPatch, TenantSummary } from './tenancy-records.js';
import type { TenancyTx } from './tenancy-store.js';
import type { TenantId } from './tenant-id.js';
import {
  parseTenantName,
  parseTenantPlan,
  readTenantSettings,
  serializeTenantSettings,
} from './tenant-profile.js';
import { OWNER_ROLE } from './tenant-roles.js';
import {
  nextTenantStatus,
  TENANT_STATUSES,
  type TenantStatus,
  type TenantTransition,
} from './tenant-status.js';

/** The input of `create`. */
export interface NewTenantInput {
  readonly name: string;
  readonly slug: string;
  readonly plan?: string | null;
  /** Raw settings for the app's parser; `{}` when omitted. */
  readonly settings?: unknown;
}

/** Deletes the app's own data for a tenant; idempotent and resumable. */
export type PurgeData = (tenantId: TenantId) => Promise<void>;

/** The tenant-row operations of the lifecycle. */
export interface TenantOperations<S> {
  /**
   * Create a tenant. A user actor becomes its owner; a system actor names the
   * owner. Throws `invalid_slug`, `reserved_slug`, `slug_taken`,
   * `invalid_name`, `invalid_plan`, `invalid_settings` or `not_permitted`.
   */
  create(input: NewTenantInput, by: TenancyActor, owner?: string): Promise<TenantSummary>;
  rename(tenantId: TenantId, name: string, by: TenancyActor): Promise<TenantSummary>;
  setPlan(tenantId: TenantId, plan: string | null, by: TenancyActor): Promise<TenantSummary>;
  /** The tenant's settings, parsed with defaults. */
  settings(tenantId: TenantId, by: TenancyActor): Promise<S>;
  updateSettings(tenantId: TenantId, settings: unknown, by: TenancyActor): Promise<S>;
  /** Hand the tenant to another member; the old owner takes the top defined role. */
  transferOwnership(tenantId: TenantId, toUserId: string, by: TenancyActor): Promise<TenantSummary>;
  suspend(tenantId: TenantId, by: TenancyActor): Promise<TenantSummary>;
  resume(tenantId: TenantId, by: TenancyActor): Promise<TenantSummary>;
  scheduleDeletion(tenantId: TenantId, by: TenancyActor): Promise<TenantSummary>;
  cancelDeletion(tenantId: TenantId, by: TenancyActor): Promise<TenantSummary>;
  /**
   * Purge a tenant whose deletion is due, or resume one that is `purging`.
   * System actors only. Throws `purge_not_due`, `invalid_transition` or
   * `not_found`; a `purgeData` failure leaves the tenant `purging`.
   */
  purge(tenantId: TenantId, by: TenancyActor, purgeData: PurgeData): Promise<void>;
}

/** Owners may schedule or cancel a deletion while suspended; the status machine refuses the rest. */
const NOT_PURGING: readonly TenantStatus[] = Object.freeze(
  TENANT_STATUSES.filter((status) => status !== 'purging'),
);

const OPERATOR_OR_SYSTEM: AccessRule<never> = Object.freeze({
  user: false,
  permission: null,
  operator: 'allowed',
  system: true,
});

function slugOf(input: unknown, policy: SlugPolicy): string {
  const check = checkSlug(typeof input === 'string' ? input : '', policy);
  if (check.ok) {
    return check.slug;
  }
  refuse(check.code === 'reserved_slug' ? 'reserved_slug' : 'invalid_slug');
}

async function changeStatus<R extends string, P extends string, S>(
  ctx: LifecycleContext<R, P, S>,
  tenantId: TenantId,
  by: TenancyActor,
  rule: AccessRule<P>,
  transition: TenantTransition,
  action: TenantAuditAction,
  patch: (tenant: TenantSummary, at: Date, reason: string | null) => Omit<TenantPatch, 'updatedAt'>,
): Promise<TenantSummary> {
  const id = requireTenantId(tenantId);
  const actor = checkActor(by);
  const at = ctx.now();
  return ctx.transaction(async (tx) => {
    const { tenant } = await ctx.access(tx, id, actor, rule, at);
    const next = nextTenantStatus(tenant.status, transition, {
      suspended: tenant.suspendedAt !== null,
    });
    if (next === null || next === 'purged') {
      refuse('invalid_transition');
    }
    const updated = await tx.updateTenant(id, tenant.version, {
      ...patch(tenant, at, actor.reason),
      status: next,
      updatedAt: at,
    });
    await ctx.audit(tx, id, at, actor, action, null);
    ctx.emit(tx, { type: 'tenant', tenantId: id, change: 'status' });
    return updated;
  });
}

async function finishPurge<R extends string, P extends string, S>(
  ctx: LifecycleContext<R, P, S>,
  tx: TenancyTx,
  tenantId: TenantId,
  actor: CheckedActor,
  at: Date,
): Promise<void> {
  const tenant = await tx.lockTenant(tenantId);
  if (tenant === null) {
    // A concurrent purge of the same tenant finished first.
    return;
  }
  if (tenant.status !== 'purging') {
    refuse('invalid_transition');
  }
  const claims = await tx.domainClaims(tenantId);
  await tx.deleteTenant(tenantId);
  await ctx.audit(tx, tenantId, at, actor, 'tenant.purged', null);
  for (const claim of claims) {
    ctx.emit(tx, { type: 'domain', tenantId, hostname: claim.hostname, change: 'removed' });
  }
  ctx.emit(tx, { type: 'tenant', tenantId, change: 'purged' });
}

/** Build the tenant-row operations on a lifecycle context. */
export function tenantOperations<R extends string, P extends string, S>(
  ctx: LifecycleContext<R, P, S>,
): TenantOperations<S> {
  const { roles } = ctx.options;
  const rule = (
    permission: AccessRule<P>['permission'],
    operator: AccessRule<P>['operator'],
    extra: Partial<AccessRule<P>> = {},
  ): AccessRule<P> => Object.freeze({ permission, operator, system: true, ...extra });

  /**
   * Authorize, then let `build` parse the input and build the patch (`null`
   * when nothing changes) together with a value to hand back.
   */
  const patchTenant = async <T>(
    tenantId: TenantId,
    by: TenancyActor,
    accessRule: AccessRule<P>,
    build: (tenant: TenantSummary) => {
      readonly patch: Omit<TenantPatch, 'updatedAt'> | null;
      readonly value: T;
    },
    audit: 'tenant.renamed' | 'tenant.plan_changed' | 'tenant.settings_changed',
    change: 'renamed' | 'plan' | 'settings',
  ): Promise<{ readonly tenant: TenantSummary; readonly value: T }> => {
    const id = requireTenantId(tenantId);
    const actor = checkActor(by);
    const at = ctx.now();
    return ctx.transaction(async (tx) => {
      const { tenant } = await ctx.access(tx, id, actor, accessRule, at);
      const { patch, value } = build(tenant);
      if (patch === null) {
        return { tenant, value };
      }
      const updated = await tx.updateTenant(id, tenant.version, { ...patch, updatedAt: at });
      await ctx.audit(tx, id, at, actor, audit, null);
      ctx.emit(tx, { type: 'tenant', tenantId: id, change });
      return { tenant: updated, value };
    });
  };

  return {
    async create(input, by, owner) {
      const actor = checkActor(by);
      let ownerUserId: string;
      if (actor.actor.kind === 'user') {
        if (owner !== undefined && owner !== actor.actor.userId) {
          refuse('not_permitted');
        }
        ownerUserId = actor.actor.userId;
      } else if (actor.actor.kind === 'system') {
        const named = parseUserId(owner);
        if (named === null) {
          refuse('invalid_actor');
        }
        ownerUserId = named;
      } else {
        refuse('not_permitted');
      }
      if (typeof input !== 'object' || input === null) {
        refuse('invalid_name');
      }
      const slug = slugOf(input.slug, ctx.options.slugs);
      const name = parseTenantName(input.name);
      const plan = parseTenantPlan(input.plan ?? null);
      const settings = serializeTenantSettings(ctx.options.parseSettings, input.settings ?? {});
      const at = ctx.now();
      return ctx.transaction(async (tx) => {
        const tenant = await tx.insertTenant({
          slug,
          name,
          plan,
          ownerUserId,
          settings: settings.json,
          createdAt: at,
        });
        await tx.insertMembership({
          tenantId: tenant.id,
          userId: ownerUserId,
          role: OWNER_ROLE,
          invitedBy: null,
          createdAt: at,
        });
        await ctx.audit(tx, tenant.id, at, actor, 'tenant.created', ownerUserId);
        ctx.emit(tx, { type: 'tenant', tenantId: tenant.id, change: 'created' });
        ctx.emit(tx, {
          type: 'membership',
          tenantId: tenant.id,
          userId: ownerUserId,
          change: 'added',
        });
        return tenant;
      });
    },

    async rename(tenantId, name, by) {
      const { tenant } = await patchTenant(
        tenantId,
        by,
        rule('tenant.update', 'write_grant'),
        (current) => {
          const parsed = parseTenantName(name);
          return { patch: current.name === parsed ? null : { name: parsed }, value: null };
        },
        'tenant.renamed',
        'renamed',
      );
      return tenant;
    },

    async setPlan(tenantId, plan, by) {
      const { tenant } = await patchTenant(
        tenantId,
        by,
        rule('plan.manage', 'write_grant'),
        (current) => {
          const parsed = parseTenantPlan(plan);
          return { patch: current.plan === parsed ? null : { plan: parsed }, value: null };
        },
        'tenant.plan_changed',
        'plan',
      );
      return tenant;
    },

    async settings(tenantId, by) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      const at = ctx.now();
      const json = await ctx.transaction(async (tx) => {
        await ctx.access(tx, id, actor, rule('tenant.view', 'grant', { lock: false }), at);
        return tx.tenantSettings(id);
      });
      return readTenantSettings(ctx.options.parseSettings, json ?? '{}');
    },

    async updateSettings(tenantId, raw, by) {
      const { value } = await patchTenant(
        tenantId,
        by,
        rule('settings.manage', 'write_grant'),
        () => {
          const settings = serializeTenantSettings(ctx.options.parseSettings, raw);
          return { patch: { settings: settings.json }, value: settings.value };
        },
        'tenant.settings_changed',
        'settings',
      );
      return value;
    },

    async transferOwnership(tenantId, toUserId, by) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      const target = parseUserId(toUserId);
      const at = ctx.now();
      return ctx.transaction(async (tx) => {
        const { tenant } = await ctx.access(
          tx,
          id,
          actor,
          rule('tenant.transfer', 'write_grant'),
          at,
        );
        const membership = target === null ? null : await tx.membership(id, target);
        if (membership === null || target === null) {
          refuse('not_member');
        }
        if (target === tenant.ownerUserId) {
          return tenant;
        }
        const formerRole = roles.roles[0];
        if (formerRole === undefined) {
          refuse('invalid_role_set');
        }
        const former = tenant.ownerUserId;
        await tx.updateMembershipRole(id, former, formerRole);
        await tx.updateMembershipRole(id, target, OWNER_ROLE);
        await revokeUnsendableInvitations(ctx, tx, id, former, formerRole, actor, at);
        const updated = await tx.updateTenant(id, tenant.version, {
          ownerUserId: target,
          updatedAt: at,
        });
        await ctx.audit(tx, id, at, actor, 'ownership.transferred', target);
        ctx.emit(tx, { type: 'tenant', tenantId: id, change: 'owner' });
        ctx.emit(tx, { type: 'membership', tenantId: id, userId: former, change: 'role' });
        ctx.emit(tx, { type: 'membership', tenantId: id, userId: target, change: 'role' });
        return updated;
      });
    },

    suspend(tenantId, by) {
      return changeStatus(
        ctx,
        tenantId,
        by,
        OPERATOR_OR_SYSTEM,
        'suspend',
        'tenant.suspended',
        (_t, at, reason) => ({
          suspendedAt: at,
          suspensionReason: reason,
        }),
      );
    },

    resume(tenantId, by) {
      return changeStatus(
        ctx,
        tenantId,
        by,
        OPERATOR_OR_SYSTEM,
        'resume',
        'tenant.resumed',
        () => ({
          suspendedAt: null,
          suspensionReason: null,
        }),
      );
    },

    scheduleDeletion(tenantId, by) {
      return changeStatus(
        ctx,
        tenantId,
        by,
        rule('tenant.delete', 'allowed', { userStatuses: NOT_PURGING }),
        'schedule_deletion',
        'tenant.deletion_scheduled',
        (_t, at) => ({ deletionDueAt: new Date(at.getTime() + ctx.options.deletionRetentionMs) }),
      );
    },

    cancelDeletion(tenantId, by) {
      return changeStatus(
        ctx,
        tenantId,
        by,
        rule('tenant.delete', 'allowed', { userStatuses: NOT_PURGING }),
        'cancel_deletion',
        'tenant.deletion_cancelled',
        () => ({ deletionDueAt: null }),
      );
    },

    async purge(tenantId, by, purgeData) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      if (actor.actor.kind !== 'system') {
        refuse('not_permitted');
      }
      if (typeof purgeData !== 'function') {
        refuse('invalid_lifecycle_options');
      }
      const at = ctx.now();
      await ctx.transaction(async (tx) => {
        const tenant = await tx.lockTenant(id);
        if (tenant === null) {
          refuse('not_found');
        }
        if (tenant.status === 'purging') {
          return;
        }
        if (tenant.status !== 'pending_deletion') {
          refuse('invalid_transition');
        }
        if (tenant.deletionDueAt === null || tenant.deletionDueAt.getTime() > at.getTime()) {
          refuse('purge_not_due');
        }
        await tx.updateTenant(id, tenant.version, { status: 'purging', updatedAt: at });
        await ctx.audit(tx, id, at, actor, 'tenant.purge_started', null);
        ctx.emit(tx, { type: 'tenant', tenantId: id, change: 'status' });
      });
      await purgeData(id);
      const finishedAt = ctx.now();
      await ctx.transaction((tx) => finishPurge(ctx, tx, id, actor, finishedAt));
    },
  };
}
