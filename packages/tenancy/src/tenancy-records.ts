/**
 * The records the tenancy store keeps, as frozen plain DTOs.
 *
 * These are the shapes every `TenancyStore` implementation reads and
 * writes, whatever holds the rows. They carry no behaviour. A store hands out
 * frozen objects with fresh `Date` copies, so a caller can never change a
 * stored value by mutating what it was given.
 *
 * Ownership has one source of truth: the membership whose role is `owner`.
 * The tenant row's `ownerUserId` mirrors it as a lookup column, and a store
 * refuses to commit a transaction that leaves a tenant with anything other
 * than exactly one owner membership equal to that column.
 *
 * A domain claim binds a hostname to one tenant. Any number of tenants may
 * hold a pending claim for the same hostname; `verifiedHostname` is set only
 * while the claim is verified and is unique across every claim, so a pending
 * claim can never squat a hostname.
 *
 * Audit records have no foreign key and outlive the tenant. Their `target` is
 * a user id, an invitation id or a hostname, never a raw email address.
 *
 * {@link TENANCY_COLUMN_LIMITS} is the one statement of every column's size,
 * shared by the memory store and the database schema.
 */

import type { TenantId } from './tenant-id.js';
import type { TenantStatus } from './tenant-status.js';

const tenancyColumnLimits = {
  slug: 63,
  name: 200,
  plan: 64,
  userId: 191,
  role: 32,
  email: 254,
  hostname: 253,
  reason: 500,
  target: 255,
  traceId: 128,
  /** UTF-8 bytes of the serialised settings JSON. */
  settingsBytes: 65_536,
} as const;
/** The largest value each stored column accepts, in code points (or bytes for settings). */
export const TENANCY_COLUMN_LIMITS: typeof tenancyColumnLimits = Object.freeze(tenancyColumnLimits);

/** A tenant row. */
export interface TenantSummary {
  readonly id: TenantId;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly plan: string | null;
  /** Mirrors the user id of the tenant's one `owner` membership. */
  readonly ownerUserId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Set while the tenant carries a suspension, including during a pending deletion. */
  readonly suspendedAt: Date | null;
  readonly suspensionReason: string | null;
  /** When a scheduled deletion becomes due; `null` unless deletion is scheduled. */
  readonly deletionDueAt: Date | null;
  /** Starts at 1 and grows by one on every update. */
  readonly version: number;
}

/** The columns of a new tenant. It starts `active` at version 1. */
export interface NewTenant {
  readonly slug: string;
  readonly name: string;
  readonly plan: string | null;
  readonly ownerUserId: string;
  /** Serialised JSON. */
  readonly settings: string;
  readonly createdAt: Date;
}

/** A change to a tenant row; omitted fields keep their value. */
export interface TenantPatch {
  readonly name?: string;
  readonly plan?: string | null;
  readonly status?: TenantStatus;
  readonly ownerUserId?: string;
  /** Serialised JSON. */
  readonly settings?: string;
  readonly suspendedAt?: Date | null;
  readonly suspensionReason?: string | null;
  readonly deletionDueAt?: Date | null;
  readonly updatedAt: Date;
}

/** A user's membership of a tenant. */
export interface Membership {
  readonly tenantId: TenantId;
  readonly userId: string;
  /** A stored role: a role of the app's role set, or `owner`. */
  readonly role: string;
  readonly invitedBy: string | null;
  readonly createdAt: Date;
}

/** A membership listed for its user, with the tenant it belongs to. */
export interface MembershipOfUser extends Membership {
  readonly tenant: TenantSummary;
}

