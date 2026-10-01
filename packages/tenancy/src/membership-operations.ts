/**
 * Lifecycle operations on memberships and invitations: invite, revoke,
 * accept, change a role, remove a member, leave, and the account-deletion
 * hook.
 *
 * - An invitation is addressed to a normalised email with a role the inviter
 *   may assign (strictly below their own rank). Only the token's SHA-256 is
 *   stored; the plaintext goes to the caller and to the invitation event,
 *   once. Re-inviting an address replaces its open invitation, which rotates
 *   the token. Inviting checks the seat limit against members plus open
 *   invitations, and a per-tenant cap on invitations sent in 24 hours.
 * - Accepting checks, in order: the token, the user's email (verified, and
 *   equal to the invitation's), the tenant's status, the expiry, an existing
 *   membership, the stored role and the seats. An expired invitation, one
 *   for an existing member and one whose role no longer exists are consumed
 *   (deleted and audited) before the refusal is reported, so a dead link stops
 *   working at once. Deleting the invitation must succeed, which makes
 *   acceptance single-use under concurrency.
 * - Roles move only by the rank rule; the owner is never re-roled or removed
 *   here (`owner_required`), only through a transfer.
 * - A member who leaves, is removed or is deleted loses, in the same
 *   transaction, any operator grant they held on the tenant and every open
 *   invitation they sent. A member whose role changes (by a role change or by
 *   handing over ownership) loses the invitations their new role could not
 *   have sent: every one when the role lacks `members.invite`, otherwise
 *   those at or above its rank. An inviter's authority therefore never
 *   outlives their membership or their role.
 * - Input is read only after authorization, so someone who may not act on a
 *   tenant gets `not_permitted` whatever they send, never a validation code.
 *
 * Audit targets are user ids and invitation ids, never email addresses, so
 * the audit trail (which outlives the tenant) holds no invitee address.
 */

import { checkActor, parseUserId, type CheckedActor, type TenancyActor } from './tenancy-actor.js';
import { normalizeEmail } from './email-address.js';
import { hashInvitationToken, issueInvitationToken } from './invitation-token.js';
import {
  refuse,
  requireTenantId,
  type AccessRule,
  type LifecycleContext,
} from './lifecycle-context.js';
import { TenancyError, type TenancyErrorCode } from './tenancy-error.js';
import type { Invitation, Membership } from './tenancy-records.js';
import type { TenancyTx } from './tenancy-store.js';
import type { TenantId } from './tenant-id.js';
import { checkLimit } from './tenant-limits.js';
import { OWNER_ROLE, type TenantRoleSet } from './tenant-roles.js';
import { TENANT_STATUSES, type TenantStatus } from './tenant-status.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The input of `invite`. */
export interface InvitationInput<R extends string> {
  readonly email: string;
  /** The role the invitee gets; the role set's default when omitted. */
  readonly role?: R;
}

/** A sent invitation and its plaintext token, which is never stored. */
export interface IssuedInvitation {
  readonly invitation: Invitation;
  readonly token: string;
}

