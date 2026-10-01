/**
 * The options of the tenancy lifecycle, their defaults and their validation.
 *
 * {@link resolveLifecycleOptions} checks every option once, when the
 * lifecycle is built, and throws `invalid_lifecycle_options` for anything out
 * of range, so a misconfiguration fails at startup rather than on the first
 * request that reaches it.
 *
 * Two values come from the app at run time and are checked on every use:
 * the clock (a `Date` that is not valid is a developer error) and the limits
 * hook (`invalid_limits` for a limit that is not a non-negative integer).
 * Limits the lifecycle enforces itself are `seats` (members, counted together
 * with open invitations when inviting), `invitationsPerDay` (invitations sent
 * in the last 24 hours, against mail abuse through the invite endpoint;
 * default 50) and `domains` (domain claims per tenant, pending ones included,
 * since every claim is a stored row and scheduled DNS queries to a name the
 * claimant chose; default 10). Any other key is the app's own and passes
 * through untouched. An app lifts a default by returning a larger value, or
 * `Infinity`, from the hook.
 *
 * {@link plainTenantSettings} is the settings parser for an app without a
 * settings schema: any JSON object, stored as given.
 */

import type { DnsTxtResolver } from './dns-resolver.js';
import { systemDnsResolver } from './dns-resolver.js';
import {
  DEFAULT_DOMAIN_VERIFICATION_POLICY,
  domainVerificationPolicy,
  type DomainVerificationPolicy,
} from './domain-verification-policy.js';
import { normalizeHostname } from './hostname.js';
import { DEFAULT_SLUG_POLICY, slugPolicy, type SlugPolicy } from './slug-policy.js';
import { TenancyError } from './tenancy-error.js';
import type { TenancyEvent } from './tenancy-events.js';
import type { TenantSummary } from './tenancy-records.js';
import type { TenancyStore } from './tenancy-store.js';
import { limitValue, type TenantLimits } from './tenant-limits.js';
import type { TenantRoleSet } from './tenant-roles.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The limits the lifecycle enforces, with defaults applied. */
export interface EnforcedLimits extends TenantLimits {
  readonly seats: number;
  readonly invitationsPerDay: number;
  readonly domains: number;
}

/** The default number of invitations a tenant may send in 24 hours. */
export const DEFAULT_INVITATIONS_PER_DAY = 50;

/** The default number of domain claims, pending or verified, a tenant may hold. */
export const DEFAULT_DOMAINS = 10;

/** Options of `createTenancyLifecycle`. */
export interface TenancyLifecycleOptions<R extends string, P extends string, S> {
  readonly store: TenancyStore;
  /** The membership roles; `defaultTenantRoles` unless the app defines its own. */
  readonly roles: TenantRoleSet<R, P>;
  /**
   * Validate raw settings and apply defaults; throws `invalid_settings`. Runs
   * on every write and every read. `tenantSettingsParser(schema)` builds one
   * from a zod schema; {@link plainTenantSettings} accepts any JSON object.
   */
  readonly parseSettings: (raw: unknown) => S;
  readonly slugs?: SlugPolicy;
  /** The limits of a tenant; called inside the operation's transaction. */
  readonly limits?: (tenant: TenantSummary) => TenantLimits | Promise<TenantLimits>;
  /** How long an invitation stays valid; 1 hour to 30 days, default 7 days. */
  readonly invitationTtlMs?: number;
  /** How long a scheduled deletion waits before the purge; 0 to 365 days, default 30 days. */
  readonly deletionRetentionMs?: number;
  /** The longest operator grant; 1 minute to 24 hours, default 1 hour. */
  readonly operatorGrantMaxMs?: number;
  /** How long audit records are kept; 1 to 3650 days, default 400 days. */
  readonly auditRetentionMs?: number;
  /** The domain tenant subdomains live under; it and its relatives cannot be claimed. */
  readonly rootDomain?: string;
  /** Hosts the app answers on; they and their relatives cannot be claimed. */
  readonly appHosts?: readonly string[];
  readonly domainPolicy?: DomainVerificationPolicy;
  /** How often a claim is re-checked by the sweep; 1 hour to 30 days, default 24 hours. */
  readonly domainRecheckMs?: number;
  /** The TXT resolver; a fresh system resolver per lookup by default. */
  readonly dns?: DnsTxtResolver;
  /** The longest one domain check waits for DNS; 100 to 60000 ms, default 5000. */
  readonly dnsTimeoutMs?: number;
  /** Retries of an operation that lost a deadlock or lock wait; 0 to 5, default 2. */
  readonly conflictRetries?: number;
  /**
   * Receives every event after its transaction commits. It may be async. A
   * throw or a rejection never reaches the operation, which has committed; it
   * goes to `onEmitError`.
   */
  readonly emit?: (event: TenancyEvent) => void | PromiseLike<void>;
  /**
   * Receives the error of an `emit` call that threw or rejected, with the
   * event's type. By default it is reported through `process.emitWarning`,
   * without the error's message or the event (which can carry a token).
   */
  readonly onEmitError?: (error: unknown, eventType: TenancyEvent['type']) => void;
  /** The clock; `() => new Date()` by default. */
  readonly now?: () => Date;
}

