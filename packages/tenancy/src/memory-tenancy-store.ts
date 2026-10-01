/**
 * The in-memory tenancy store.
 *
 * It implements the whole store port with the behaviour a database gives at
 * read committed, so code that is wrong on a database is wrong here too:
 *
 * - Transactions interleave. Each keeps its writes in a private overlay that
 *   only it reads, and applies them to the shared tables at commit.
 * - Locks follow the rows: `lockTenant` and every update or delete lock the
 *   row until the transaction ends; inserts lock the unique values they take
 *   and deletes the ones they free, so a second insert of the same slug waits
 *   for the first transaction and then fails or succeeds on what it committed.
 *   An insert of a child row (membership, invitation, claim, grant) also locks
 *   its tenant row, standing in for the foreign key's lock on the parent.
 *   Deadlocks and lock waits past `lockTimeoutMs` reject with
 *   `transaction_conflict` (see `transaction-locks.ts`).
 * - Statements of one transaction run one at a time, in call order, like
 *   statements on one connection.
 * - A failed statement poisons the transaction (the poisoned-frame rule).
 * - At commit, the owner invariant is checked for every tenant touched.
 * - `afterCommit` callbacks run after the commit, in order; a callback that
 *   throws does not undo the commit or stop the others, and its error goes to
 *   `onAfterCommitError` (by default it is rethrown on a microtask, like an
 *   uncaught listener error).
 *
 * `onStatement` is called before every statement and may delay or fail it,
 * which is how tests reorder transactions and inject store faults.
 *
 * Rows are kept frozen with epoch-millisecond times, and every read builds
 * fresh frozen records, so nothing a caller holds aliases stored state.
 */

import { OWNER_ROLE } from './tenant-roles.js';
import type { TenantId } from './tenant-id.js';
import type { TenantStatus } from './tenant-status.js';
import { TenancyError } from './tenancy-error.js';
import { cutPage, pageWindow, type Page, type PageRequest } from './tenancy-page.js';
import {
  TENANCY_COLUMN_LIMITS as LIMITS,
  type AuditActor,
  type DomainClaim,
  type DomainClaimPatch,
  type Invitation,
  type Membership,
  type MembershipOfUser,
  type NewAuditRecord,
  type NewDomainClaim,
  type NewInvitation,
  type NewOperatorGrant,
  type NewTenant,
  type OperatorGrant,
  type PutInvitationResult,
  type TenantAuditAction,
  type TenantAuditRecord,
  type TenantPatch,
  type TenantSummary,
} from './tenancy-records.js';
import type { TenancyReads, TenancyStatement, TenancyStore, TenancyTx } from './tenancy-store.js';
import {
  requireAuditAction,
  requireAuditActor,
  requireBatchLimit,
  requireBoolean,
  requireCount,
  requireDate,
  requireDomainToken,
  requireEmail,
  requireHostname,
  requireLookup,
  requireOptionalDate,
  requireOptionalText,
  requireRecord,
  requireRole,
  requireRowId,
  requireSettings,
  requireSlug,
  requireStatus,
  requireTenantId,
  requireText,
  requireTokenHash,
  requireUserId,
  storeInputError,
} from './store-input.js';
import { lockKey, TransactionLocks, type LockHolder } from './transaction-locks.js';

/** A statement about to run, as {@link MemoryTenancyStoreOptions.onStatement} sees it. */
export interface TenancyStatementEvent {
  readonly statement: TenancyStatement;
  readonly inTransaction: boolean;
}

/** Options of {@link createMemoryTenancyStore}. */
export interface MemoryTenancyStoreOptions {
  /** Longest wait for a lock before `transaction_conflict`; 1 to 600000 ms, default 10000. */
  readonly lockTimeoutMs?: number;
  /** Called before every statement; a rejection fails the statement. */
  readonly onStatement?: (event: TenancyStatementEvent) => void | Promise<void>;
  /** Receives the error of an `afterCommit` callback that throws. */
  readonly onAfterCommitError?: (error: unknown) => void;
}

interface TenantRow {
  readonly id: TenantId;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly plan: string | null;
  readonly ownerUserId: string;
  readonly settings: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly suspendedAt: number | null;
  readonly suspensionReason: string | null;
  readonly deletionDueAt: number | null;
  readonly version: number;
}

interface MembershipRow {
  readonly tenantId: TenantId;
  readonly userId: string;
  readonly role: string;
  readonly invitedBy: string | null;
  readonly createdAt: number;
}

interface InvitationRow {
  readonly id: number;
  readonly tenantId: TenantId;
  readonly email: string;
  readonly role: string;
  readonly invitedBy: string;
  readonly tokenHash: string;
  readonly expiresAt: number;
  readonly createdAt: number;
}

interface ClaimRow {
  readonly tenantId: TenantId;
  readonly hostname: string;
  readonly token: string;
  readonly primary: boolean;
  readonly verifiedAt: number | null;
  readonly expiresAt: number | null;
  readonly failures: number;
  readonly failingSince: number | null;
  readonly lastCheckedAt: number | null;
  readonly createdAt: number;
}

interface AuditRow {
  readonly id: number;
  readonly tenantId: TenantId;
  readonly at: number;
  readonly actor: AuditActor;
  readonly action: TenantAuditAction;
  readonly target: string | null;
  readonly reason: string | null;
  readonly traceId: string | null;
}

interface GrantRow {
  readonly id: number;
  readonly tenantId: TenantId;
  readonly operatorId: string;
  readonly reason: string;
  readonly write: boolean;
  readonly openedAt: number;
  readonly expiresAt: number;
  readonly closedAt: number | null;
}

