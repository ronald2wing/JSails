/**
 * Lifecycle operations on custom domains: claim, check, remove, choose the
 * primary domain, and the periodic re-check.
 *
 * A claim binds a hostname to one tenant with its own token. Many tenants may
 * hold a pending claim for the same hostname; only a passing DNS check
 * verifies one, and verification is unique per hostname. When a claim
 * verifies, every other tenant's pending claim for that hostname is evicted,
 * audited on that tenant as a system action (so one tenant's user id never
 * appears in another tenant's trail).
 *
 * A check reads the claim, resolves DNS outside any transaction (a network
 * wait must never hold a tenant lock), then folds the result into the claim
 * under the tenant lock with the pure policy in
 * `domain-verification-policy.ts`. If the claim was removed or re-issued
 * while DNS was being asked, the result is discarded (`stale`). If another
 * tenant verified the hostname first, the claim stays pending (`taken`). A
 * pending claim past its window is deleted without asking DNS.
 *
 * Routine bookkeeping (a passing re-check, another failure in a run) updates
 * the claim without an audit record; changes of routing (verified, failing,
 * unverified, expired, removed, primary) are audited and emitted. A primary
 * domain that loses its verification stops being primary, which is audited
 * (`domain.primary_changed` to none) and emitted (`primary`) like a manual
 * change.
 *
 * Every operation authorizes before it reads the hostname, so someone who
 * may not act on a tenant gets `not_permitted` whatever they send.
 */

import { checkActor, systemActor, type TenancyActor } from './tenancy-actor.js';
import {
  checkDomainChallenge,
  domainChallenge,
  issueDomainClaim,
  type DomainChallenge,
  type DomainCheckStatus,
} from './domain-verification.js';
import {
  nextDomainVerification,
  type DomainVerificationAction,
} from './domain-verification-policy.js';
import { normalizeHostname } from './hostname.js';
import {
  refuse,
  requireTenantId,
  type AccessRule,
  type LifecycleContext,
} from './lifecycle-context.js';
import type { DomainClaim } from './tenancy-records.js';
import type { TenantId } from './tenant-id.js';
import { checkLimit } from './tenant-limits.js';
import { MAX_BATCH_LIMIT } from './tenancy-store.js';

/** A new claim and the record that proves it. */
export interface DomainClaimed {
  readonly claim: DomainClaim;
  readonly challenge: DomainChallenge;
}

/** What one check did. */
export interface DomainCheckResult {
  /** The DNS outcome; `absent` without a lookup for a lapsed pending claim. */
  readonly status: DomainCheckStatus;
  /**
   * The policy's action, `taken` when another tenant verified the hostname
   * first, or `stale` when the claim changed during the lookup.
   */
  readonly action: DomainVerificationAction | 'taken' | 'stale';
  /** The claim after the check; `null` once it expired. */
  readonly claim: DomainClaim | null;
}

/** A failed re-check in a sweep. */
export interface DomainRecheckFailure {
  readonly tenantId: TenantId;
  readonly hostname: string;
  readonly error: unknown;
}

/** The outcome of a re-check sweep. */
export interface DomainRecheck {
  readonly checked: readonly DomainCheckResult[];
  readonly failed: readonly DomainRecheckFailure[];
}

