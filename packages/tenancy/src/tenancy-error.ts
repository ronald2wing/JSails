/**
 * The tenancy error vocabulary, as data.
 *
 * Every refusal the package can raise is one entry in
 * {@link TENANCY_ERROR_CODES}: a stable snake_case code, the kind of failure
 * (which a problem+json layer maps to an HTTP status), the audience it is meant
 * for, and a fixed value-free message. `client` codes describe something the
 * caller can fix or should be told; `developer` codes describe a configuration
 * mistake in the app and never reach an end user as such.
 *
 * {@link TenancyError} is a thin carrier for one code. Callers and tests match
 * on `error.code`, never on the class, so the table can later be registered as
 * a domain in the framework error registry without touching any call site.
 * Messages never echo input: no slug, hostname, email or token is ever part of
 * an error.
 */

import { JsailsError } from 'jsails/support';

/**
 * One problem in a refused value, as a location and a code only: `path` is
 * the chain of keys and indexes to the offending part and `code` names what
 * is wrong with it (a zod issue code such as `invalid_type` or `too_big`).
 * An issue never carries the value or a message derived from it.
 */
export interface TenancyErrorIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
}

/**
 * Options a {@link TenancyError} accepts: the base error's cause, context and
 * suggestion, plus the issues of a refused value.
 */
export type TenancyErrorOptions = ConstructorParameters<typeof JsailsError>[1] & {
  readonly issues?: readonly TenancyErrorIssue[];
};

/** How a tenancy failure should be classified by a transport. */
export type TenancyErrorKind =
  'invalid_input' | 'conflict' | 'not_found' | 'forbidden' | 'expired' | 'limit' | 'misconfigured';

/** Who a tenancy error is addressed to. */
export type TenancyErrorAudience = 'client' | 'developer';

/** One entry of the tenancy error table. */
export interface TenancyErrorSpec {
  readonly kind: TenancyErrorKind;
  readonly audience: TenancyErrorAudience;
  readonly message: string;
}

function spec(
  kind: TenancyErrorKind,
  audience: TenancyErrorAudience,
  message: string,
): TenancyErrorSpec {
  return Object.freeze({ kind, audience, message });
}