interface Rows {
  readonly tenants: TenantRow;
  readonly memberships: MembershipRow;
  readonly invitations: InvitationRow;
  readonly claims: ClaimRow;
  readonly audit: AuditRow;
  readonly grants: GrantRow;
}

type TableName = keyof Rows;

const TABLE_NAMES: readonly TableName[] = Object.freeze([
  'tenants',
  'memberships',
  'invitations',
  'claims',
  'audit',
  'grants',
]);

type Tables = { readonly [K in TableName]: Map<string, Rows[K]> };
type Overlays = { readonly [K in TableName]: Map<string, Rows[K] | null> };
type Sequences = { [K in 'tenants' | 'invitations' | 'audit' | 'grants']: number };
type Mutable<T> = { -readonly [K in keyof T]?: T[K] };

function emptyTables(): Tables {
  return {
    tenants: new Map(),
    memberships: new Map(),
    invitations: new Map(),
    claims: new Map(),
    audit: new Map(),
    grants: new Map(),
  };
}

function emptyOverlays(): Overlays {
  return emptyTables();
}

const memberKey = (tenantId: TenantId, userId: string): string => lockKey(tenantId, userId);
const claimKey = (tenantId: TenantId, hostname: string): string => lockKey(tenantId, hostname);

/** Order strings by code point, as a binary UTF-8 collation does. */
function compareText(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

const toDate = (ms: number): Date => new Date(ms);
const toOptionalDate = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

function tenantRecord(row: TenantRow): TenantSummary {
  return Object.freeze({
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    plan: row.plan,
    ownerUserId: row.ownerUserId,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
    suspendedAt: toOptionalDate(row.suspendedAt),
    suspensionReason: row.suspensionReason,
    deletionDueAt: toOptionalDate(row.deletionDueAt),
    version: row.version,
  });
}

function membershipRecord(row: MembershipRow): Membership {
  return Object.freeze({
    tenantId: row.tenantId,
    userId: row.userId,
    role: row.role,
    invitedBy: row.invitedBy,
    createdAt: toDate(row.createdAt),
  });
}

function invitationRecord(row: InvitationRow): Invitation {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedBy,
    expiresAt: toDate(row.expiresAt),
    createdAt: toDate(row.createdAt),
  });
}

function claimRecord(row: ClaimRow): DomainClaim {
  return Object.freeze({
    tenantId: row.tenantId,
    hostname: row.hostname,
    token: row.token,
    verifiedHostname: row.verifiedAt === null ? null : row.hostname,
    primary: row.primary,
    verifiedAt: toOptionalDate(row.verifiedAt),
    expiresAt: toOptionalDate(row.expiresAt),
    failures: row.failures,
    failingSince: toOptionalDate(row.failingSince),
    lastCheckedAt: toOptionalDate(row.lastCheckedAt),
    createdAt: toDate(row.createdAt),
  });
}

function auditRecord(row: AuditRow): TenantAuditRecord {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenantId,
    at: toDate(row.at),
    actor: row.actor,
    action: row.action,
    target: row.target,
    reason: row.reason,
    traceId: row.traceId,
  });
}

function grantRecord(row: GrantRow): OperatorGrant {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenantId,
    operatorId: row.operatorId,
    reason: row.reason,
    write: row.write,
    openedAt: toDate(row.openedAt),
    expiresAt: toDate(row.expiresAt),
    closedAt: toOptionalDate(row.closedAt),
  });
}

/** One open transaction. */
class TxState implements LockHolder {
  readonly overlays: Overlays = emptyOverlays();
  /** Tenants whose row or memberships this transaction wrote. */
  readonly touched = new Set<TenantId>();
  readonly callbacks: (() => void)[] = [];
  readonly ended: Promise<void>;
  readonly end: () => void;
  phase: 'open' | 'closing' | 'ended' = 'open';
  failure: { readonly error: unknown } | null = null;
  chain: Promise<void> = Promise.resolve();
  waitingFor: LockHolder | null = null;

  constructor() {
    let resolve: () => void = () => undefined;
    this.ended = new Promise<void>((settle) => {
      resolve = settle;
    });
    this.end = resolve;
  }
}

/** The tables as one reader sees them: committed rows, plus its own writes in a transaction. */
class View {
  readonly #tables: Tables;
  readonly #tx: TxState | null;
  readonly #locks: TransactionLocks;

  constructor(tables: Tables, tx: TxState | null, locks: TransactionLocks) {
    this.#tables = tables;
    this.#tx = tx;
    this.#locks = locks;
  }

  get<K extends TableName>(table: K, key: string): Rows[K] | undefined {
    const overlay: Map<string, Rows[K] | null> | undefined = this.#tx?.overlays[table];
    if (overlay?.has(key) === true) {
      return overlay.get(key) ?? undefined;
    }
    const rows: Map<string, Rows[K]> = this.#tables[table];
    return rows.get(key);
  }

  rows<K extends TableName>(table: K): Rows[K][] {
    const overlay: Map<string, Rows[K] | null> | undefined = this.#tx?.overlays[table];
    const committed: Map<string, Rows[K]> = this.#tables[table];
    const out: Rows[K][] = [];
    for (const [key, row] of committed) {
      if (overlay?.has(key) !== true) {
        out.push(row);
      }
    }
    for (const row of overlay?.values() ?? []) {
      if (row !== null) {
        out.push(row);
      }
    }
    return out;
  }

  put<K extends TableName>(table: K, key: string, row: Rows[K]): void {
    const overlay: Map<string, Rows[K] | null> = this.#writer().overlays[table];
    Object.freeze(row);
    overlay.set(key, row);
  }

  remove(table: TableName, key: string): void {
    this.#writer().overlays[table].set(key, null);
  }