/** The domain operations of the lifecycle. */
export interface DomainOperations {
  addDomain(tenantId: TenantId, hostname: string, by: TenancyActor): Promise<DomainClaimed>;
  checkDomain(
    tenantId: TenantId,
    hostname: string,
    by: TenancyActor,
    signal?: AbortSignal,
  ): Promise<DomainCheckResult>;
  removeDomain(tenantId: TenantId, hostname: string, by: TenancyActor): Promise<void>;
  /** Make a verified claim the primary domain, or clear the primary with `null`. */
  setPrimaryDomain(tenantId: TenantId, hostname: string | null, by: TenancyActor): Promise<void>;
  /** Check claims not checked within the re-check interval, least recent first. */
  recheckDomains(options?: {
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<DomainRecheck>;
}

const EVICTION_REASON = 'hostname verified by another tenant';
const RECHECK_REASON = 'scheduled domain verification';

function requireHostname(value: unknown): string {
  // Called after authorization, never before.
  const hostname = typeof value === 'string' ? normalizeHostname(value) : null;
  if (hostname === null) {
    refuse('invalid_hostname');
  }
  return hostname;
}

/** Build the domain operations on a lifecycle context. */
export function domainOperations<R extends string, P extends string, S>(
  ctx: LifecycleContext<R, P, S>,
): DomainOperations {
  const { options } = ctx;
  const manage: AccessRule<P> = Object.freeze({
    permission: 'domains.manage',
    operator: 'write_grant',
    system: true,
  });
  const maintain: AccessRule<P> = Object.freeze({
    permission: 'domains.manage',
    operator: 'allowed',
    system: true,
  });

  const lookup = async (
    claim: DomainClaim,
    at: Date,
    signal: AbortSignal | undefined,
  ): Promise<DomainCheckStatus> => {
    if (
      claim.verifiedAt === null &&
      claim.expiresAt !== null &&
      claim.expiresAt.getTime() <= at.getTime()
    ) {
      return 'absent';
    }
    const timeout = AbortSignal.timeout(options.dnsTimeoutMs);
    return checkDomainChallenge(
      domainChallenge(claim),
      options.dns,
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    );
  };

  const operations: DomainOperations = {
    async addDomain(tenantId, hostname, by) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      const at = ctx.now();
      return ctx.transaction(async (tx) => {
        const { tenant } = await ctx.access(tx, id, actor, manage, at);
        const draft = issueDomainClaim(
          { tenantId: id, hostname: typeof hostname === 'string' ? hostname : '', now: at },
          {
            rootDomain: options.rootDomain,
            appHosts: options.appHosts,
            policy: options.domainPolicy,
          },
        );
        const limits = await ctx.limits(tenant);
        const claims = (await tx.domainClaims(id)).length;
        if (checkLimit(limits, 'domains', claims) === 'limit_exceeded') {
          refuse('limit_exceeded');
        }
        if ((await tx.domainClaim(id, draft.hostname)) !== null) {
          refuse('domain_claimed');
        }
        const claim = await tx.insertDomainClaim({ ...draft, createdAt: at });
        await ctx.audit(tx, id, at, actor, 'domain.claimed', claim.hostname);
        ctx.emit(tx, { type: 'domain', tenantId: id, hostname: claim.hostname, change: 'claimed' });
        return Object.freeze({ claim, challenge: domainChallenge(claim) });
      });
    },

    async checkDomain(tenantId, hostname, by, signal) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      const started = ctx.now();
      const { host, before } = await ctx.transaction(async (tx) => {
        await ctx.access(tx, id, actor, { ...maintain, lock: false }, started);
        const normalized = requireHostname(hostname);
        return { host: normalized, before: await tx.domainClaim(id, normalized) };
      });
      if (before === null) {
        refuse('not_found');
      }
      const status = await lookup(before, started, signal);
      const at = ctx.now();
      return ctx.transaction(async (tx): Promise<DomainCheckResult> => {
        await ctx.access(tx, id, actor, maintain, at);
        const claim = await tx.domainClaim(id, host);
        if (claim === null) {
          refuse('not_found');
        }
        if (
          claim.token !== before.token ||
          claim.verifiedAt?.getTime() !== before.verifiedAt?.getTime()
        ) {
          return Object.freeze({ status, action: 'stale', claim });
        }
        const outcome = nextDomainVerification(claim, status, at, options.domainPolicy);
        const result = (
          action: DomainCheckResult['action'],
          next: DomainClaim | null,
        ): DomainCheckResult => Object.freeze({ status, action, claim: next });
        switch (outcome.action) {
          case 'expired': {
            await tx.deleteDomainClaim(id, host);
            await ctx.audit(tx, id, at, actor, 'domain.expired', host);
            ctx.emit(tx, { type: 'domain', tenantId: id, hostname: host, change: 'removed' });
            return result('expired', null);
          }
          case 'verified': {
            const others = await tx.domainClaimsOfHostname(host);
            if (others.some((other) => other.tenantId !== id && other.verifiedHostname !== null)) {
              const kept = await tx.updateDomainClaim(id, host, { lastCheckedAt: at });
              return result('taken', kept);
            }
            const verified = await tx.updateDomainClaim(id, host, {
              ...outcome.state,
              lastCheckedAt: at,
            });
            await ctx.audit(tx, id, at, actor, 'domain.verified', host);
            ctx.emit(tx, { type: 'domain', tenantId: id, hostname: host, change: 'verified' });
            const system = systemActor(EVICTION_REASON);
            for (const other of others) {
              if (other.tenantId !== id && (await tx.deleteDomainClaim(other.tenantId, host))) {
                await ctx.audit(tx, other.tenantId, at, system, 'domain.removed', host);
                ctx.emit(tx, {
                  type: 'domain',
                  tenantId: other.tenantId,
                  hostname: host,
                  change: 'removed',
                });
              }
            }
            return result('verified', verified);
          }
          case 'unverified': {
            if (claim.primary) {
              await tx.setPrimaryDomain(id, null);
            }
            const withdrawn = await tx.updateDomainClaim(id, host, {
              ...outcome.state,
              lastCheckedAt: at,
            });
            await ctx.audit(tx, id, at, actor, 'domain.unverified', host);
            ctx.emit(tx, { type: 'domain', tenantId: id, hostname: host, change: 'unverified' });
            if (claim.primary) {
              await ctx.audit(tx, id, at, actor, 'domain.primary_changed', null);
              ctx.emit(tx, { type: 'domain', tenantId: id, hostname: host, change: 'primary' });
            }
            return result('unverified', withdrawn);
          }
          case 'failing': {
            const failing = await tx.updateDomainClaim(id, host, {
              ...outcome.state,
              lastCheckedAt: at,
            });
            if (claim.failures === 0) {
              await ctx.audit(tx, id, at, actor, 'domain.failing', host);
              ctx.emit(tx, { type: 'domain', tenantId: id, hostname: host, change: 'failing' });
            }
            return result('failing', failing);
          }
          case 'still_verified':
          case 'pending': {
            const checked = await tx.updateDomainClaim(id, host, {
              ...outcome.state,
              lastCheckedAt: at,
            });
            return result(outcome.action, checked);
          }
        }
      });
    },

    async removeDomain(tenantId, hostname, by) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      const at = ctx.now();
      await ctx.transaction(async (tx) => {
        await ctx.access(tx, id, actor, manage, at);
        const host = requireHostname(hostname);
        if (!(await tx.deleteDomainClaim(id, host))) {
          refuse('not_found');
        }
        await ctx.audit(tx, id, at, actor, 'domain.removed', host);
        ctx.emit(tx, { type: 'domain', tenantId: id, hostname: host, change: 'removed' });
      });
    },

