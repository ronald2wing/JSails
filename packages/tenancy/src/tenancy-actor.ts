/**
 * Who performs a tenancy lifecycle operation.
 *
 * A {@link TenancyActor} is a plain union, independent of any session or
 * principal type, so the identity layer maps its own actor onto it at the call
 * site:
 *
 * - `user`: a signed-in person acting as themselves. The lifecycle reads their
 *   membership inside the operation's transaction and applies the role set's
 *   permission and rank rules.
 * - `operator`: staff of the app acting on a tenant they do not belong to.
 *   They bypass role checks but always give a reason, and changing a tenant's
 *   content needs an open write grant (see `operator-grants.ts`).
 * - `system`: the app itself (a job, a sweep, a provisioning script), always
 *   with a reason.
 *
 * {@link checkActor} validates an actor once per operation and derives the
 * audit actor and the reason the audit record carries. User ids are opaque
 * strings from the identity layer; ids and reasons are never echoed in errors.
 */

import { TenancyError } from './tenancy-error.js';
import { TENANCY_COLUMN_LIMITS, type AuditActor } from './tenancy-records.js';

/** The actor of a lifecycle operation. */
export type TenancyActor =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'operator'; readonly userId: string; readonly reason: string }
  | { readonly kind: 'system'; readonly reason: string };

/** A validated actor with what its audit records carry. */
export interface CheckedActor {
  readonly actor: TenancyActor;
  readonly audit: AuditActor;
  /** The reason audit records carry; `null` for a user. */
  readonly reason: string | null;
}

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** A user id as the identity layer gives it, or `null` when it cannot be one. */
export function parseUserId(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    CONTROL.test(value) ||
    [...value].length > TENANCY_COLUMN_LIMITS.userId
  ) {
    return null;
  }
  return value;
}

/**
 * A reason for an audited action: NFC, trimmed, non-empty, printable and at
 * most the reason column long. Throws `reason_required` when it is missing or
 * blank and `invalid_reason` otherwise.
 */
export function parseReason(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TenancyError('reason_required');
  }
  const reason = value.normalize('NFC').trim();
  if (reason.length === 0) {
    throw new TenancyError('reason_required');
  }
  if (CONTROL.test(reason) || [...reason].length > TENANCY_COLUMN_LIMITS.reason) {
    throw new TenancyError('invalid_reason');
  }
  return reason;
}

function requireUserId(value: unknown): string {
  const userId = parseUserId(value);
  if (userId === null) {
    throw new TenancyError('invalid_actor');
  }
  return userId;
}

/**
 * Validate an actor. Throws `invalid_actor` for a malformed actor or user id,
 * and `reason_required` or `invalid_reason` for an operator or system actor
 * without a usable reason.
 */
export function checkActor(value: unknown): CheckedActor {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new TenancyError('invalid_actor');
  }
  switch (value.kind) {
    case 'user': {
      const userId = requireUserId('userId' in value ? value.userId : undefined);
      return Object.freeze({
        actor: Object.freeze({ kind: 'user', userId }),
        audit: Object.freeze({ kind: 'user', id: userId }),
        reason: null,
      });
    }
    case 'operator': {
      const userId = requireUserId('userId' in value ? value.userId : undefined);
      const reason = parseReason('reason' in value ? value.reason : undefined);
      return Object.freeze({
        actor: Object.freeze({ kind: 'operator', userId, reason }),
        audit: Object.freeze({ kind: 'operator', id: userId }),
        reason,
      });
    }
    case 'system': {
      const reason = parseReason('reason' in value ? value.reason : undefined);
      return Object.freeze({
        actor: Object.freeze({ kind: 'system', reason }),
        audit: Object.freeze({ kind: 'system' }),
        reason,
      });
    }
    default:
      throw new TenancyError('invalid_actor');
  }
}

/** The system actor for a sweep or a cross-tenant side effect. */
export function systemActor(reason: string): CheckedActor {
  return checkActor({ kind: 'system', reason });
}