/** The accepting user, as the identity layer knows them. */
export interface InvitationAcceptor {
  readonly userId: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

/** The outcome of `userDeleted`. */
export interface UserDeletion {
  /** Tenants the user's membership was removed from. */
  readonly removedFrom: readonly TenantId[];
  /** Tenants the user owns; while any is listed, nothing is removed. */
  readonly ownerOf: readonly TenantId[];
}

/** The membership operations of the lifecycle. */
export interface MembershipOperations<R extends string> {
  invite(
    tenantId: TenantId,
    input: InvitationInput<R>,
    by: TenancyActor,
  ): Promise<IssuedInvitation>;
  revokeInvitation(tenantId: TenantId, invitationId: number, by: TenancyActor): Promise<void>;
  acceptInvitation(token: string, who: InvitationAcceptor): Promise<Membership>;
  changeRole(tenantId: TenantId, userId: string, role: R, by: TenancyActor): Promise<Membership>;
  removeMember(tenantId: TenantId, userId: string, by: TenancyActor): Promise<void>;
  /** The acting user leaves the tenant. The owner must transfer first. */
  leave(tenantId: TenantId, by: TenancyActor): Promise<void>;
  /**
   * Remove a deleted account's memberships. System actors only. When the user
   * owns a tenant, nothing is removed and the owned tenants are returned, so
   * the account deletion can be refused or the tenants handed over first.
   */
  userDeleted(userId: string, by: TenancyActor): Promise<UserDeletion>;
}

const NOT_PURGING: readonly TenantStatus[] = Object.freeze(
  TENANT_STATUSES.filter((status) => status !== 'purging'),
);

type AcceptOutcome =
  | { readonly kind: 'joined'; readonly membership: Membership }
  | { readonly kind: 'refused'; readonly code: TenancyErrorCode };

/**
 * Revoke, and audit, the open invitations `userId` sent on a tenant that a
 * member holding `role` could not send: all of them when `role` is `null` (the
 * membership is gone) or lacks `members.invite`, otherwise those whose role is
 * not strictly below it (or no longer defined).
 */
export async function revokeUnsendableInvitations<R extends string, P extends string, S>(
  ctx: LifecycleContext<R, P, S>,
  tx: TenancyTx,
  tenantId: TenantId,
  userId: string,
  role: R | typeof OWNER_ROLE | null,
  actor: CheckedActor,
  at: Date,
): Promise<void> {
  const { roles } = ctx.options;
  const sendable = (invitation: Invitation): boolean => {
    if (role === null || !roles.allows(role, 'members.invite')) {
      return false;
    }
    const invited = definedRoleOf(roles, invitation.role);
    return invited !== null && roles.canAssign(role, null, invited);
  };
  let after: string | undefined;
  do {
    const page = await tx.invitations(
      tenantId,
      after === undefined ? { limit: 200 } : { limit: 200, after },
    );
    for (const invitation of page.items) {
      if (invitation.invitedBy === userId && !sendable(invitation)) {
        await tx.deleteInvitation(invitation.id);
        await ctx.audit(
          tx,
          tenantId,
          at,
          actor,
          'member.invitation_revoked',
          String(invitation.id),
        );
      }
    }
    after = page.next ?? undefined;
  } while (after !== undefined);
}

/** A stored role as a defined role, or `null` for `owner` or a role no longer defined. */
function definedRoleOf<R extends string, P extends string>(
  roles: TenantRoleSet<R, P>,
  value: string,
): R | null {
  const role = roles.parse(value);
  return role === null || role === OWNER_ROLE ? null : role;
}

/** Build the membership operations on a lifecycle context. */
export function membershipOperations<R extends string, P extends string, S>(
  ctx: LifecycleContext<R, P, S>,
): MembershipOperations<R> {
  const { roles } = ctx.options;

  const definedRole = (value: string): R | null => definedRoleOf(roles, value);

  const rankOf = (value: string): number => {
    const role = roles.parse(value);
    return role === null ? 0 : roles.rank(role);
  };

  /** Everything a membership carries that must go with it, then the audit and event. */
  const dropMembership = async (
    tx: TenancyTx,
    tenantId: TenantId,
    userId: string,
    actor: CheckedActor,
    action: 'member.removed' | 'member.left' | 'member.deleted',
    at: Date,
  ): Promise<void> => {
    await tx.deleteMembership(tenantId, userId);
    if ((await tx.closeOperatorGrants(tenantId, userId, at)) > 0) {
      await ctx.audit(tx, tenantId, at, actor, 'operator.access_closed', userId);
    }
    await revokeUnsendableInvitations(ctx, tx, tenantId, userId, null, actor, at);
    await ctx.audit(tx, tenantId, at, actor, action, userId);
    ctx.emit(tx, { type: 'membership', tenantId, userId, change: 'removed' });
  };

  const membersRule = (permission: AccessRule<P>['permission']): AccessRule<P> =>
    Object.freeze({ permission, operator: 'write_grant', system: true });

  return {
    async invite(tenantId, input, by) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      if (actor.actor.kind === 'system') {
        refuse('not_permitted');
      }
      const inviter = actor.actor.userId;
      const at = ctx.now();
      return ctx.transaction(async (tx) => {
        const access = await ctx.access(tx, id, actor, membersRule('members.invite'), at);
        if (typeof input !== 'object' || input === null) {
          refuse('invalid_email');
        }
        const email = normalizeEmail(input.email);
        if (email === null) {
          refuse('invalid_email');
        }
        const requested = input.role === undefined ? roles.defaultRole : input.role;
        const role = roles.parse(requested);
        if (role === null) {
          refuse('invalid_role');
        }
        if (role === OWNER_ROLE) {
          refuse('role_not_assignable');
        }
        if (access.role !== null && !roles.canAssign(access.role, null, role)) {
          refuse('role_not_assignable');
        }
        const limits = await ctx.limits(access.tenant);
        // The window is the 24 hours ending now, exclusive of its start.
        const since = new Date(at.getTime() - DAY_MS + 1);
        const sent = await tx.countAudit(id, 'member.invited', since);
        if (checkLimit(limits, 'invitationsPerDay', sent) === 'limit_exceeded') {
          refuse('limit_exceeded');
        }
        const replaced = await tx.invitationByEmail(id, email);
        const open =
          (await tx.countOpenInvitations(id, at)) -
          (replaced !== null && replaced.expiresAt.getTime() > at.getTime() ? 1 : 0);
        const seated = (await tx.countMembers(id)) + open;
        if (checkLimit(limits, 'seats', seated) === 'limit_exceeded') {
          refuse('limit_exceeded');
        }
        const issued = issueInvitationToken();
        const { invitation } = await tx.putInvitation({
          tenantId: id,
          email,
          role,
          invitedBy: inviter,
          tokenHash: issued.hash,
          expiresAt: new Date(at.getTime() + ctx.options.invitationTtlMs),
          createdAt: at,
        });
        await ctx.audit(tx, id, at, actor, 'member.invited', String(invitation.id));
        ctx.emit(tx, {
          type: 'invitation',
          tenantId: id,
          invitationId: invitation.id,
          email,
          role,
          invitedBy: inviter,
          expiresAt: invitation.expiresAt,
          token: issued.token,
        });
        return Object.freeze({ invitation, token: issued.token });
      });
    },

    async revokeInvitation(tenantId, invitationId, by) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      const at = ctx.now();
      await ctx.transaction(async (tx) => {
        const access = await ctx.access(tx, id, actor, membersRule('members.invite'), at);
        const invitation =
          Number.isSafeInteger(invitationId) && invitationId > 0
            ? await tx.invitation(invitationId)
            : null;
        if (invitation === null || invitation.tenantId !== id) {
          refuse('not_found');
        }
        if (
          actor.actor.kind === 'user' &&
          access.role !== null &&
          invitation.invitedBy !== actor.actor.userId
        ) {
          const role = definedRole(invitation.role);
          if (role !== null && !roles.canAssign(access.role, null, role)) {
            refuse('not_permitted');
          }
        }
        await tx.deleteInvitation(invitation.id);
        await ctx.audit(tx, id, at, actor, 'member.invitation_revoked', String(invitation.id));
      });
    },

