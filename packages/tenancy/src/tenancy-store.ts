/**
 * The tenancy store port.
 *
 * The lifecycle service talks to storage only through these interfaces; the
 * memory store implements them now and the database store implements them on
 * the framework's data layer. The port is internal: it is not exported from
 * the package barrel.
 *
 * The contract every implementation keeps, and the store contract cases
 * check:
 *
 * - Reads outside a transaction see committed data only. Reads inside a
 *   transaction see the latest committed data plus the transaction's own
 *   writes (read committed). Every record is a frozen copy.
 * - {@link TenancyTx.lockTenant} locks the tenant row until the transaction
 *   ends, like `SELECT ... FOR UPDATE`. Every write also locks the rows and
 *   unique keys it touches. A lifecycle operation that reads and then writes
 *   (seats, ownership, status, domains) calls `lockTenant` first; without it
 *   two transactions can both pass the same check.
 * - Any rejected call poisons the transaction. Every later call rejects with
 *   `transaction_aborted`, and `transaction` rejects with the first failure
 *   even when the body caught it and returned. A conflict therefore ends the
 *   transaction; a store that wants to recover from one uses its own
 *   savepoint and never exposes a half-failed frame.
 * - Unique violations map to codes: `slug_taken`, `already_member`,
 *   `domain_claimed`, `domain_taken`. A missing parent row is `not_found`,
 *   a moved version `stale_tenant`, a deadlock or lock timeout
 *   `transaction_conflict`, and a value outside the record shapes
 *   `invalid_store_input`.
 * - At commit every tenant the transaction touched must have exactly one
 *   membership with role `owner`, whose user equals the row's `ownerUserId`;
 *   otherwise the transaction rolls back with `owner_required`.
 * - {@link TenancyTx.afterCommit} callbacks run, in order, only after a
 *   commit. A rollback discards them.
 * - The store never reads a clock: every timestamp is passed in.
 * - Listings are keyset pages (see `tenancy-page.ts`); batch reads take a
 *   limit from 1 to {@link MAX_BATCH_LIMIT}.
 */

import type { Page, PageRequest } from './tenancy-page.js';
import type {
  DomainClaim,
  DomainClaimPatch,
  Invitation,
  Membership,
  MembershipOfUser,
  NewAuditRecord,
  NewDomainClaim,
  NewInvitation,
  NewOperatorGrant,
  NewTenant,
  OperatorGrant,
  PutInvitationResult,
  TenantAuditAction,
  TenantAuditRecord,
  TenantPatch,
  TenantSummary,
} from './tenancy-records.js';
import type { TenantId } from './tenant-id.js';

/** The largest batch a sweep read or delete handles at once. */
export const MAX_BATCH_LIMIT = 1000;

/** Reads, available on the store and inside a transaction. */
export interface TenancyReads {
  tenantById(id: TenantId): Promise<TenantSummary | null>;
  tenantBySlug(slug: string): Promise<TenantSummary | null>;
  /** The tenant whose claim of `hostname` is verified. */
  tenantByVerifiedHostname(hostname: string): Promise<TenantSummary | null>;
  /** The serialised settings JSON of a tenant. */
  tenantSettings(id: TenantId): Promise<string | null>;
  /**
   * Tenants a purge sweep should handle: those pending deletion and due at
   * `before`, and those already purging. Ordered by due time, then id.
   */
  tenantsDueForPurge(before: Date, limit: number): Promise<readonly TenantSummary[]>;

  membership(tenantId: TenantId, userId: string): Promise<Membership | null>;
  /** A tenant's members, ordered by user id. */
  members(tenantId: TenantId, page: PageRequest): Promise<Page<Membership>>;
  /** A user's memberships with their tenants, ordered by tenant id. */
  membershipsOfUser(userId: string, page: PageRequest): Promise<Page<MembershipOfUser>>;
  countMembers(tenantId: TenantId): Promise<number>;

  invitation(id: number): Promise<Invitation | null>;
  invitationByTokenHash(tokenHash: Uint8Array): Promise<Invitation | null>;
  invitationByEmail(tenantId: TenantId, email: string): Promise<Invitation | null>;
  /** A tenant's open invitations, ordered by id. */
  invitations(tenantId: TenantId, page: PageRequest): Promise<Page<Invitation>>;
  /** Invitations that expire after `now`. */
  countOpenInvitations(tenantId: TenantId, now: Date): Promise<number>;
  /** Invitations expired at `before`, ordered by expiry, then id. */
  invitationsExpiredBefore(before: Date, limit: number): Promise<readonly Invitation[]>;