    async setPrimaryDomain(tenantId, hostname, by) {
      const id = requireTenantId(tenantId);
      const actor = checkActor(by);
      const at = ctx.now();
      await ctx.transaction(async (tx) => {
        await ctx.access(tx, id, actor, manage, at);
        const host = hostname === null ? null : requireHostname(hostname);
        const claims = await tx.domainClaims(id);
        const current = claims.find((claim) => claim.primary)?.hostname ?? null;
        if (host !== null) {
          const target = claims.find((claim) => claim.hostname === host);
          if (target === undefined) {
            refuse('not_found');
          }
          if (target.verifiedHostname === null) {
            refuse('domain_unverified');
          }
        }
        if (current === host) {
          return;
        }
        await tx.setPrimaryDomain(id, host);
        await ctx.audit(tx, id, at, actor, 'domain.primary_changed', host);
        for (const changed of [current, host]) {
          if (changed !== null) {
            ctx.emit(tx, { type: 'domain', tenantId: id, hostname: changed, change: 'primary' });
          }
        }
      });
    },

    async recheckDomains(recheck = {}) {
      const limit = recheck.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_LIMIT) {
        refuse('invalid_lifecycle_options');
      }
      const at = ctx.now();
      const due = await options.store.domainClaimsDueForCheck(
        new Date(at.getTime() - options.domainRecheckMs),
        limit,
      );
      const by: TenancyActor = { kind: 'system', reason: RECHECK_REASON };
      const checked: DomainCheckResult[] = [];
      const failed: DomainRecheckFailure[] = [];
      for (const claim of due) {
        if (recheck.signal?.aborted === true) {
          break;
        }
        try {
          checked.push(
            await operations.checkDomain(claim.tenantId, claim.hostname, by, recheck.signal),
          );
        } catch (error) {
          failed.push(Object.freeze({ tenantId: claim.tenantId, hostname: claim.hostname, error }));
        }
      }
      return Object.freeze({ checked: Object.freeze(checked), failed: Object.freeze(failed) });
    },
  };
  return operations;
}
