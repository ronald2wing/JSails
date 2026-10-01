---
title: Tenancy
order: 35
section: Reference
---

# Tenancy

`@jsails/tenancy` is an **opt-in builtin plugin** for shared-schema multi-tenancy.
It is not enabled by the framework or the starter by default.

## Default state

When the plugin is not enabled:

- no tenant tables are created;
- no `tenant_id` columns are added;
- `db:push` and `db:diff` see no tenancy schema.

Enabling the plugin is the opt-in:

```js
// jsails.app.js
import { subdomainTenantResolver } from '@jsails/tenancy';

export default {
  plugins: {
    use: [
      ['@jsails/tenancy', {
        // acme.example.com -> Tenant { slug: 'acme' }
        resolveTenant: subdomainTenantResolver({ rootDomain: 'example.com' }),
      }],
    ],
  },
};
```

## Access enforcement

`resolveTenant` only says which tenant a request *names*. A subdomain, path
segment, or header is chosen by the client, so the plugin never hands that
tenant out on the resolver's word alone. By default `TenancyService.resolve`
returns the tenant only when:

- its `status` is in `activeStatuses` (default `['active']`), and
- the session's user has a `jsails_tenant_memberships` row in it.

Anything else is refused and `resolve` returns `null`, so tenant-scoped code
has no tenant id to query with. `resolveAccess(request, context)` returns the
full outcome so a page can answer `403` rather than `404`:

```ts
const access = await services.get(tenancyToken).resolveAccess(request, context);
// { status: 'none' }                                      global request
// { status: 'granted', tenant, membership }               membership.role is available
// { status: 'refused', reason: 'anonymous' | 'not_member' | 'inactive' }
```

The user id is read from `session.data.user.id` only (the auth plugin's
shape, the id every other gate reads); `sessionUserId` overrides it for
sessions that carry the id elsewhere. `findMembership`
replaces the default `TenantMembership` query. `requireMembership: false` skips
the membership check for tenants whose content is public (a tenant's marketing
site), where anonymous visitors must resolve too; the status check still
applies. Never resolve a tenant from a request header in an app that turns
membership off.

Both methods are memoized per `Request` and session user: every consumer in one
request shares a single resolver call and membership lookup, and a call made
with no session (or another session) never reuses a decision made for a
different one.

The plugin declares its schema statically. `db:push` discovers it from the
enabled plugin entry — no `tenancyEntities` array to add to `jsails.database.js`.

```sh
jsails db:push
```

creates:

- `jsails_tenants`
- `jsails_tenant_memberships`

If the plugin is not in `plugins.use`, those tables are never created.

## The default model

The plugin owns the default tenant model:

```text
jsails_tenants
  id
  slug        unique, varchar(190)
  name
  status      default 'active'
  metadata    nullable json
```

`metadata` is the extension point for app-specific tenant settings.

Membership is auth-agnostic:

```text
jsails_tenant_memberships
  id
  tenant_id   FK -> jsails_tenants.id, cascade on delete
  user_id     opaque actor id, varchar(190)
  role        default 'member'
```

There is deliberately **no foreign key to Better Auth's user table** and no
Better Auth import. `user_id` is an opaque actor identifier. Better Auth ids fit
the default string column, but a custom auth system can use the same table
without changing the plugin.

The unique constraint is `(tenant_id, user_id)`; a separate `user_id` index
serves "which tenants does this user belong to".

## Enabling tenancy later

The plugin is safe to add to an existing app. Enabling it and running
`jsails db:push` creates only the two tenancy tables. It does not add
`tenant_id` to application models, because no model has opted into tenancy yet.

A custom auth system does not need an adapter. It supplies the generic session
resolver and returns an actor id in the application's request context.

## Discovery

`db:push` and `db:diff` load the app config (`jsails.app.js` by default), resolve
the plugins in `plugins.use` without calling their `setup`, and collect their
static `schema.entities`. Use `--app-config <path>` when the app config is not at
the default path.

The plugin's runtime `setup` is responsible only for the tenancy service and the
request's ambient tenant. It never runs DDL.

## Tenant-scoped models

A model owned by a tenant opts into the query guard with `tenantScoped`,
naming the scalar property that holds the owning tenant's id:

