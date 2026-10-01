/**
 * Runtime checks for values entering a tenancy store.
 *
 * Every store implementation runs a write's columns through these checks
 * before it touches a row, so the memory store and the database store refuse
 * the same inputs: wrong types, values longer than
 * {@link TENANCY_COLUMN_LIMITS}, invalid dates, non-canonical slugs, hostnames
 * and emails, malformed token digests and settings that are not JSON. A
 * refusal is `invalid_store_input`, a developer error: the lifecycle validates
 * user input first, so reaching it means a caller skipped that step.
 *
 * Dates come back as epoch milliseconds, the form the memory store keeps.
 */

import { isDomainToken } from './domain-verification.js';
import { normalizeEmail } from './email-address.js';
import { normalizeHostname } from './hostname.js';
import { MAX_BATCH_LIMIT } from './tenancy-store.js';
import { TenancyError } from './tenancy-error.js';
import {
  TENANCY_COLUMN_LIMITS,
  TENANT_AUDIT_ACTIONS,
  type AuditActor,
  type TenantAuditAction,
} from './tenancy-records.js';
import { isTenantId, type TenantId } from './tenant-id.js';
import { parseTenantStatus, type TenantStatus } from './tenant-status.js';

const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ROLE_SHAPE = /^[a-z][a-z0-9_]{0,31}$/;
const TOKEN_HASH_BYTES = 32;

/** The refusal every check throws. */
export function storeInputError(): TenancyError {
  return new TenancyError('invalid_store_input');
}

function codePoints(value: string): number {
  return [...value].length;
}

/** A tenant id. */
export function requireTenantId(value: unknown): TenantId {
  if (!isTenantId(value)) {
    throw storeInputError();
  }
  return value;
}

/** A positive safe integer row id. */
export function requireRowId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw storeInputError();
  }
  return value;
}

/** A non-empty string of at most `max` code points. */
export function requireText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || codePoints(value) > max) {
    throw storeInputError();
  }
  return value;
}

/** {@link requireText}, or `null`. */
export function requireOptionalText(value: unknown, max: number): string | null {
  return value === null ? null : requireText(value, max);
}

/** A user id. */
export function requireUserId(value: unknown): string {
  return requireText(value, TENANCY_COLUMN_LIMITS.userId);
}

/** A valid `Date`, as epoch milliseconds. */
export function requireDate(value: unknown): number {
  if (!(value instanceof Date)) {
    throw storeInputError();
  }
  const time = value.getTime();
  if (Number.isNaN(time)) {
    throw storeInputError();
  }
  return time;
}

/** {@link requireDate}, or `null`. */
export function requireOptionalDate(value: unknown): number | null {
  return value === null ? null : requireDate(value);
}

/** A non-negative safe integer. */
export function requireCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw storeInputError();
  }
  return value;
}

/** A batch size from 1 to {@link MAX_BATCH_LIMIT}. */
export function requireBatchLimit(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_BATCH_LIMIT
  ) {
    throw storeInputError();
  }
  return value;
}

/** A canonical slug: lower-case letters, digits and inner dashes, at most 63 characters. */
export function requireSlug(value: unknown): string {
  if (typeof value !== 'string' || !SLUG_SHAPE.test(value)) {
    throw storeInputError();
  }
  return value;
}

/** A stored role name, `owner` included. */
export function requireRole(value: unknown): string {
  if (typeof value !== 'string' || !ROLE_SHAPE.test(value)) {
    throw storeInputError();
  }
  return value;
}

/** A tenant status. */
export function requireStatus(value: unknown): TenantStatus {
  const status = parseTenantStatus(value);
  if (status === null) {
    throw storeInputError();
  }
  return status;
}

/** An email address already in its normalised form. */
export function requireEmail(value: unknown): string {
  if (typeof value !== 'string' || normalizeEmail(value) !== value) {
    throw storeInputError();
  }
  return value;
}

/** A hostname already in its normalised form. */
export function requireHostname(value: unknown): string {
  if (typeof value !== 'string' || normalizeHostname(value) !== value) {
    throw storeInputError();
  }
  return value;
}

/** A domain challenge token. */
export function requireDomainToken(value: unknown): string {
  if (!isDomainToken(value)) {
    throw storeInputError();
  }
  return value;
}

/** A 32-byte token digest, as lower-case hex. */
export function requireTokenHash(value: unknown): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== TOKEN_HASH_BYTES) {
    throw storeInputError();
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
}

/** Serialised JSON within the settings size limit. */
export function requireSettings(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > TENANCY_COLUMN_LIMITS.settingsBytes
  ) {
    throw storeInputError();
  }
  try {
    JSON.parse(value);
  } catch (error) {
    throw new TenancyError('invalid_store_input', { cause: error });
  }
  return value;
}

/** A boolean. */
export function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw storeInputError();
  }
  return value;
}

/** An audited action. */
export function requireAuditAction(value: unknown): TenantAuditAction {
  const action = TENANT_AUDIT_ACTIONS.find((known) => known === value);
  if (action === undefined) {
    throw storeInputError();
  }
  return action;
}

/** An audit actor, copied. */
export function requireAuditActor(value: unknown): AuditActor {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw storeInputError();
  }
  if (value.kind === 'system') {
    return Object.freeze({ kind: 'system' });
  }
  if ((value.kind === 'user' || value.kind === 'operator') && 'id' in value) {
    return Object.freeze({ kind: value.kind, id: requireUserId(value.id) });
  }
  throw storeInputError();
}

/** Refuse a record argument that is not a non-null object. */
export function requireRecord(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    throw storeInputError();
  }
}

/** A lookup key: any string (an unknown or non-canonical one simply matches nothing). */
export function requireLookup(value: unknown): string {
  if (typeof value !== 'string') {
    throw storeInputError();
  }
  return value;
}