/** Validated options with defaults applied. */
export interface ResolvedLifecycleOptions<R extends string, P extends string, S> {
  readonly store: TenancyStore;
  readonly roles: TenantRoleSet<R, P>;
  readonly parseSettings: (raw: unknown) => S;
  readonly slugs: SlugPolicy;
  readonly limits: (tenant: TenantSummary) => TenantLimits | Promise<TenantLimits>;
  readonly invitationTtlMs: number;
  readonly deletionRetentionMs: number;
  readonly operatorGrantMaxMs: number;
  readonly auditRetentionMs: number;
  readonly rootDomain: string | undefined;
  readonly appHosts: readonly string[];
  readonly domainPolicy: DomainVerificationPolicy;
  readonly domainRecheckMs: number;
  readonly dns: DnsTxtResolver;
  readonly dnsTimeoutMs: number;
  readonly conflictRetries: number;
  readonly emit: (event: TenancyEvent) => void | PromiseLike<void>;
  readonly onEmitError: (error: unknown, eventType: TenancyEvent['type']) => void;
  readonly now: () => Date;
}

function invalid(): TenancyError {
  return new TenancyError('invalid_lifecycle_options');
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw invalid();
  }
  return resolved;
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(
    names.map((name) => [name, Reflect.get(value, name)]),
  );
  return names.every((name) => typeof record[name] === 'function');
}

/**
 * A policy object the caller built, checked by building it again from its own
 * fields, so a hand-written or tampered object is held to the same rules.
 */
function rebuilt<T extends object>(value: T | undefined, fallback: T, build: (given: T) => T): T {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'object' || value === null) {
    throw invalid();
  }
  try {
    return build(value);
  } catch (error) {
    throw new TenancyError('invalid_lifecycle_options', { cause: error });
  }
}

function optionalFunction<F>(value: F | undefined, fallback: F): F {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'function') {
    throw invalid();
  }
  return value;
}

function configuredHost(value: unknown): string {
  const hostname = typeof value === 'string' ? normalizeHostname(value) : null;
  if (hostname === null) {
    throw invalid();
  }
  return hostname;
}

const NO_LIMITS: TenantLimits = Object.freeze({});

/** Report a failed event listener without echoing the error or the event. */
export function warnEmitError(_error: unknown, eventType: TenancyEvent['type']): void {
  process.emitWarning(`@jsails/tenancy: the event listener failed on a ${eventType} event`, {
    code: 'JSAILS_TENANCY_EMIT_FAILED',
  });
}

/**
 * Validate the options and apply defaults. Throws `invalid_lifecycle_options`.
 */