  touch(tenantId: TenantId): void {
    this.#writer().touched.add(tenantId);
  }

  lock(...parts: readonly (string | number)[]): Promise<void> {
    return this.#locks.acquire(this.#writer(), lockKey(...parts));
  }

  #writer(): TxState {
    if (this.#tx === null) {
      throw new TenancyError('transaction_closed');
    }
    return this.#tx;
  }
}

type Run = <T>(statement: TenancyStatement, body: (view: View) => T | Promise<T>) => Promise<T>;

function byTime(a: number | null, b: number | null): number {
  return (a ?? Number.NEGATIVE_INFINITY) - (b ?? Number.NEGATIVE_INFINITY);
}

class MemoryReads implements TenancyReads {
  protected readonly run: Run;

  constructor(run: Run) {
    this.run = run;
  }

  tenantById(id: TenantId): Promise<TenantSummary | null> {
    return this.run('tenantById', (view) => {
      const row = view.get('tenants', String(requireTenantId(id)));
      return row === undefined ? null : tenantRecord(row);
    });
  }

  tenantBySlug(slug: string): Promise<TenantSummary | null> {
    return this.run('tenantBySlug', (view) => {
      const wanted = requireLookup(slug);
      const row = view.rows('tenants').find((tenant) => tenant.slug === wanted);
      return row === undefined ? null : tenantRecord(row);
    });
  }

  tenantByVerifiedHostname(hostname: string): Promise<TenantSummary | null> {
    return this.run('tenantByVerifiedHostname', (view) => {
      const wanted = requireLookup(hostname);
      const claim = view
        .rows('claims')
        .find((row) => row.hostname === wanted && row.verifiedAt !== null);
      const row = claim === undefined ? undefined : view.get('tenants', String(claim.tenantId));
      return row === undefined ? null : tenantRecord(row);
    });
  }

  tenantSettings(id: TenantId): Promise<string | null> {
    return this.run('tenantSettings', (view) => {
      return view.get('tenants', String(requireTenantId(id)))?.settings ?? null;
    });
  }

  tenantsDueForPurge(before: Date, limit: number): Promise<readonly TenantSummary[]> {
    return this.run('tenantsDueForPurge', (view) => {
      const at = requireDate(before);
      const max = requireBatchLimit(limit);
      return Object.freeze(
        view
          .rows('tenants')
          .filter(
            (row) =>
              row.status === 'purging' ||
              (row.status === 'pending_deletion' &&
                row.deletionDueAt !== null &&
                row.deletionDueAt <= at),
          )
          .sort((a, b) => byTime(a.deletionDueAt, b.deletionDueAt) || a.id - b.id)
          .slice(0, max)
          .map(tenantRecord),
      );
    });
  }

  membership(tenantId: TenantId, userId: string): Promise<Membership | null> {
    return this.run('membership', (view) => {
      const row = view.get(
        'memberships',
        memberKey(requireTenantId(tenantId), requireLookup(userId)),
      );
      return row === undefined ? null : membershipRecord(row);
    });
  }

  members(tenantId: TenantId, page: PageRequest): Promise<Page<Membership>> {
    return this.run('members', (view) => {
      const id = requireTenantId(tenantId);
      const window = pageWindow('members', page);
      const after = window.after;
      const rows = view
        .rows('memberships')
        .filter(
          (row) => row.tenantId === id && (after === null || compareText(row.userId, after) > 0),
        )
        .sort((a, b) => compareText(a.userId, b.userId))
        .slice(0, window.limit + 1)
        .map(membershipRecord);
      return cutPage('members', rows, window.limit, (row) => row.userId);
    });
  }

  membershipsOfUser(userId: string, page: PageRequest): Promise<Page<MembershipOfUser>> {
    return this.run('membershipsOfUser', (view) => {
      const user = requireLookup(userId);
      const window = pageWindow('memberships_of_user', page);
      const after = window.after ?? 0;
      const rows: MembershipOfUser[] = [];
      for (const row of view
        .rows('memberships')
        .filter((membership) => membership.userId === user && membership.tenantId > after)
        .sort((a, b) => a.tenantId - b.tenantId)) {
        const tenant = view.get('tenants', String(row.tenantId));
        if (tenant !== undefined) {
          rows.push(Object.freeze({ ...membershipRecord(row), tenant: tenantRecord(tenant) }));
        }
        if (rows.length > window.limit) {
          break;
        }
      }
      return cutPage('memberships_of_user', rows, window.limit, (row) => row.tenantId);
    });
  }

  countMembers(tenantId: TenantId): Promise<number> {
    return this.run('countMembers', (view) => {
      const id = requireTenantId(tenantId);
      return view.rows('memberships').filter((row) => row.tenantId === id).length;
    });
  }

  invitation(id: number): Promise<Invitation | null> {
    return this.run('invitation', (view) => {
      const row = view.get('invitations', String(requireRowId(id)));
      return row === undefined ? null : invitationRecord(row);
    });
  }

  invitationByTokenHash(tokenHash: Uint8Array): Promise<Invitation | null> {
    return this.run('invitationByTokenHash', (view) => {
      const hex = requireTokenHash(tokenHash);
      const row = view.rows('invitations').find((invitation) => invitation.tokenHash === hex);
      return row === undefined ? null : invitationRecord(row);
    });
  }

  invitationByEmail(tenantId: TenantId, email: string): Promise<Invitation | null> {
    return this.run('invitationByEmail', (view) => {
      const id = requireTenantId(tenantId);
      const wanted = requireLookup(email);
      const row = view
        .rows('invitations')
        .find((invitation) => invitation.tenantId === id && invitation.email === wanted);
      return row === undefined ? null : invitationRecord(row);
    });
  }