    async acceptInvitation(token, who) {
      if (typeof who !== 'object' || who === null) {
        refuse('invalid_actor');
      }
      const userId = parseUserId(who.userId);
      if (userId === null) {
        refuse('invalid_actor');
      }
      const actor = checkActor({ kind: 'user', userId });
      const hash = hashInvitationToken(token);
      if (hash === null) {
        refuse('invalid_invitation');
      }
      const located = await ctx.options.store.invitationByTokenHash(hash);
      if (located === null) {
        refuse('invalid_invitation');
      }
      const at = ctx.now();
      const outcome = await ctx.transaction(async (tx): Promise<AcceptOutcome> => {
        const tenant = await tx.lockTenant(located.tenantId);
        const invitation = await tx.invitationByTokenHash(hash);
        if (tenant === null || invitation === null) {
          refuse('invalid_invitation');
        }
        if (who.emailVerified !== true) {
          refuse('email_unverified');
        }
        if (normalizeEmail(who.email) !== invitation.email) {
          refuse('email_mismatch');
        }
        if (tenant.status !== 'active') {
          refuse(tenant.status === 'purging' ? 'purge_in_progress' : 'tenant_inactive');
        }
        const consume = async (
          action: 'member.invitation_expired' | 'member.invitation_discarded',
          code: TenancyErrorCode,
        ): Promise<AcceptOutcome> => {
          if (!(await tx.deleteInvitation(invitation.id))) {
            refuse('invalid_invitation');
          }
          await ctx.audit(tx, tenant.id, at, actor, action, String(invitation.id));
          return { kind: 'refused', code };
        };
        if (invitation.expiresAt.getTime() <= at.getTime()) {
          return consume('member.invitation_expired', 'invitation_expired');
        }
        if ((await tx.membership(tenant.id, userId)) !== null) {
          return consume('member.invitation_discarded', 'already_member');
        }
        const role = definedRole(invitation.role);
        if (role === null) {
          return consume('member.invitation_discarded', 'invalid_invitation');
        }
        const limits = await ctx.limits(tenant);
        if (checkLimit(limits, 'seats', await tx.countMembers(tenant.id)) === 'limit_exceeded') {
          refuse('limit_exceeded');
        }
        if (!(await tx.deleteInvitation(invitation.id))) {
          refuse('invalid_invitation');
        }
        const membership = await tx.insertMembership({
          tenantId: tenant.id,
          userId,
          role,
          invitedBy: invitation.invitedBy,
          createdAt: at,
        });
        await ctx.audit(tx, tenant.id, at, actor, 'member.joined', userId);
        ctx.emit(tx, { type: 'membership', tenantId: tenant.id, userId, change: 'added' });
        return { kind: 'joined', membership };
      });
      if (outcome.kind === 'refused') {
        throw new TenancyError(outcome.code);
      }
      return outcome.membership;
    },