export function resolveLifecycleOptions<R extends string, P extends string, S>(
  options: TenancyLifecycleOptions<R, P, S>,
): ResolvedLifecycleOptions<R, P, S> {
  if (typeof options !== 'object' || options === null) {
    throw invalid();
  }
  if (!hasMethods(options.store, ['transaction', 'tenantById', 'invitationByTokenHash'])) {
    throw invalid();
  }
  if (!hasMethods(options.roles, ['parse', 'rank', 'allows', 'canAssign'])) {
    throw invalid();
  }
  if (typeof options.parseSettings !== 'function') {
    throw invalid();
  }
  const slugs = rebuilt(options.slugs, DEFAULT_SLUG_POLICY, (given) => {
    // Every field is required: a partial object must not fall back to an empty reserved list.
    if (
      !Array.isArray(given.reserved) ||
      given.minLength === undefined ||
      given.maxLength === undefined
    ) {
      throw invalid();
    }
    return slugPolicy({
      minLength: given.minLength,
      maxLength: given.maxLength,
      reserved: given.reserved,
      extendDefaults: false,
    });
  });
  const domainPolicy = rebuilt(
    options.domainPolicy,
    DEFAULT_DOMAIN_VERIFICATION_POLICY,
    domainVerificationPolicy,
  );
  if (options.appHosts !== undefined && !Array.isArray(options.appHosts)) {
    throw invalid();
  }
  const dns = options.dns ?? systemDnsResolver();
  if (!hasMethods(dns, ['resolveTxt'])) {
    throw invalid();
  }
  return Object.freeze({
    store: options.store,
    roles: options.roles,
    parseSettings: options.parseSettings,
    slugs,
    limits: optionalFunction(options.limits, () => NO_LIMITS),
    invitationTtlMs: bounded(options.invitationTtlMs, 7 * DAY_MS, HOUR_MS, 30 * DAY_MS),
    deletionRetentionMs: bounded(options.deletionRetentionMs, 30 * DAY_MS, 0, 365 * DAY_MS),
    operatorGrantMaxMs: bounded(options.operatorGrantMaxMs, HOUR_MS, MINUTE_MS, DAY_MS),
    auditRetentionMs: bounded(options.auditRetentionMs, 400 * DAY_MS, DAY_MS, 3650 * DAY_MS),
    rootDomain: options.rootDomain === undefined ? undefined : configuredHost(options.rootDomain),
    appHosts: Object.freeze((options.appHosts ?? []).map(configuredHost)),
    domainPolicy,
    domainRecheckMs: bounded(options.domainRecheckMs, DAY_MS, HOUR_MS, 30 * DAY_MS),
    dns,
    dnsTimeoutMs: bounded(options.dnsTimeoutMs, 5000, 100, 60_000),
    conflictRetries: bounded(options.conflictRetries, 2, 0, 5),
    emit: optionalFunction<(event: TenancyEvent) => void | PromiseLike<void>>(
      options.emit,
      () => undefined,
    ),
    onEmitError: optionalFunction(options.onEmitError, warnEmitError),
    now: optionalFunction(options.now, () => new Date()),
  });
}

/**
 * The limits the lifecycle enforces, from what the hook returned. Throws
 * `invalid_limits` when the hook returned something other than an object of
 * non-negative integers (or `Infinity`).
 */
export function enforcedLimits(limits: unknown): EnforcedLimits {
  return Object.freeze({
    seats: limitValue(limits, 'seats') ?? Number.POSITIVE_INFINITY,
    invitationsPerDay: limitValue(limits, 'invitationsPerDay') ?? DEFAULT_INVITATIONS_PER_DAY,
    domains: limitValue(limits, 'domains') ?? DEFAULT_DOMAINS,
  });
}

/** JSON settings with no schema. */
export type PlainTenantSettings = Readonly<Record<string, unknown>>;

/**
 * The settings parser for an app without a schema: a plain JSON object,
 * returned as a deep copy. Throws `invalid_settings` for anything else.
 */
export function plainTenantSettings(raw: unknown): PlainTenantSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TenancyError('invalid_settings');
  }
  const prototype: unknown = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TenancyError('invalid_settings');
  }
  let text: string;
  try {
    text = JSON.stringify(raw);
  } catch (error) {
    throw new TenancyError('invalid_settings', { cause: error });
  }
  const copy: unknown = JSON.parse(text);
  if (typeof copy !== 'object' || copy === null || Array.isArray(copy)) {
    throw new TenancyError('invalid_settings');
  }
  return Object.fromEntries(Object.entries(copy));
}
