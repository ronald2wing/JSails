/**
 * Custom-domain verification by DNS TXT challenge, following
 * draft-ietf-dnsop-domain-verification-techniques-13.
 *
 * - A claim binds one hostname to one tenant with its own random token and a
 *   pending expiry ({@link issueDomainClaim}). Two tenants claiming the same
 *   hostname get different tokens, so a record proves control for the tenant
 *   that published it and no other (draft §6.1, §9.13).
 * - The token is 160 random bits in lower-case unpadded base32, so it survives
 *   any DNS tooling that changes letter case (draft §6.1.1).
 * - The validation record is a TXT record at an application-specific
 *   underscore label, `_jsails-challenge.<hostname>`, whose RDATA is the
 *   key-value form `token=<token>` (draft §6.1.2, §6.2). Verification is
 *   persistent and re-checked periodically, so the record is kept for as long
 *   as the domain is in use; the expiry policy is documented rather than
 *   written into the record (draft §6.3).
 * - {@link checkDomainChallenge} concatenates the character-strings of each
 *   record, reads the token as the first key-value element (or the whole
 *   RDATA when it carries no `token=` key, as the draft allows) and passes when
 *   any record matches. It first checks that the challenge is one
 *   {@link domainChallenge} would build (a well-formed token, the record name
 *   derived from the hostname) and rejects a malformed one, so a forged or
 *   empty token can never match an empty record. Past that check every outcome
 *   is reported, never thrown: `verified`, `absent`, `mismatch`, `dns_error`
 *   or `timeout`.
 * - {@link admissibleDomain} refuses names that cannot or must not be
 *   claimed: single labels, special-use names, the tenancy root domain and
 *   the app's own hosts, together with their subdomains and parents.
 *
 * Whether a check result keeps, grants or withdraws verification is the
 * separate pure policy in `domain-verification-policy.ts`.
 */

import { randomBytes } from 'node:crypto';

import { isNoRecordsError, isTimeoutError, type DnsTxtResolver } from './dns-resolver.js';
import {
  DEFAULT_DOMAIN_VERIFICATION_POLICY,
  type DomainVerificationPolicy,
} from './domain-verification-policy.js';
import { isHostnameWithin, MAX_HOSTNAME_LENGTH, normalizeHostname } from './hostname.js';
import { isTenantId, type TenantId } from './tenant-id.js';
import { TenancyError } from './tenancy-error.js';

/** The underscore label the validation record lives under. */
export const DOMAIN_CHALLENGE_LABEL = '_jsails-challenge';

/** Characters in a domain token: 20 random bytes in base32. */
const DOMAIN_TOKEN_LENGTH = 32;

const DOMAIN_TOKEN_SHAPE = /^[a-z2-7]{32}$/;

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Names that resolve specially or never publicly (RFC 2606, 6761, 6762, 7686,
 * 8375, 9476, and the ICANN-reserved `internal`), so a TXT record there proves
 * nothing.
 */
const SPECIAL_USE_DOMAINS: readonly string[] = Object.freeze([
  'alt',
  'arpa',
  'example',
  'example.com',
  'example.net',
  'example.org',
  'internal',
  'invalid',
  'local',
  'localhost',
  'onion',
  'test',
]);

/** A pending claim of a hostname by a tenant. */
export interface DomainClaimDraft {
  readonly tenantId: TenantId;
  /** The normalised hostname. */
  readonly hostname: string;
  readonly token: string;
  /** When the claim lapses if it has not been verified. */
  readonly expiresAt: Date;
}

/** The TXT record a tenant publishes to prove control of a hostname. */
export interface DomainChallenge {
  readonly hostname: string;
  readonly recordType: 'TXT';
  readonly recordName: string;
  readonly recordValue: string;
}

/** The outcome of one {@link checkDomainChallenge}. */
export type DomainCheckStatus = 'verified' | 'absent' | 'mismatch' | 'dns_error' | 'timeout';