  invitations(tenantId: TenantId, page: PageRequest): Promise<Page<Invitation>> {
    return this.run('invitations', (view) => {
      const id = requireTenantId(tenantId);
      const window = pageWindow('invitations', page);
      const after = window.after ?? 0;
      const rows = view
        .rows('invitations')
        .filter((row) => row.tenantId === id && row.id > after)
        .sort((a, b) => a.id - b.id)
        .slice(0, window.limit + 1)
        .map(invitationRecord);
      return cutPage('invitations', rows, window.limit, (row) => row.id);
    });
  }

  countOpenInvitations(tenantId: TenantId, now: Date): Promise<number> {
    return this.run('countOpenInvitations', (view) => {
      const id = requireTenantId(tenantId);
      const at = requireDate(now);
      return view.rows('invitations').filter((row) => row.tenantId === id && row.expiresAt > at)
        .length;
    });
  }

  invitationsExpiredBefore(before: Date, limit: number): Promise<readonly Invitation[]> {
    return this.run('invitationsExpiredBefore', (view) => {
      const at = requireDate(before);
      const max = requireBatchLimit(limit);
      return Object.freeze(
        view
          .rows('invitations')
          .filter((row) => row.expiresAt <= at)
          .sort((a, b) => a.expiresAt - b.expiresAt || a.id - b.id)
          .slice(0, max)
          .map(invitationRecord),
      );
    });
  }

  domainClaim(tenantId: TenantId, hostname: string): Promise<DomainClaim | null> {
    return this.run('domainClaim', (view) => {
      const row = view.get('claims', claimKey(requireTenantId(tenantId), requireLookup(hostname)));
      return row === undefined ? null : claimRecord(row);
    });
  }

  domainClaims(tenantId: TenantId): Promise<readonly DomainClaim[]> {
    return this.run('domainClaims', (view) => {
      const id = requireTenantId(tenantId);
      return Object.freeze(
        view
          .rows('claims')
          .filter((row) => row.tenantId === id)
          .sort((a, b) => compareText(a.hostname, b.hostname))
          .map(claimRecord),
      );
    });
  }

  domainClaimsOfHostname(hostname: string): Promise<readonly DomainClaim[]> {
    return this.run('domainClaimsOfHostname', (view) => {
      const wanted = requireLookup(hostname);
      return Object.freeze(
        view
          .rows('claims')
          .filter((row) => row.hostname === wanted)
          .sort((a, b) => a.tenantId - b.tenantId)
          .map(claimRecord),
      );
    });
  }

  domainClaimsDueForCheck(before: Date, limit: number): Promise<readonly DomainClaim[]> {
    return this.run('domainClaimsDueForCheck', (view) => {
      const at = requireDate(before);
      const max = requireBatchLimit(limit);
      return Object.freeze(
        view
          .rows('claims')
          .filter((row) => row.lastCheckedAt === null || row.lastCheckedAt < at)
          .sort(
            (a, b) =>
              byTime(a.lastCheckedAt, b.lastCheckedAt) ||
              a.tenantId - b.tenantId ||
              compareText(a.hostname, b.hostname),
          )
          .slice(0, max)
          .map(claimRecord),
      );
    });
  }

  audit(tenantId: TenantId, page: PageRequest): Promise<Page<TenantAuditRecord>> {
    return this.run('audit', (view) => {
      const id = requireTenantId(tenantId);
      const window = pageWindow('audit', page);
      const after = window.after ?? Number.POSITIVE_INFINITY;
      const rows = view
        .rows('audit')
        .filter((row) => row.tenantId === id && row.id < after)
        .sort((a, b) => b.id - a.id)
        .slice(0, window.limit + 1)
        .map(auditRecord);
      return cutPage('audit', rows, window.limit, (row) => row.id);
    });
  }

  countAudit(tenantId: TenantId, action: TenantAuditAction, since: Date): Promise<number> {
    return this.run('countAudit', (view) => {
      const id = requireTenantId(tenantId);
      const wanted = requireAuditAction(action);
      const at = requireDate(since);
      return view
        .rows('audit')
        .filter((row) => row.tenantId === id && row.action === wanted && row.at >= at).length;
    });
  }

  operatorGrant(id: number): Promise<OperatorGrant | null> {
    return this.run('operatorGrant', (view) => {
      const row = view.get('grants', String(requireRowId(id)));
      return row === undefined ? null : grantRecord(row);
    });
  }

  activeOperatorGrant(
    tenantId: TenantId,
    operatorId: string,
    now: Date,
  ): Promise<OperatorGrant | null> {
    return this.run('activeOperatorGrant', (view) => {
      const id = requireTenantId(tenantId);
      const operator = requireLookup(operatorId);
      const at = requireDate(now);
      const row = view
        .rows('grants')
        .filter(
          (grant) =>
            grant.tenantId === id &&
            grant.operatorId === operator &&
            grant.closedAt === null &&
            grant.openedAt <= at &&
            grant.expiresAt > at,
        )
        .sort((a, b) => b.expiresAt - a.expiresAt || b.id - a.id)[0];
      return row === undefined ? null : grantRecord(row);
    });
  }

  activeOperatorGrants(tenantId: TenantId, now: Date): Promise<readonly OperatorGrant[]> {
    return this.run('activeOperatorGrants', (view) => {
      const id = requireTenantId(tenantId);
      const at = requireDate(now);
      return Object.freeze(
        view
          .rows('grants')
          .filter(
            (grant) =>
              grant.tenantId === id &&
              grant.closedAt === null &&
              grant.openedAt <= at &&
              grant.expiresAt > at,
          )
          .sort((a, b) => a.expiresAt - b.expiresAt || a.id - b.id)
          .map(grantRecord),
      );
    });
  }
}

