# @jsails/tenancy

Opt-in shared-schema multi-tenancy for JSails: the framework-owned tenant and membership entities plus auth-agnostic tenant resolution exposed as `TenancyService` under `tenancyToken`. Once membership is confirmed, each request runs inside `runWithTenant` so models declared with `tenantScoped` (from `jsails/database`) see only the granted tenant's rows. Install it with `npm install @jsails/tenancy`; the guide is at <https://jsails.org/docs/tenancy>.

## Domain rules

The package also exports the pure rules a tenancy product is built on. They take plain values, touch no database or request, and refuse with value-free codes (`TenancyError.code`, from the `TENANCY_ERROR_CODES` table):

- **Naming**: `slugPolicy`, `checkSlug`, `suggestSlug` and `DEFAULT_RESERVED_SLUGS`; `normalizeHostname` (IDNA A-labels, no port, IP literals and ports outside 1-65535 refused); `matchTenantHost(host, { rootDomain })` returns `apex | subdomain | reserved | other | invalid`; `matchTenantPath(pathname, '/t')` returns `{ slug, rest }`.
- **Roles and status**: `defineTenantRoles` with ranks and a permission vocabulary, the reserved `owner` role, `canAssign` for the rank rule, `defaultTenantRoles`; `nextTenantStatus` over `active | suspended | pending_deletion | purging`, ending in `purged`.
- **Invitations**: `issueInvitationToken` (`jsinv_` plus 256 random bits; store only the SHA-256), `hashInvitationToken`, `normalizeEmail` (RFC 6531 local parts, combining marks included; invisible characters refused), and `invitationMessage` for the subject, text and escaped HTML of the invitation email, with every user-chosen name quoted and its link-like text defanged.
- **Custom domains**: tenant-bound claims (`issueDomainClaim`) with a `_jsails-challenge.<host>` TXT record (`domainChallenge`), `checkDomainChallenge` (rejects a malformed challenge, reports every DNS outcome) with an injectable `DnsTxtResolver` or `systemDnsResolver`, `admissibleDomain`, and the pure re-verification policy `nextDomainVerification`. These follow draft-ietf-dnsop-domain-verification-techniques.
- **Settings and limits**: `parseTenantSettings(schema, raw)` parses with a zod schema and applies its defaults. It is meant to run on every write and every read, and returns a deeply frozen plain JSON object of at most 64 KiB. Refused input throws `invalid_settings`, whose `issues` hold only `{ path, code }`. A schema whose output does not read back unchanged from JSON throws `invalid_settings_schema`. `tenantSettingsParser(schema)` binds a schema to a parser function. `checkLimit(limits, name, current, delta = 1)` returns `ok | limit_exceeded`; a limit that is unset or `Infinity` is unlimited.

The store port and the lifecycle service (create, invite, accept, transfer, suspend, purge, domain checks, operator grants, sweep) are built and tested in the package but are not exported yet. They become public once the framework wires them to a service token.