    async changeRole(tenantId, userId, role, by) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      const target = parseUserId(userId);
      const at = ctx.now();
      return ctx.transaction(async (tx) => {
        const access = await ctx.access(tx, id, actor, membersRule('members.role'), at);
        const next = roles.parse(role);
        if (next === null) {
          refuse('invalid_role');
        }
        if (next === OWNER_ROLE) {
          refuse('role_not_assignable');
        }
        const membership = target === null ? null : await tx.membership(id, target);
        if (membership === null || target === null) {
          refuse('not_member');
        }
        if (membership.role === OWNER_ROLE) {
          refuse('owner_required');
        }
        if (
          access.role !== null &&
          !roles.canAssign(access.role, definedRole(membership.role), next)
        ) {
          refuse('role_not_assignable');
        }
        if (membership.role === next) {
          return membership;
        }
        const updated = await tx.updateMembershipRole(id, target, next);
        if (updated === null) {
          refuse('not_member');
        }
        await revokeUnsendableInvitations(ctx, tx, id, target, next, actor, at);
        await ctx.audit(tx, id, at, actor, 'member.role_changed', target);
        ctx.emit(tx, { type: 'membership', tenantId: id, userId: target, change: 'role' });
        return updated;
      });
    },

    async removeMember(tenantId, userId, by) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      const target = parseUserId(userId);
      const at = ctx.now();
      await ctx.transaction(async (tx) => {
        const access = await ctx.access(tx, id, actor, membersRule('members.remove'), at);
        const membership = target === null ? null : await tx.membership(id, target);
        if (membership === null || target === null) {
          refuse('not_member');
        }
        if (membership.role === OWNER_ROLE) {
          refuse('owner_required');
        }
        if (access.role !== null && rankOf(membership.role) >= roles.rank(access.role)) {
          refuse('not_permitted');
        }
        await dropMembership(tx, id, target, actor, 'member.removed', at);
      });
    },

    async leave(tenantId, by) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      if (actor.actor.kind !== 'user') {
        refuse('not_permitted');
      }
      const userId = actor.actor.userId;
      const at = ctx.now();
      await ctx.transaction(async (tx) => {
        const access = await ctx.access(
          tx,
          id,
          actor,
          Object.freeze({
            permission: null,
            operator: 'refused',
            system: false,
            userStatuses: NOT_PURGING,
          }),
          at,
        );
        if (access.role === OWNER_ROLE) {
          refuse('owner_required');
        }
        await dropMembership(tx, id, userId, actor, 'member.left', at);
      });
    },

    async userDeleted(userId, by) {
      const actor = checkActor(by);
      if (actor.actor.kind !== 'system') {
        refuse('not_permitted');
      }
      const target = parseUserId(userId);
      if (target === null) {
        return Object.freeze({ removedFrom: Object.freeze([]), ownerOf: Object.freeze([]) });
      }
      const memberships: Membership[] = [];
      let after: string | undefined;
      do {
        const page = await ctx.options.store.membershipsOfUser(
          target,
          after === undefined ? { limit: 200 } : { limit: 200, after },
        );
        memberships.push(...page.items);
        after = page.next ?? undefined;
      } while (after !== undefined);
      const owned = memberships.filter((m) => m.role === OWNER_ROLE).map((m) => m.tenantId);
      if (owned.length > 0) {
        return Object.freeze({ removedFrom: Object.freeze([]), ownerOf: Object.freeze(owned) });
      }
      const removedFrom: TenantId[] = [];
      const ownerOf: TenantId[] = [];
      for (const { tenantId } of memberships) {
        const at = ctx.now();
        const result = await ctx.transaction(async (tx) => {
          if ((await tx.lockTenant(tenantId)) === null) {
            return 'gone';
          }
          const membership = await tx.membership(tenantId, target);
          if (membership === null) {
            return 'gone';
          }
          if (membership.role === OWNER_ROLE) {
            return 'owner';
          }
          await dropMembership(tx, tenantId, target, actor, 'member.deleted', at);
          return 'removed';
        });
        if (result === 'removed') removedFrom.push(tenantId);
        if (result === 'owner') ownerOf.push(tenantId);
      }
      return Object.freeze({
        removedFrom: Object.freeze(removedFrom),
        ownerOf: Object.freeze(ownerOf),
      });
    },
  };
}