```ts
// models/project.ts
import { ApplicationRecord, tenantScoped } from 'jsails/database';

@tenantScoped('tenantId')
export class Project extends ApplicationRecord {
  @jsails.index()
  declare tenantId: number;
  declare name: string;
}
```

`tenantScoped('tenantId')(Project)` is the same declaration without decorator
syntax. Declare it next to the model, before the data source initializes. The
column is an ordinary application column: index it (`@jsails.index()`), and
add the tenant to any unique constraint that must hold per tenant.

From then on every query TypeORM builds for the model is held to the
**current tenant**:

| Operation | With a current tenant | With no current tenant |
| --- | --- | --- |
| Reads: `find*`, `count`, `exists`, `query(Model)`, raw query builders (the main table, `addFrom` tables, and joins onto the model), relation loads, `whereHas` subqueries | filtered to the tenant | return nothing |
| `update`, `delete`, soft delete, restore, `save()` of a loaded row, `remove()` | filtered to the tenant; another tenant's row is never touched | refused (`no_tenant`) |
| `save()` of a new row, `insert()` | the tenant column is stamped | refused (`no_tenant`) |
| A write that sets the tenant column to another tenant | refused (`tenant_mismatch`) | refused |
| Upsert (`orUpdate`), `INSERT ... SELECT` | refused (`unsupported_write`) | refused |

The filter is added when the SQL is generated, so a later `.where()` on a raw
builder cannot drop it, an `OR` in the caller's predicate stays inside it, and
naming another tenant in the criteria (`findBy({ tenantId: 2 })`) matches
nothing. A write can never move a row to another tenant: setting the tenant
column (or the relation whose join column it is) to anything but the current
tenant throws a `TenantScopeError` before the statement runs. Upserts are
refused because their conflict branch could overwrite a row that belongs to
another tenant.

The tenant that applies is the one current when the query **runs**, not when
it was built. That holds for subqueries too: a `whereHas` subquery is rendered
when the outer query is built, so its filter reads parameters the outer query
binds from the ambient tenant each time it executes. A query built outside
`runWithTenant`, or under another tenant, or inside `withoutTenantScope`, is
held to the tenant current where it finally runs.

Raw SQL (`dataSource.query(...)`, `Repository.clear()`) never passes through a
query builder and is not scoped.

## The ambient tenant

The current tenant lives in an `AsyncLocalStorage`, so it follows every
`await` and every promise started inside it.