function tenantChanges(patch: TenantPatch): Mutable<TenantRow> {
  requireRecord(patch);
  const changes: Mutable<TenantRow> = { updatedAt: requireDate(patch.updatedAt) };
  if (patch.name !== undefined) changes.name = requireText(patch.name, LIMITS.name);
  if (patch.plan !== undefined) changes.plan = requireOptionalText(patch.plan, LIMITS.plan);
  if (patch.status !== undefined) changes.status = requireStatus(patch.status);
  if (patch.ownerUserId !== undefined) changes.ownerUserId = requireUserId(patch.ownerUserId);
  if (patch.settings !== undefined) changes.settings = requireSettings(patch.settings);
  if (patch.suspendedAt !== undefined) changes.suspendedAt = requireOptionalDate(patch.suspendedAt);
  if (patch.suspensionReason !== undefined) {
    changes.suspensionReason = requireOptionalText(patch.suspensionReason, LIMITS.reason);
  }
  if (patch.deletionDueAt !== undefined) {
    changes.deletionDueAt = requireOptionalDate(patch.deletionDueAt);
  }
  return changes;
}

function claimChanges(patch: DomainClaimPatch): Mutable<ClaimRow> {
  requireRecord(patch);
  const changes: Mutable<ClaimRow> = {};
  if (patch.token !== undefined) changes.token = requireDomainToken(patch.token);
  if (patch.verifiedAt !== undefined) changes.verifiedAt = requireOptionalDate(patch.verifiedAt);
  if (patch.expiresAt !== undefined) changes.expiresAt = requireOptionalDate(patch.expiresAt);
  if (patch.failures !== undefined) changes.failures = requireCount(patch.failures);
  if (patch.failingSince !== undefined) {
    changes.failingSince = requireOptionalDate(patch.failingSince);
  }
  if (patch.lastCheckedAt !== undefined) {
    changes.lastCheckedAt = requireOptionalDate(patch.lastCheckedAt);
  }
  return changes;
}

class MemoryTx extends MemoryReads implements TenancyTx {
  readonly #tx: TxState;
  readonly #sequences: Sequences;

  constructor(run: Run, tx: TxState, sequences: Sequences) {
    super(run);
    this.#tx = tx;
    this.#sequences = sequences;
  }