/** Every tenancy error code with its kind, audience and fixed message. */
export const TENANCY_ERROR_CODES: Readonly<{
  invalid_slug: TenancyErrorSpec;
  reserved_slug: TenancyErrorSpec;
  slug_taken: TenancyErrorSpec;
  invalid_hostname: TenancyErrorSpec;
  reserved_hostname: TenancyErrorSpec;
  domain_taken: TenancyErrorSpec;
  domain_unverified: TenancyErrorSpec;
  invalid_domain_token: TenancyErrorSpec;
  not_found: TenancyErrorSpec;
  already_member: TenancyErrorSpec;
  not_member: TenancyErrorSpec;
  not_permitted: TenancyErrorSpec;
  invalid_invitation: TenancyErrorSpec;
  invitation_expired: TenancyErrorSpec;
  invalid_email: TenancyErrorSpec;
  email_mismatch: TenancyErrorSpec;
  email_unverified: TenancyErrorSpec;
  owner_required: TenancyErrorSpec;
  role_not_assignable: TenancyErrorSpec;
  invalid_role: TenancyErrorSpec;
  invalid_transition: TenancyErrorSpec;
  tenant_inactive: TenancyErrorSpec;
  purge_in_progress: TenancyErrorSpec;
  limit_exceeded: TenancyErrorSpec;
  invalid_settings: TenancyErrorSpec;
  invalid_settings_schema: TenancyErrorSpec;
  reason_required: TenancyErrorSpec;
  stale_tenant: TenancyErrorSpec;
  invalid_tenant_id: TenancyErrorSpec;
  invalid_name: TenancyErrorSpec;
  invalid_plan: TenancyErrorSpec;
  invalid_reason: TenancyErrorSpec;
  invalid_grant: TenancyErrorSpec;
  purge_not_due: TenancyErrorSpec;
  domain_claimed: TenancyErrorSpec;
  invalid_page_request: TenancyErrorSpec;
  transaction_conflict: TenancyErrorSpec;
  transaction_aborted: TenancyErrorSpec;
  transaction_closed: TenancyErrorSpec;
  invalid_store_input: TenancyErrorSpec;
  invalid_store_options: TenancyErrorSpec;
  invalid_message_input: TenancyErrorSpec;
  invalid_slug_policy: TenancyErrorSpec;
  invalid_role_set: TenancyErrorSpec;
  invalid_root_domain: TenancyErrorSpec;
  invalid_path_prefix: TenancyErrorSpec;
  invalid_domain_policy: TenancyErrorSpec;
  invalid_dns_options: TenancyErrorSpec;
  invalid_actor: TenancyErrorSpec;
  invalid_lifecycle_options: TenancyErrorSpec;
  invalid_limits: TenancyErrorSpec;
}> = Object.freeze({
  invalid_slug: spec('invalid_input', 'client', 'the tenant slug is not valid'),
  reserved_slug: spec('invalid_input', 'client', 'the tenant slug is reserved'),
  slug_taken: spec('conflict', 'client', 'the tenant slug is already taken'),
  invalid_hostname: spec('invalid_input', 'client', 'the hostname is not valid'),
  reserved_hostname: spec('invalid_input', 'client', 'the hostname cannot be claimed'),
  domain_taken: spec('conflict', 'client', 'the hostname is verified by another tenant'),
  domain_unverified: spec('forbidden', 'client', 'the hostname is not verified'),
  invalid_domain_token: spec('invalid_input', 'client', 'the domain challenge token is not valid'),
  not_found: spec('not_found', 'client', 'the tenancy record was not found'),
  already_member: spec('conflict', 'client', 'the user is already a member of the tenant'),
  not_member: spec('forbidden', 'client', 'the user is not a member of the tenant'),
  not_permitted: spec('forbidden', 'client', 'the actor may not perform this tenancy action'),
  invalid_invitation: spec('invalid_input', 'client', 'the invitation is not valid'),
  invitation_expired: spec('expired', 'client', 'the invitation has expired'),
  invalid_email: spec('invalid_input', 'client', 'the email address is not valid'),
  email_mismatch: spec('forbidden', 'client', 'the invitation was sent to another address'),
  email_unverified: spec('forbidden', 'client', 'the email address is not verified'),
  owner_required: spec('conflict', 'client', 'the tenant owner cannot be removed this way'),
  role_not_assignable: spec('forbidden', 'client', 'the role cannot be assigned by this actor'),
  invalid_role: spec('invalid_input', 'client', 'the tenant role is not valid'),
  invalid_transition: spec('conflict', 'client', 'the tenant status does not allow this change'),
  tenant_inactive: spec('forbidden', 'client', 'the tenant is not active'),
  purge_in_progress: spec('conflict', 'client', 'the tenant is being purged'),
  limit_exceeded: spec('limit', 'client', 'the tenant limit has been reached'),
  invalid_settings: spec('invalid_input', 'client', 'the tenant settings are not valid'),
  invalid_settings_schema: spec(
    'misconfigured',
    'developer',
    'the tenant settings schema cannot be used to parse and store settings',
  ),
  reason_required: spec('invalid_input', 'client', 'a reason is required for this action'),
  stale_tenant: spec('conflict', 'client', 'the tenant changed since it was read'),
  invalid_tenant_id: spec('invalid_input', 'client', 'the tenant id is not valid'),
  invalid_name: spec('invalid_input', 'client', 'the tenant name is not valid'),
  invalid_plan: spec('invalid_input', 'client', 'the tenant plan is not valid'),
  invalid_reason: spec('invalid_input', 'client', 'the reason is too long or not printable'),
  invalid_grant: spec('invalid_input', 'client', 'the operator grant request is not valid'),
  purge_not_due: spec('conflict', 'client', 'the tenant deletion is not due yet'),
  domain_claimed: spec('conflict', 'client', 'the tenant has already claimed the hostname'),
  invalid_page_request: spec('invalid_input', 'client', 'the page size or cursor is not valid'),
  transaction_conflict: spec(
    'conflict',
    'client',
    'the change conflicted with a concurrent change; retry it',
  ),
  transaction_aborted: spec(
    'misconfigured',
    'developer',
    'the tenancy transaction was aborted by an earlier failure',
  ),
  transaction_closed: spec('misconfigured', 'developer', 'the tenancy transaction has ended'),
  invalid_store_input: spec(
    'misconfigured',
    'developer',
    'the tenancy store was given a value it cannot store',
  ),
  invalid_store_options: spec(
    'misconfigured',
    'developer',
    'the tenancy store options are not valid',
  ),
  invalid_message_input: spec(
    'misconfigured',
    'developer',
    'the invitation message input is not valid',
  ),
  invalid_slug_policy: spec('misconfigured', 'developer', 'the slug policy options are not valid'),
  invalid_role_set: spec('misconfigured', 'developer', 'the tenant role definition is not valid'),
  invalid_root_domain: spec('misconfigured', 'developer', 'the tenancy root domain is not valid'),
  invalid_path_prefix: spec('misconfigured', 'developer', 'the tenant path prefix is not valid'),
  invalid_domain_policy: spec(
    'misconfigured',
    'developer',
    'the domain verification options are not valid',
  ),
  invalid_dns_options: spec('misconfigured', 'developer', 'the DNS resolver options are not valid'),
  invalid_actor: spec('misconfigured', 'developer', 'the tenancy actor is not valid'),
  invalid_lifecycle_options: spec(
    'misconfigured',
    'developer',
    'the tenancy lifecycle options are not valid',
  ),
  invalid_limits: spec('misconfigured', 'developer', 'the tenant limits are not valid'),
} satisfies Record<string, TenancyErrorSpec>);

/** A tenancy error code: a key of {@link TENANCY_ERROR_CODES}. */
export type TenancyErrorCode = keyof typeof TENANCY_ERROR_CODES;

/** A value-free tenancy failure carrying one code from {@link TENANCY_ERROR_CODES}. */
export class TenancyError extends JsailsError {
  readonly code: TenancyErrorCode;
  readonly kind: TenancyErrorKind;
  readonly audience: TenancyErrorAudience;
  /** Where a refused value is wrong; empty unless the code reports issues. */
  readonly issues: readonly TenancyErrorIssue[];

  constructor(code: TenancyErrorCode, options?: TenancyErrorOptions) {
    const entry = TENANCY_ERROR_CODES[code];
    super(entry.message, options);
    this.code = code;
    this.kind = entry.kind;
    this.audience = entry.audience;
    this.issues = Object.freeze([...(options?.issues ?? [])]);
  }
}