For HTTP requests the plugin sets it: a request scope
([`configureRequestScope`](/docs/extending#http-and-middleware-hooks))
resolves the request's access and, **only when access is granted** (status
and membership checks passed), runs the rest of the request inside
`runWithTenant(tenant.id, ...)`. The server applies the scope around every
route kind: pages, API routes, server-component actions, uploads, and
downloads, and plugin hook routes. It runs after the session is settled and
before CSRF, API `authorize` hooks, the app's global middleware, route
middleware, and the handler, so all of them see the tenant. A global request,
an anonymous visitor, a non-member, or an inactive tenant gets no tenant, so
scoped reads return nothing. The scope shares the per-request memo, so a page
that also calls `resolve` costs no second lookup. Pass `scopeRequests: false`
only when the app sets the tenant itself.

Jobs, commands, and tests set it explicitly:

```ts
import { runWithTenant } from 'jsails/database';

await runWithTenant(job.payload.tenantId, async () => {
  const projects = await Project.find();
  // ...
});
```

Every job attempt starts with no tenant: the first run, each retry, a delayed
run, the next job an in-process adapter starts after the previous one, and
batch callbacks. This holds even when the job was dispatched inside a request
or a handler that had a tenant, so a job never runs for a tenant by accident.
A job dispatched inside `withoutTenantScope` does not inherit the opt-out
either; a cross-tenant job calls `withoutTenantScope` in its handler.
Record the tenant id in a job's payload when you enqueue it and set it in the
handler, as above. Other background work started
from inside a request must not inherit that request's tenant either: wrap it
in `runWithoutTenant(fn)`, which runs `fn` with no tenant (reads return
nothing, writes are refused) until it calls `runWithTenant` itself.
`currentTenantId()` returns the current tenant, or `undefined` outside one.

The tenant store and the model registry are shared by every loaded copy of
`jsails`, so a plugin that resolves its own nested copy still sets the tenant
the guard reads.

## Opting out

Cross-tenant work (an operator report, a maintenance job) opts out explicitly,
so the bypass is visible at the call site:

```ts
import { query, withoutTenantScope } from 'jsails/database';

// Everything inside the callback reads and writes every tenant's rows.
const total = await withoutTenantScope(() => Project.count());

// One ModelQuery without the guard.
const all = await query(Project).withoutTenantScope().getMany();
```

Inside `withoutTenantScope`, inserts keep the tenant column they were given
and are not stamped. A `runWithTenant` nested inside it scopes again.

## Limits

- The guard does not add a `tenant_id` column to a model for you; the model
  declares it.
- Raw SQL is not scoped; use the query builder or keep the filter in the SQL.
- Middleware a plugin hook adds with `app.use`, requests no route claims,
  transports a plugin attaches to the HTTP server itself (the `@jsails/live`
  WebSocket, through `onServe`), and error and not-found pages, which may
  render after the route's scope has exited, run outside the request scope and
  have no tenant. Code there calls `tenancy.resolve(request, { session })` and
  wraps its work in `runWithTenant(tenant.id, ...)` itself.
- Declare `tenantScoped` before the first query that reads the model; a
  subquery rendered before any model was registered carries no filter.
- Cache keys are not tenant-aware; include the tenant id in keys for
  tenant-owned data.

## Tenancy domain rules

`@jsails/tenancy` also exports the pure rules a tenancy product is built on.
They take plain values, touch no database and no request, and refuse with
value-free codes, so the same rules hold in a route, a job, or a test.

### Slugs and hosts

```ts
import { checkSlug, matchTenantHost, matchTenantPath, slugPolicy, suggestSlug } from '@jsails/tenancy';

const slugs = slugPolicy({ reserved: ['pricing'] }); // extends the default reserved list

checkSlug('Acme', slugs); // { ok: true, slug: 'acme' }
checkSlug('www', slugs); // { ok: false, code: 'reserved_slug' }
suggestSlug('Crème Brûlée'); // 'creme-brulee'

matchTenantHost('acme.example.com:443', { rootDomain: 'example.com', policy: slugs });
// { kind: 'subdomain', slug: 'acme' }
matchTenantPath('/t/acme/projects', '/t', slugs); // { slug: 'acme', rest: '/projects' }
```

A slug is 3 to 63 lower-case ASCII letters, digits and single hyphens, starts
and ends with a letter or digit, is not all digits, and is not reserved. The
default reserved list (`DEFAULT_RESERVED_SLUGS`) covers hosts an app and its
mail and DNS setup need (`www`, `api`, `app`, `admin`, `mail`, `autoconfig`,
`mta-sts`, ...). Pass `extendDefaults: false` to replace it rather than extend
it.

`normalizeHostname` is the canonical form for every host comparison: lower
case, IDNA A-labels, no port and no trailing dot. It returns `null` for IP
literals, percent-encoding, user info, paths, underscores, wildcards, a port
outside 1-65535, and labels or names over the RFC 1035 limits.

`matchTenantHost` takes the host string, not a `Request`, and returns one of:

| `kind`      | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `apex`      | The root domain itself. It is global.                                      |
| `subdomain` | One label below the root that is a valid, unreserved slug.                 |
| `reserved`  | Below the root but never a tenant: a reserved or invalid label, or nested. |
| `other`     | Outside the root. Only a verified custom domain can name a tenant here.    |
| `invalid`   | Not a host name.                                                           |

In development, `rootDomain: 'localhost'` serves tenants on
`acme.localhost` (RFC 6761).

### Roles and status

```ts
import { defaultTenantRoles, defineTenantRoles, nextTenantStatus } from '@jsails/tenancy';

const roles = defineTenantRoles({
  roles: {
    editor: { rank: 20, permissions: ['tenant.view', 'posts.publish'] },
    reader: { rank: 10, permissions: ['tenant.view'] },
  },
  defaultRole: 'reader',
  permissions: ['posts.publish'],
});

roles.allows('editor', 'posts.publish'); // true
roles.canAssign('editor', null, 'reader'); // true: below the actor's rank
roles.canAssign('editor', null, 'editor'); // false
```

- `owner` is reserved. It is a valid stored membership role, ranks above every
  defined role and holds every permission. An app cannot define it, and
  `canAssign` never grants it: ownership moves only through a transfer.
- `tenant.transfer` belongs to the owner alone. In `defaultTenantRoles`
  (`admin`, `member`, `viewer`), `tenant.delete` and `plan.manage` are also
  owner-only.
- `canAssign(actor, from, to)` allows a change only when both the current and
  the new role rank strictly below the actor's role.

`nextTenantStatus(from, transition)` is the one status table:

| From                  | Transition          | To                                 |
| --------------------- | ------------------- | ---------------------------------- |
| `active`              | `suspend`           | `suspended`                        |
| `suspended`           | `resume`            | `active`                           |
| `active`, `suspended` | `schedule_deletion` | `pending_deletion`                 |
| `pending_deletion`    | `cancel_deletion`   | `active`, or `suspended` if it was |
| `pending_deletion`    | `begin_purge`       | `purging`                          |
| `purging`             | `finish_purge`      | `purged` (the row is gone)         |

Every other pair returns `null`. Nothing leaves `purging` except the end of
the purge, so a crash part-way through leaves a status the sweep resumes from.
Only `active` tenants are accessible.

### Invitations

```ts
import { hashInvitationToken, invitationMessage, issueInvitationToken, normalizeEmail } from '@jsails/tenancy';

const { token, hash } = issueInvitationToken(); // store only `hash`
hashInvitationToken(tokenFromLink); // Uint8Array, or null for a malformed token
normalizeEmail(' Ada@Bücher.de '); // 'ada@xn--bcher-kva.de'

const message = invitationMessage({
  tenantName: tenant.name,
  inviterName: inviter.name,
  roleLabel: 'Admin',
  acceptUrl: `https://acme.example.com/invitations/accept?token=${token}`,
  expiresAt,
}); // { subject, text, html }
```

A token is `jsinv_` and 256 random bits in base64url. Only its SHA-256 is
stored. `normalizeEmail` keeps dots and `+tags`, because removing them would
merge mailboxes some providers keep apart. It accepts internationalised local
parts (RFC 6531), combining marks included, so addresses in Devanagari, Thai
or Arabic work; it refuses invisible characters (zero-width and bidi
controls), separators and private-use characters.

`invitationMessage` treats the tenant name, inviter name and role label as
hostile. It removes line breaks, control characters and bidi overrides, cuts
each name to 80 characters, and sets every name in quotation marks in the
subject and both bodies, so a name such as `Your bank. Click below` reads as a
name, not as the message. It also defangs link-like text in names, so a mail
client does not turn `https://evil.example` into a link from your sender: a
dot before a letter or digit becomes `․` (U+2024), `/` becomes `∕` (U+2215)
and `@` becomes `＠` (U+FF20). The accept URL is the only link. Everything it
puts into HTML is escaped, and the accept URL must be an absolute `https:` or
`http:` URL.