  #next(sequence: keyof Sequences): number {
    this.#sequences[sequence] += 1;
    return this.#sequences[sequence];
  }

  /** Lock a tenant row and confirm it exists, as a child insert's foreign key does. */
  async #parent(view: View, tenantId: TenantId): Promise<TenantRow> {
    await view.lock('tenants', tenantId);
    const tenant = view.get('tenants', String(tenantId));
    if (tenant === undefined) {
      throw new TenancyError('not_found');
    }
    return tenant;
  }

  lockTenant(id: TenantId): Promise<TenantSummary | null> {
    return this.run('lockTenant', async (view) => {
      const tenantId = requireTenantId(id);
      await view.lock('tenants', tenantId);
      const row = view.get('tenants', String(tenantId));
      return row === undefined ? null : tenantRecord(row);
    });
  }

  insertTenant(row: NewTenant): Promise<TenantSummary> {
    return this.run('insertTenant', async (view) => {
      requireRecord(row);
      const slug = requireSlug(row.slug);
      const name = requireText(row.name, LIMITS.name);
      const plan = requireOptionalText(row.plan, LIMITS.plan);
      const ownerUserId = requireUserId(row.ownerUserId);
      const settings = requireSettings(row.settings);
      const createdAt = requireDate(row.createdAt);
      await view.lock('tenants.slug', slug);
      if (view.rows('tenants').some((tenant) => tenant.slug === slug)) {
        throw new TenancyError('slug_taken');
      }
      const id = this.#next('tenants');
      await view.lock('tenants', id);
      const tenant: TenantRow = {
        id,
        slug,
        name,
        status: 'active',
        plan,
        ownerUserId,
        settings,
        createdAt,
        updatedAt: createdAt,
        suspendedAt: null,
        suspensionReason: null,
        deletionDueAt: null,
        version: 1,
      };
      view.put('tenants', String(id), tenant);
      view.touch(id);
      return tenantRecord(tenant);
    });
  }

  updateTenant(id: TenantId, expectedVersion: number, patch: TenantPatch): Promise<TenantSummary> {
    return this.run('updateTenant', async (view) => {
      const tenantId = requireTenantId(id);
      const expected = requireRowId(expectedVersion);
      const changes = tenantChanges(patch);
      await view.lock('tenants', tenantId);
      const current = view.get('tenants', String(tenantId));
      if (current === undefined) {
        throw new TenancyError('not_found');
      }
      if (current.version !== expected) {
        throw new TenancyError('stale_tenant');
      }
      const next: TenantRow = { ...current, ...changes, version: current.version + 1 };
      view.put('tenants', String(tenantId), next);
      view.touch(tenantId);
      return tenantRecord(next);
    });
  }

  deleteTenant(id: TenantId): Promise<boolean> {
    return this.run('deleteTenant', async (view) => {
      const tenantId = requireTenantId(id);
      await view.lock('tenants', tenantId);
      const tenant = view.get('tenants', String(tenantId));
      if (tenant === undefined) {
        return false;
      }
      await view.lock('tenants.slug', tenant.slug);
      // Holding the tenant row keeps new children out; existing ones are
      // re-read after each lock because a concurrent change may have moved them.
      for (const member of view.rows('memberships').filter((row) => row.tenantId === tenantId)) {
        await view.lock('memberships', tenantId, member.userId);
        view.remove('memberships', memberKey(tenantId, member.userId));
      }
      for (const invitation of view
        .rows('invitations')
        .filter((row) => row.tenantId === tenantId)) {
        await view.lock('invitations', invitation.id);
        await view.lock('invitations.email', tenantId, invitation.email);
        await view.lock('invitations.token', invitation.tokenHash);
        view.remove('invitations', String(invitation.id));
      }
      for (const claim of view.rows('claims').filter((row) => row.tenantId === tenantId)) {
        await view.lock('claims', tenantId, claim.hostname);
        const current = view.get('claims', claimKey(tenantId, claim.hostname));
        if (current !== undefined && current.verifiedAt !== null) {
          await view.lock('claims.verified', claim.hostname);
        }
        view.remove('claims', claimKey(tenantId, claim.hostname));
      }
      for (const grant of view.rows('grants').filter((row) => row.tenantId === tenantId)) {
        await view.lock('grants', grant.id);
        view.remove('grants', String(grant.id));
      }
      view.remove('tenants', String(tenantId));
      return true;
    });
  }

  insertMembership(row: Membership): Promise<Membership> {
    return this.run('insertMembership', async (view) => {
      requireRecord(row);
      const tenantId = requireTenantId(row.tenantId);
      const membership: MembershipRow = {
        tenantId,
        userId: requireUserId(row.userId),
        role: requireRole(row.role),
        invitedBy: row.invitedBy === null ? null : requireUserId(row.invitedBy),
        createdAt: requireDate(row.createdAt),
      };
      await this.#parent(view, tenantId);
      await view.lock('memberships', tenantId, membership.userId);
      const key = memberKey(tenantId, membership.userId);
      if (view.get('memberships', key) !== undefined) {
        throw new TenancyError('already_member');
      }
      view.put('memberships', key, membership);
      view.touch(tenantId);
      return membershipRecord(membership);
    });
  }

  updateMembershipRole(
    tenantId: TenantId,
    userId: string,
    role: string,
  ): Promise<Membership | null> {
    return this.run('updateMembershipRole', async (view) => {
      const id = requireTenantId(tenantId);
      const user = requireUserId(userId);
      const nextRole = requireRole(role);
      await view.lock('memberships', id, user);
      const key = memberKey(id, user);
      const current = view.get('memberships', key);
      if (current === undefined) {
        return null;
      }
      const next: MembershipRow = { ...current, role: nextRole };
      view.put('memberships', key, next);
      view.touch(id);
      return membershipRecord(next);
    });
  }

  deleteMembership(tenantId: TenantId, userId: string): Promise<boolean> {
    return this.run('deleteMembership', async (view) => {
      const id = requireTenantId(tenantId);
      const user = requireUserId(userId);
      await view.lock('memberships', id, user);
      const key = memberKey(id, user);
      if (view.get('memberships', key) === undefined) {
        return false;
      }
      view.remove('memberships', key);
      view.touch(id);
      return true;
    });
  }

  putInvitation(row: NewInvitation): Promise<PutInvitationResult> {
    return this.run('putInvitation', async (view) => {
      requireRecord(row);
      const tenantId = requireTenantId(row.tenantId);
      const email = requireEmail(row.email);
      const role = requireRole(row.role);
      const invitedBy = requireUserId(row.invitedBy);
      const tokenHash = requireTokenHash(row.tokenHash);
      const expiresAt = requireDate(row.expiresAt);
      const createdAt = requireDate(row.createdAt);
      await this.#parent(view, tenantId);
      await view.lock('invitations.email', tenantId, email);
      await view.lock('invitations.token', tokenHash);
      if (view.rows('invitations').some((invitation) => invitation.tokenHash === tokenHash)) {
        throw new TenancyError('transaction_conflict');
      }
      const existing = view
        .rows('invitations')
        .find((invitation) => invitation.tenantId === tenantId && invitation.email === email);
      if (existing !== undefined) {
        await view.lock('invitations', existing.id);
        await view.lock('invitations.token', existing.tokenHash);
        view.remove('invitations', String(existing.id));
      }
      const id = this.#next('invitations');
      await view.lock('invitations', id);
      const invitation: InvitationRow = {
        id,
        tenantId,
        email,
        role,
        invitedBy,
        tokenHash,
        expiresAt,
        createdAt,
      };
      view.put('invitations', String(id), invitation);
      return Object.freeze({
        invitation: invitationRecord(invitation),
        replaced: existing === undefined ? null : invitationRecord(existing),
      });
    });
  }

  deleteInvitation(id: number): Promise<boolean> {
    return this.run('deleteInvitation', async (view) => {
      const invitationId = requireRowId(id);
      await view.lock('invitations', invitationId);
      const current = view.get('invitations', String(invitationId));
      if (current === undefined) {
        return false;
      }
      await view.lock('invitations.email', current.tenantId, current.email);
      await view.lock('invitations.token', current.tokenHash);
      view.remove('invitations', String(invitationId));
      return true;
    });
  }

  insertDomainClaim(row: NewDomainClaim): Promise<DomainClaim> {
    return this.run('insertDomainClaim', async (view) => {
      requireRecord(row);
      const tenantId = requireTenantId(row.tenantId);
      const claim: ClaimRow = {
        tenantId,
        hostname: requireHostname(row.hostname),
        token: requireDomainToken(row.token),
        primary: false,
        verifiedAt: null,
        expiresAt: requireDate(row.expiresAt),
        failures: 0,
        failingSince: null,
        lastCheckedAt: null,
        createdAt: requireDate(row.createdAt),
      };
      await this.#parent(view, tenantId);
      await view.lock('claims', tenantId, claim.hostname);
      const key = claimKey(tenantId, claim.hostname);
      if (view.get('claims', key) !== undefined) {
        throw new TenancyError('domain_claimed');
      }
      view.put('claims', key, claim);
      return claimRecord(claim);
    });
  }

  updateDomainClaim(
    tenantId: TenantId,
    hostname: string,
    patch: DomainClaimPatch,
  ): Promise<DomainClaim | null> {
    return this.run('updateDomainClaim', async (view) => {
      const id = requireTenantId(tenantId);
      const host = requireHostname(hostname);
      const changes = claimChanges(patch);
      await view.lock('claims', id, host);
      const key = claimKey(id, host);
      const current = view.get('claims', key);
      if (current === undefined) {
        return null;
      }
      const next: ClaimRow = { ...current, ...changes };
      if (next.verifiedAt === null && next.expiresAt === null) {
        throw storeInputError();
      }
      if (current.verifiedAt === null && next.verifiedAt !== null) {
        await view.lock('claims.verified', host);
        if (
          view
            .rows('claims')
            .some((row) => row.hostname === host && row.verifiedAt !== null && row.tenantId !== id)
        ) {
          throw new TenancyError('domain_taken');
        }
      }
      if (current.verifiedAt !== null && next.verifiedAt === null) {
        await view.lock('claims.verified', host);
      }
      const stored: ClaimRow = next.verifiedAt === null ? { ...next, primary: false } : next;
      view.put('claims', key, stored);
      return claimRecord(stored);
    });
  }

  deleteDomainClaim(tenantId: TenantId, hostname: string): Promise<boolean> {
    return this.run('deleteDomainClaim', async (view) => {
      const id = requireTenantId(tenantId);
      const host = requireHostname(hostname);
      await view.lock('claims', id, host);
      const key = claimKey(id, host);
      const current = view.get('claims', key);
      if (current === undefined) {
        return false;
      }
      if (current.verifiedAt !== null) {
        await view.lock('claims.verified', host);
      }
      view.remove('claims', key);
      return true;
    });
  }

  setPrimaryDomain(tenantId: TenantId, hostname: string | null): Promise<boolean> {
    return this.run('setPrimaryDomain', async (view) => {
      const id = requireTenantId(tenantId);
      const host = hostname === null ? null : requireHostname(hostname);
      await view.lock('tenants', id);
      if (view.get('tenants', String(id)) === undefined) {
        return false;
      }
      const hostnames = view
        .rows('claims')
        .filter((row) => row.tenantId === id)
        .map((row) => row.hostname)
        .sort(compareText);
      for (const name of hostnames) {
        await view.lock('claims', id, name);
      }
      if (host !== null) {
        const target = view.get('claims', claimKey(id, host));
        if (target === undefined) {
          return false;
        }
        if (target.verifiedAt === null) {
          throw new TenancyError('domain_unverified');
        }
      }
      for (const name of hostnames) {
        const key = claimKey(id, name);
        const current = view.get('claims', key);
        if (current !== undefined && current.primary !== (name === host)) {
          view.put('claims', key, { ...current, primary: name === host });
        }
      }
      return true;
    });
  }

  appendAudit(record: NewAuditRecord): Promise<TenantAuditRecord> {
    return this.run('appendAudit', (view) => {
      requireRecord(record);
      const fields = {
        tenantId: requireTenantId(record.tenantId),
        at: requireDate(record.at),
        actor: requireAuditActor(record.actor),
        action: requireAuditAction(record.action),
        target: requireOptionalText(record.target, LIMITS.target),
        reason: requireOptionalText(record.reason, LIMITS.reason),
        traceId: requireOptionalText(record.traceId, LIMITS.traceId),
      };
      const row: AuditRow = { id: this.#next('audit'), ...fields };
      view.put('audit', String(row.id), row);
      return auditRecord(row);
    });
  }

  deleteAuditBefore(before: Date, limit: number): Promise<number> {
    return this.run('deleteAuditBefore', async (view) => {
      const at = requireDate(before);
      const max = requireBatchLimit(limit);
      const ids = view
        .rows('audit')
        .filter((row) => row.at < at)
        .sort((a, b) => a.id - b.id)
        .slice(0, max)
        .map((row) => row.id);
      let deleted = 0;
      for (const id of ids) {
        await view.lock('audit', id);
        if (view.get('audit', String(id)) !== undefined) {
          view.remove('audit', String(id));
          deleted += 1;
        }
      }
      return deleted;
    });
  }

  insertOperatorGrant(row: NewOperatorGrant): Promise<OperatorGrant> {
    return this.run('insertOperatorGrant', async (view) => {
      requireRecord(row);
      const tenantId = requireTenantId(row.tenantId);
      const fields = {
        tenantId,
        operatorId: requireUserId(row.operatorId),
        reason: requireText(row.reason, LIMITS.reason),
        write: requireBoolean(row.write),
        openedAt: requireDate(row.openedAt),
        expiresAt: requireDate(row.expiresAt),
      };
      if (fields.expiresAt <= fields.openedAt) {
        throw storeInputError();
      }
      await this.#parent(view, tenantId);
      const grant: GrantRow = { id: this.#next('grants'), ...fields, closedAt: null };
      await view.lock('grants', grant.id);
      view.put('grants', String(grant.id), grant);
      return grantRecord(grant);
    });
  }

  closeOperatorGrant(id: number, at: Date): Promise<boolean> {
    return this.run('closeOperatorGrant', async (view) => {
      const grantId = requireRowId(id);
      const closedAt = requireDate(at);
      await view.lock('grants', grantId);
      const current = view.get('grants', String(grantId));
      if (current === undefined || current.closedAt !== null) {
        return false;
      }
      view.put('grants', String(grantId), { ...current, closedAt });
      return true;
    });
  }

  closeOperatorGrants(tenantId: TenantId, operatorId: string, at: Date): Promise<number> {
    return this.run('closeOperatorGrants', async (view) => {
      const id = requireTenantId(tenantId);
      const operator = requireUserId(operatorId);
      const closedAt = requireDate(at);
      const ids = view
        .rows('grants')
        .filter(
          (row) => row.tenantId === id && row.operatorId === operator && row.closedAt === null,
        )
        .map((row) => row.id);
      let closed = 0;
      for (const grantId of ids) {
        await view.lock('grants', grantId);
        const current = view.get('grants', String(grantId));
        if (current !== undefined && current.closedAt === null) {
          view.put('grants', String(grantId), { ...current, closedAt });
          closed += 1;
        }
      }
      return closed;
    });
  }

  afterCommit(callback: () => void): void {
    if (this.#tx.phase !== 'open') {
      throw new TenancyError('transaction_closed');
    }
    if (this.#tx.failure !== null) {
      throw new TenancyError('transaction_aborted', { cause: this.#tx.failure.error });
    }
    if (typeof callback !== 'function') {
      throw storeInputError();
    }
    this.#tx.callbacks.push(callback);
  }
}

function resolveOptions(options: MemoryTenancyStoreOptions): Required<MemoryTenancyStoreOptions> {
  if (typeof options !== 'object' || options === null) {
    throw new TenancyError('invalid_store_options');
  }
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 600_000) {
    throw new TenancyError('invalid_store_options');
  }
  const onStatement = options.onStatement ?? (() => undefined);
  const onAfterCommitError =
    options.onAfterCommitError ??
    ((error: unknown) => {
      queueMicrotask(() => {
        throw error;
      });
    });
  if (typeof onStatement !== 'function' || typeof onAfterCommitError !== 'function') {
    throw new TenancyError('invalid_store_options');
  }
  return { lockTimeoutMs, onStatement, onAfterCommitError };
}

class MemoryTenancyStore extends MemoryReads implements TenancyStore {
  readonly #tables: Tables;
  readonly #locks: TransactionLocks;
  readonly #sequences: Sequences = { tenants: 0, invitations: 0, audit: 0, grants: 0 };
  readonly #options: Required<MemoryTenancyStoreOptions>;

  constructor(options: Required<MemoryTenancyStoreOptions>) {
    const tables = emptyTables();
    const locks = new TransactionLocks(options.lockTimeoutMs);
    const committed = new View(tables, null, locks);
    super(async (statement, body) => {
      await options.onStatement({ statement, inTransaction: false });
      return body(committed);
    });
    this.#tables = tables;
    this.#locks = locks;
    this.#options = options;
  }

  async transaction<T>(body: (tx: TenancyTx) => Promise<T>): Promise<T> {
    if (typeof body !== 'function') {
      throw storeInputError();
    }
    const tx = new TxState();
    const view = new View(this.#tables, tx, this.#locks);
    const onStatement = this.#options.onStatement;
    const run: Run = <R>(
      statement: TenancyStatement,
      step: (stepView: View) => R | Promise<R>,
    ): Promise<R> => {
      if (tx.phase !== 'open') {
        return Promise.reject(new TenancyError('transaction_closed'));
      }
      const result = tx.chain.then(async () => {
        if (tx.failure !== null) {
          throw new TenancyError('transaction_aborted', { cause: tx.failure.error });
        }
        try {
          await onStatement({ statement, inTransaction: true });
          return await step(view);
        } catch (error) {
          tx.failure ??= { error };
          throw error;
        }
      });
      tx.chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    let value: T;
    try {
      value = await body(new MemoryTx(run, tx, this.#sequences));
    } catch (error) {
      await this.#close(tx);
      this.#finish(tx);
      throw error;
    }
    await this.#close(tx);
    try {
      if (tx.failure !== null) {
        throw tx.failure.error;
      }
      this.#checkOwners(view, tx);
    } catch (error) {
      this.#finish(tx);
      throw error;
    }
    this.#commit(tx);
    this.#finish(tx);
    for (const callback of tx.callbacks) {
      try {
        callback();
      } catch (error) {
        this.#options.onAfterCommitError(error);
      }
    }
    return value;
  }

  /** Stop new statements and let the ones already queued settle. */
  async #close(tx: TxState): Promise<void> {
    tx.phase = 'closing';
    await tx.chain;
  }

  #checkOwners(view: View, tx: TxState): void {
    const memberships = view.rows('memberships');
    for (const tenantId of tx.touched) {
      const tenant = view.get('tenants', String(tenantId));
      if (tenant === undefined) {
        continue;
      }
      const owners = memberships.filter(
        (row) => row.tenantId === tenantId && row.role === OWNER_ROLE,
      );
      if (owners.length !== 1 || owners[0]?.userId !== tenant.ownerUserId) {
        throw new TenancyError('owner_required');
      }
    }
  }

  #commit(tx: TxState): void {
    for (const table of TABLE_NAMES) {
      const committed: Map<string, unknown> = this.#tables[table];
      for (const [key, row] of tx.overlays[table]) {
        if (row === null) {
          committed.delete(key);
        } else {
          committed.set(key, row);
        }
      }
    }
  }

  #finish(tx: TxState): void {
    tx.phase = 'ended';
    this.#locks.releaseAll(tx);
    tx.end();
  }
}

/**
 * Create an empty in-memory tenancy store. Throws `invalid_store_options`
 * when an option is out of range.
 */
export function createMemoryTenancyStore(options: MemoryTenancyStoreOptions = {}): TenancyStore {
  return new MemoryTenancyStore(resolveOptions(options));
}
