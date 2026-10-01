/**
 * Opt-in tenancy plugin (`@jsails/tenancy`) and its framework-owned entities.
 *
 * Enable it explicitly:
 *
 * ```js
 * plugins: {
 *   use: [['@jsails/tenancy', { resolveTenant }]],
 * }
 * ```
 *
 * The schema command discovers {@link tenancyEntities} from the enabled plugin;
 * disabling the plugin leaves the application schema untouched.
 *
 * The barrel also exports the pure tenancy domain: naming (slugs, hostnames,
 * host and path matching), roles and the tenant status machine, invitation
 * tokens, email addresses and messages, custom-domain verification, typed
 * settings and limits, and the error code table. None of it touches a
 * database or a request. The store port and the lifecycle service stay
 * internal until the framework wires them to a service token.
 */

export { Tenant, TenantMembership, tenancyEntities } from './entities.js';
export {
  defaultSessionUserId,
  subdomainTenantResolver,
  tenancyPlugin,
  tenancyToken,
  type MembershipLookup,
  type SubdomainTenantResolverOptions,
  type TenancyPluginOptions,
  type TenancyService,
  type TenantAccess,
  type TenantRefusal,
  type TenantResolveContext,
  type TenantResolver,
  type TenantSource,
} from './plugin.js';

export {
  isHostnameWithin,
  MAX_HOSTNAME_LENGTH,
  MAX_LABEL_LENGTH,
  normalizeHostname,
} from './hostname.js';
export {
  checkSlug,
  DEFAULT_RESERVED_SLUGS,
  DEFAULT_SLUG_POLICY,
  slugPolicy,
  suggestSlug,
  type SlugCheck,
  type SlugPolicy,
  type SlugPolicyOptions,
} from './slug-policy.js';
export {
  matchTenantHost,
  normalizeRootDomain,
  type HostMatch,
  type TenantHostOptions,
} from './tenant-host.js';
export { assertTenantPathPrefix, matchTenantPath, type TenantPathMatch } from './tenant-path.js';
export { isTenantId, type TenantId } from './tenant-id.js';
export {
  defaultTenantRoles,
  defineTenantRoles,
  OWNER_ONLY_PERMISSIONS,
  OWNER_ROLE,
  TENANCY_PERMISSIONS,
  type TenancyPermission,
  type TenantRoleSet,
  type TenantRoleSpec,
  type TenantRolesDefinition,
} from './tenant-roles.js';
export {
  isTenantAccessible,
  nextTenantStatus,
  parseTenantStatus,
  TENANT_STATUSES,
  TENANT_TRANSITIONS,
  type TenantStatus,
  type TenantTransition,
  type TenantTransitionContext,
} from './tenant-status.js';
export {
  hashInvitationToken,
  INVITATION_TOKEN_BYTES,
  INVITATION_TOKEN_PREFIX,
  issueInvitationToken,
  sameInvitationTokenHash,
  type IssuedInvitationToken,
} from './invitation-token.js';
export { MAX_EMAIL_LENGTH, normalizeEmail } from './email-address.js';
export {
  invitationMessage,
  MAX_DISPLAY_NAME_LENGTH,
  type InvitationMessage,
  type InvitationMessageInput,
} from './invitation-message.js';
export {
  systemDnsResolver,
  type DnsTxtResolver,
  type SystemDnsResolverOptions,
} from './dns-resolver.js';
export {
  admissibleDomain,
  challengeTokenOf,
  checkDomainChallenge,
  DOMAIN_CHALLENGE_LABEL,
  domainChallenge,
  isDomainToken,
  issueDomainClaim,
  type DomainAdmission,
  type DomainAdmissionOptions,
  type DomainChallenge,
  type DomainCheckStatus,
  type DomainClaimDraft,
  type DomainClaimInput,
} from './domain-verification.js';
export {
  DEFAULT_DOMAIN_VERIFICATION_POLICY,
  domainVerificationPolicy,
  nextDomainVerification,
  pendingDomainVerification,
  type DomainVerificationAction,
  type DomainVerificationOutcome,
  type DomainVerificationPolicy,
  type DomainVerificationState,
} from './domain-verification-policy.js';
export { checkLimit, type LimitCheck, type TenantLimits } from './tenant-limits.js';
export {
  MAX_SETTINGS_ISSUES,
  MAX_TENANT_SETTINGS_BYTES,
  parseTenantSettings,
  tenantSettingsParser,
  type TenantSettingsSchema,
} from './tenant-settings.js';
export {
  TENANCY_ERROR_CODES,
  TenancyError,
  type TenancyErrorAudience,
  type TenancyErrorCode,
  type TenancyErrorIssue,
  type TenancyErrorKind,
  type TenancyErrorOptions,
  type TenancyErrorSpec,
} from './tenancy-error.js';

// The declarative loader calls `mod.default(options)`, so the plugin subpath
// barrel default-exports its factory alongside the named export.
export { tenancyPlugin as default } from './plugin.js';