  domainClaim(tenantId: TenantId, hostname: string): Promise<DomainClaim | null>;
  /** A tenant's claims, ordered by hostname. */
  domainClaims(tenantId: TenantId): Promise<readonly DomainClaim[]>;
  /** Every tenant's claim of one hostname, ordered by tenant id. */
  domainClaimsOfHostname(hostname: string): Promise<readonly DomainClaim[]>;
  /** Claims never checked or last checked before `before`, least recently checked first. */
  domainClaimsDueForCheck(before: Date, limit: number): Promise<readonly DomainClaim[]>;

  /** A tenant's audit trail, newest first. */
  audit(tenantId: TenantId, page: PageRequest): Promise<Page<TenantAuditRecord>>;
  /** Records of `action` for a tenant at or after `since`. */
  countAudit(tenantId: TenantId, action: TenantAuditAction, since: Date): Promise<number>;

  operatorGrant(id: number): Promise<OperatorGrant | null>;
  /** The open grant of an operator that lasts longest past `now`. */
  activeOperatorGrant(
    tenantId: TenantId,
    operatorId: string,
    now: Date,
  ): Promise<OperatorGrant | null>;
  /** A tenant's grants open at `now`, ordered by expiry, then id. */
  activeOperatorGrants(tenantId: TenantId, now: Date): Promise<readonly OperatorGrant[]>;
}

/** Reads and writes inside one transaction. */
export interface TenancyTx extends TenancyReads {
  /** Lock the tenant row until the transaction ends; `null` when there is no such tenant. */
  lockTenant(id: TenantId): Promise<TenantSummary | null>;

  /** Insert an `active` tenant at version 1. Rejects `slug_taken`. */
  insertTenant(row: NewTenant): Promise<TenantSummary>;
  /** Apply a patch when the row is at `expectedVersion`. Rejects `not_found` or `stale_tenant`. */
  updateTenant(id: TenantId, expectedVersion: number, patch: TenantPatch): Promise<TenantSummary>;
  /** Delete a tenant with its memberships, invitations, claims and grants; the audit stays. */
  deleteTenant(id: TenantId): Promise<boolean>;

  /** Rejects `not_found` for an unknown tenant and `already_member`. */
  insertMembership(row: Membership): Promise<Membership>;
  updateMembershipRole(
    tenantId: TenantId,
    userId: string,
    role: string,
  ): Promise<Membership | null>;
  deleteMembership(tenantId: TenantId, userId: string): Promise<boolean>;

  /**
   * Store an invitation, replacing the open invitation for the same tenant
   * and email (which then stops matching its token). Rejects `not_found`.
   */
  putInvitation(row: NewInvitation): Promise<PutInvitationResult>;
  /** `false` when it was already gone, which is what makes acceptance single-use. */
  deleteInvitation(id: number): Promise<boolean>;

  /** Insert a pending claim. Rejects `not_found` and `domain_claimed`. */
  insertDomainClaim(row: NewDomainClaim): Promise<DomainClaim>;
  /**
   * Rejects `domain_taken` when verifying a hostname another tenant has
   * verified. A claim left unverified is never primary: the flag is cleared
   * with the verification.
   */
  updateDomainClaim(
    tenantId: TenantId,
    hostname: string,
    patch: DomainClaimPatch,
  ): Promise<DomainClaim | null>;
  deleteDomainClaim(tenantId: TenantId, hostname: string): Promise<boolean>;
  /**
   * Make one verified claim the tenant's primary domain and clear the flag
   * on every other, or clear it everywhere with `null`. `false` when the
   * claim does not exist; rejects `domain_unverified` for a pending claim.
   */
  setPrimaryDomain(tenantId: TenantId, hostname: string | null): Promise<boolean>;

  appendAudit(record: NewAuditRecord): Promise<TenantAuditRecord>;
  /** Delete up to `limit` audit records older than `before`, oldest first. */
  deleteAuditBefore(before: Date, limit: number): Promise<number>;

  /** Rejects `not_found` for an unknown tenant. */
  insertOperatorGrant(row: NewOperatorGrant): Promise<OperatorGrant>;
  /** `false` when the grant does not exist or is already closed. */
  closeOperatorGrant(id: number, at: Date): Promise<boolean>;
  /** Close every open grant of an operator on a tenant; the number closed. */
  closeOperatorGrants(tenantId: TenantId, operatorId: string, at: Date): Promise<number>;

  /** Run `callback` after the transaction commits; never after a rollback. */
  afterCommit(callback: () => void): void;
}

/** One store call, as named to a statement hook. */
export type TenancyStatement = Exclude<keyof TenancyTx, 'afterCommit'>;

/** A tenancy store. */
export interface TenancyStore extends TenancyReads {
  /**
   * Run `body` in a transaction. It commits when `body` resolves and no call
   * failed; otherwise it rolls back and rejects with the error.
   */
  transaction<T>(body: (tx: TenancyTx) => Promise<T>): Promise<T>;
}
