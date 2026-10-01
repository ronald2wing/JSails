/**
 * The events the tenancy lifecycle emits.
 *
 * An event is emitted only after the transaction that made the change has
 * committed (through the store's `afterCommit`), so a rolled-back operation
 * emits nothing and a listener never sees a change it could not read back.
 * Events are frozen plain data that name what changed, never a snapshot of
 * it, so a listener (a directory cache, a principal-event bus, a mailer job)
 * re-reads whatever it needs.
 *
 * The invitation event is the one place the plaintext invitation token leaves
 * the lifecycle besides the return value of `invite`: it is meant for the
 * mailer and must not be logged or persisted.
 */

import type { TenantId } from './tenant-id.js';

/** A change to a tenant row. `purged` means the tenant and every row it owned are gone. */
export type TenantChange =
  'created' | 'renamed' | 'settings' | 'plan' | 'status' | 'owner' | 'purged';

/** A change to a membership. */
export type MembershipChange = 'added' | 'role' | 'removed';

/** A change to a domain claim. */
export type DomainChange =
  'claimed' | 'verified' | 'failing' | 'unverified' | 'removed' | 'primary';

/** A change to an operator grant. */
export type OperatorGrantChange = 'opened' | 'closed';

/** One committed tenancy change. */
export type TenancyEvent =
  | { readonly type: 'tenant'; readonly tenantId: TenantId; readonly change: TenantChange }
  | {
      readonly type: 'membership';
      readonly tenantId: TenantId;
      readonly userId: string;
      readonly change: MembershipChange;
    }
  | {
      readonly type: 'domain';
      readonly tenantId: TenantId;
      readonly hostname: string;
      readonly change: DomainChange;
    }
  | {
      readonly type: 'invitation';
      readonly tenantId: TenantId;
      readonly invitationId: number;
      readonly email: string;
      readonly role: string;
      readonly invitedBy: string;
      readonly expiresAt: Date;
      /** The plaintext token, delivered once, to the mailer only. */
      readonly token: string;
    }
  | {
      readonly type: 'operator_grant';
      readonly tenantId: TenantId;
      readonly grantId: number;
      readonly operatorId: string;
      readonly change: OperatorGrantChange;
    };