/** Where a tenancy app is served, for {@link admissibleDomain}. */
export interface DomainAdmissionOptions {
  /** The domain tenant subdomains live under, when subdomain routing is used. */
  readonly rootDomain?: string;
  /** Every host the app itself answers on. */
  readonly appHosts: readonly string[];
}

/** The outcome of {@link admissibleDomain}. */
export type DomainAdmission =
  | { readonly ok: true; readonly hostname: string }
  | { readonly ok: false; readonly code: 'invalid_hostname' | 'reserved_hostname' };

/** Generate a domain token: 160 random bits as lower-case unpadded base32. */
export function issueDomainToken(): string {
  const bytes = randomBytes((DOMAIN_TOKEN_LENGTH * 5) / 8);
  let bits = 0;
  let value = 0;
  let token = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      token += BASE32_ALPHABET[(value >>> bits) & 31] ?? '';
    }
    value &= (1 << bits) - 1;
  }
  return token;
}

/** Whether `value` has the shape of a domain token. */
export function isDomainToken(value: unknown): value is string {
  return typeof value === 'string' && DOMAIN_TOKEN_SHAPE.test(value);
}

function normalizeConfiguredHost(value: string): string {
  const hostname = normalizeHostname(value);
  if (hostname === null) {
    throw new TenancyError('invalid_domain_policy');
  }
  return hostname;
}

function related(a: string, b: string): boolean {
  return isHostnameWithin(a, b) || isHostnameWithin(b, a);
}

/**
 * Decide whether a hostname may be claimed as a custom domain. Throws
 * `invalid_domain_policy` when the root domain or an app host is malformed.
 */
export function admissibleDomain(
  hostname: string,
  options: DomainAdmissionOptions,
): DomainAdmission {
  const reserved = [
    ...(options.rootDomain === undefined ? [] : [normalizeConfiguredHost(options.rootDomain)]),
    ...options.appHosts.map(normalizeConfiguredHost),
  ];
  const normalized = normalizeHostname(hostname);
  if (
    normalized === null ||
    !normalized.includes('.') ||
    DOMAIN_CHALLENGE_LABEL.length + 1 + normalized.length > MAX_HOSTNAME_LENGTH
  ) {
    return { ok: false, code: 'invalid_hostname' };
  }
  if (
    SPECIAL_USE_DOMAINS.some((special) => isHostnameWithin(normalized, special)) ||
    reserved.some((host) => related(normalized, host))
  ) {
    return { ok: false, code: 'reserved_hostname' };
  }
  return { ok: true, hostname: normalized };
}

/** Input of {@link issueDomainClaim}. */
export interface DomainClaimInput {
  readonly tenantId: TenantId;
  readonly hostname: string;
  readonly now: Date;
}

/**
 * Open a pending claim: check the hostname is admissible and bind it to the
 * tenant with a fresh token that lapses after the policy's pending TTL.
 * Throws `invalid_tenant_id`, `invalid_hostname` or `reserved_hostname`.
 */
export function issueDomainClaim(
  input: DomainClaimInput,
  options: DomainAdmissionOptions & { readonly policy?: DomainVerificationPolicy },
): DomainClaimDraft {
  if (!isTenantId(input.tenantId)) {
    throw new TenancyError('invalid_tenant_id');
  }
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new TenancyError('invalid_domain_policy');
  }
  const admission = admissibleDomain(input.hostname, options);
  if (!admission.ok) {
    throw new TenancyError(admission.code);
  }
  const policy = options.policy ?? DEFAULT_DOMAIN_VERIFICATION_POLICY;
  return Object.freeze({
    tenantId: input.tenantId,
    hostname: admission.hostname,
    token: issueDomainToken(),
    expiresAt: new Date(input.now.getTime() + policy.pendingTtlMs),
  });
}

/**
 * The record to publish for a claim. Throws `invalid_hostname` or
 * `invalid_domain_token` when the claim is malformed.
 */