### Custom domains

A tenant proves control of a hostname with a DNS TXT record, following
[draft-ietf-dnsop-domain-verification-techniques](https://datatracker.ietf.org/doc/draft-ietf-dnsop-domain-verification-techniques/):

```ts
import {
  checkDomainChallenge,
  domainChallenge,
  issueDomainClaim,
  nextDomainVerification,
  systemDnsResolver,
} from '@jsails/tenancy';

const claim = issueDomainClaim(
  { tenantId: 42, hostname: 'shop.acme.com', now: new Date() },
  { rootDomain: 'example.com', appHosts: ['example.com', 'www.example.com'] },
);
domainChallenge(claim);
// { recordType: 'TXT', recordName: '_jsails-challenge.shop.acme.com', recordValue: 'token=…' }

const resolver = systemDnsResolver({ servers: ['1.1.1.1'], timeoutMs: 3000 });
const result = await checkDomainChallenge(domainChallenge(claim), resolver, AbortSignal.timeout(5000));
// 'verified' | 'absent' | 'mismatch' | 'dns_error' | 'timeout'
```

- A claim binds one hostname to one tenant with its own token, which is 160
  random bits in lower-case base32. A pending claim lapses after 7 days. Two
  tenants claiming the same host get different tokens, so a record proves
  control only for the tenant that published it.
- `admissibleDomain` refuses single-label names, special-use names
  (`localhost`, `.test`, `.example`, `.local`, `.internal`, ...), the root
  domain and the app's own hosts, and also their subdomains and parents.
- `checkDomainChallenge` joins the strings of each TXT record and reads the
  `token=` value. It passes when any record matches. It first checks that the
  challenge is one `domainChallenge` builds, and rejects a malformed or forged
  one (`invalid_domain_token`, `invalid_hostname`) before any lookup, so an
  empty token can never match an empty record. Past that check it never
  throws: DNS failures are reported as results.
- `systemDnsResolver` opens a fresh resolver for every lookup, so the process
  never answers a check from cache. Point `servers` at a resolver with a low
  negative-caching TTL so a newly published record shows up quickly.
- Verification is persistent and is checked again periodically, so keep the
  record for as long as the domain is in use. `nextDomainVerification` is the
  pure failure policy. Every result other than `verified` counts as a failure.
  A verified domain stops routing only after 3 failures in a row that span at
  least 24 hours. It then becomes a pending claim again, and publishing the
  record recovers it for the same tenant.

### Settings and limits

```ts
import { z } from 'zod';
import { checkLimit, parseTenantSettings, tenantSettingsParser } from '@jsails/tenancy';

const settingsSchema = z.object({
  theme: z.enum(['light', 'dark']).default('light'),
  locale: z.string().max(16).default('en'),
});

parseTenantSettings(settingsSchema, {}); // { theme: 'light', locale: 'en' }, deeply frozen
const parseSettings = tenantSettingsParser(settingsSchema); // (raw) => settings

const limits = { seats: 10, projects: 3 }; // from the tenant's plan
checkLimit(limits, 'seats', memberCount); // 'ok' while memberCount + 1 <= 10
checkLimit(limits, 'projects', projectCount, 0); // is the tenant within the limit now?
```

- Parse settings on every write and on every read. Defaults that you add to
  the schema later then also apply to rows stored before the change.
- The result must be a plain JSON object of at most 64 KiB in UTF-8
  (`MAX_TENANT_SETTINGS_BYTES`). Refused input throws `invalid_settings`.
  `error.issues` lists up to 32 `{ path, code }` pairs, such as
  `{ path: ['theme'], code: 'invalid_value' }`. An issue never includes the
  value or zod's message, because a custom message can quote the input. A path
  key that is long or not printable is shown as `*`.
- The function checks that the stored JSON reads back as the same value. If
  the schema's output does not survive storage, it throws
  `invalid_settings_schema` (a developer error). Examples are a
  `z.coerce.date()`, a transform that changes its own output, and an async
  refinement. Zod classic and zod mini schemas both work.
- `checkLimit(limits, name, current, delta = 1)` returns `'limit_exceeded'`
  when `current + delta` is over the limit. A name that is absent or set to
  `Infinity` means unlimited. A delta of 0 asks whether the tenant is within
  the limit now, which is how you detect a tenant left over its limit after a
  downgrade. A count or limit that is not a non-negative integer throws
  `invalid_limits`.

### Errors

Every refusal is a `TenancyError` that carries a stable `code` from
`TENANCY_ERROR_CODES`. Each entry gives the code's `kind` (`invalid_input`,
`conflict`, `not_found`, `forbidden`, `expired`, `limit` or `misconfigured`)
and its `audience`. `client` codes are refusals you can show to the person who
made the request. `developer` codes report a configuration mistake. Messages
are fixed and never repeat a slug, hostname, email, token or settings value.
Match on `error.code`, not on the class.

## Next steps

- [Plugins](/docs/plugins) — static plugin schema discovery.
- [Database](/docs/database) — the model-driven schema engine.
- [Auth](/docs/auth) — the optional Better Auth plugin.