/** An open invitation. Accepted and revoked invitations are deleted. */
export interface Invitation {
  readonly id: number;
  readonly tenantId: TenantId;
  /** The normalised address the invitation was sent to. */
  readonly email: string;
  readonly role: string;
  readonly invitedBy: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/** The columns of a new invitation. */
export interface NewInvitation {
  readonly tenantId: TenantId;
  readonly email: string;
  readonly role: string;
  readonly invitedBy: string;
  /** SHA-256 of the token; 32 bytes. */
  readonly tokenHash: Uint8Array;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/** The outcome of putting an invitation: the new row and the open one it replaced. */
export interface PutInvitationResult {
  readonly invitation: Invitation;
  readonly replaced: Invitation | null;
}

/** A tenant's claim of a hostname. */
export interface DomainClaim {
  readonly tenantId: TenantId;
  readonly hostname: string;
  /** The challenge token bound to this tenant and hostname. */
  readonly token: string;
  /** Equal to `hostname` while verified, otherwise `null`; unique across every claim. */
  readonly verifiedHostname: string | null;
  /** Whether this is the tenant's primary domain; only a verified claim can be. */
  readonly primary: boolean;
  readonly verifiedAt: Date | null;
  /** When a pending claim lapses; always set while the claim is not verified. */
  readonly expiresAt: Date | null;
  readonly failures: number;
  readonly failingSince: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly createdAt: Date;
}

/** The columns of a new, pending claim. */
export interface NewDomainClaim {
  readonly tenantId: TenantId;
  readonly hostname: string;
  readonly token: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/**
 * A change to a claim's verification state. Setting `verifiedAt` verifies the
 * claim (and takes the global hostname); clearing it withdraws verification
 * and the primary flag.
 */
export interface DomainClaimPatch {
  readonly token?: string;
  readonly verifiedAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly failures?: number;
  readonly failingSince?: Date | null;
  readonly lastCheckedAt?: Date | null;
}

/** Who performed an audited action. A reason, when one is required, is on the record. */
export type AuditActor =
  | { readonly kind: 'user'; readonly id: string }
  | { readonly kind: 'operator'; readonly id: string }
  | { readonly kind: 'system' };

const tenantAuditActions = [
  'tenant.created',
  'tenant.renamed',
  'tenant.settings_changed',
  'tenant.plan_changed',
  'tenant.suspended',
  'tenant.resumed',
  'tenant.deletion_scheduled',
  'tenant.deletion_cancelled',
  'tenant.purge_started',
  'tenant.purged',
  'tenant.exported',
  'member.invited',
  'member.invitation_revoked',
  'member.invitation_expired',
  'member.invitation_discarded',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'member.left',
  'member.deleted',
  'ownership.transferred',
  'domain.claimed',
  'domain.verified',
  'domain.failing',
  'domain.unverified',
  'domain.expired',
  'domain.removed',
  'domain.primary_changed',
  'operator.access_opened',
  'operator.write_access_opened',
  'operator.access_closed',
] as const;
/** Every audited action. */
export const TENANT_AUDIT_ACTIONS: typeof tenantAuditActions = Object.freeze(tenantAuditActions);

/** An audited action. */
export type TenantAuditAction = (typeof TENANT_AUDIT_ACTIONS)[number];

/** One audit record. */
export interface TenantAuditRecord {
  readonly id: number;
  readonly tenantId: TenantId;
  readonly at: Date;
  readonly actor: AuditActor;
  readonly action: TenantAuditAction;
  /** A user id, invitation id or hostname; never an email address. */
  readonly target: string | null;
  readonly reason: string | null;
  readonly traceId: string | null;
}

/** The columns of a new audit record. */
export type NewAuditRecord = Omit<TenantAuditRecord, 'id'>;

/** A time-boxed operator access grant to one tenant. */
export interface OperatorGrant {
  readonly id: number;
  readonly tenantId: TenantId;
  readonly operatorId: string;
  readonly reason: string;
  readonly write: boolean;
  readonly openedAt: Date;
  readonly expiresAt: Date;
  /** When the grant was closed early; `null` while open. */
  readonly closedAt: Date | null;
}

/** The columns of a new grant. */
export type NewOperatorGrant = Omit<OperatorGrant, 'id' | 'closedAt'>;