export function domainChallenge(claim: {
  readonly hostname: string;
  readonly token: string;
}): DomainChallenge {
  const hostname = normalizeHostname(claim.hostname);
  if (
    hostname === null ||
    DOMAIN_CHALLENGE_LABEL.length + 1 + hostname.length > MAX_HOSTNAME_LENGTH
  ) {
    throw new TenancyError('invalid_hostname');
  }
  if (!isDomainToken(claim.token)) {
    throw new TenancyError('invalid_domain_token');
  }
  return Object.freeze({
    hostname,
    recordType: 'TXT',
    recordName: `${DOMAIN_CHALLENGE_LABEL}.${hostname}`,
    recordValue: `token=${claim.token}`,
  });
}

/**
 * The token a TXT record carries: its character-strings concatenated, then
 * the value of a leading `token=` element (key case-insensitive), or the whole
 * trimmed RDATA when there is no such key.
 */
export function challengeTokenOf(record: readonly string[]): string {
  const rdata = record.join('').trim();
  const first = rdata.split(/[ \t]+/, 1)[0] ?? '';
  return /^token=/i.test(first) ? first.slice('token='.length) : rdata;
}

/** The token of a challenge, after checking it is the one its hostname and token give. */
function expectedToken(challenge: DomainChallenge): string {
  if (typeof challenge !== 'object' || challenge === null) {
    throw new TenancyError('invalid_domain_token');
  }
  const { recordValue } = challenge;
  const token =
    typeof recordValue === 'string' && recordValue.startsWith('token=')
      ? recordValue.slice('token='.length)
      : '';
  const rebuilt = domainChallenge({ hostname: challenge.hostname, token });
  if (
    challenge.recordType !== rebuilt.recordType ||
    challenge.recordName !== rebuilt.recordName ||
    recordValue !== rebuilt.recordValue
  ) {
    throw new TenancyError('invalid_domain_token');
  }
  return token;
}

function isTxtRecords(value: unknown): value is readonly (readonly string[])[] {
  return (
    Array.isArray(value) &&
    value.every(
      (record: unknown) =>
        Array.isArray(record) && record.every((part: unknown) => typeof part === 'string'),
    )
  );
}

/**
 * Look the challenge up and compare. Rejects `invalid_hostname` or
 * `invalid_domain_token` when the challenge is not one {@link domainChallenge}
 * builds; otherwise never throws. An abort of `signal` (or a resolver timeout)
 * reports `timeout`; a name without TXT records reports `absent`; records
 * without the token report `mismatch`; any other resolver failure reports
 * `dns_error`.
 */
export async function checkDomainChallenge(
  challenge: DomainChallenge,
  resolver: DnsTxtResolver,
  signal: AbortSignal = new AbortController().signal,
): Promise<DomainCheckStatus> {
  const expected = expectedToken(challenge);
  if (signal.aborted) {
    return 'timeout';
  }
  // A resolver that ignores the signal still cannot hold the check past it.
  let rejectAborted: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  // Marked handled: it is raced only while the lookup runs; after that nobody
  // awaits it and its rejection means nothing.
  aborted.catch(() => undefined);
  const onAbort = (): void => rejectAborted(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  let records: unknown;
  try {
    const lookup = Promise.resolve().then(() => resolver.resolveTxt(challenge.recordName, signal));
    // Marked handled: when the abort wins the race, the lookup's later
    // rejection has no reader.
    lookup.catch(() => undefined);
    records = await Promise.race([lookup, aborted]);
  } catch (error) {
    if (signal.aborted || isTimeoutError(error)) {
      return 'timeout';
    }
    return isNoRecordsError(error) ? 'absent' : 'dns_error';
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (!isTxtRecords(records)) {
    return 'dns_error';
  }
  if (records.length === 0) {
    return 'absent';
  }
  return records.some((record) => challengeTokenOf(record).toLowerCase() === expected)
    ? 'verified'
    : 'mismatch';
}
