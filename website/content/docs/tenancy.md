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

The user id is read from `session.data.userId`, then `session.data.user.id`
(the auth plugin's shape); `sessionUserId` overrides it. `findMembership`
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

The plugin's runtime `setup` remains responsible only for services and request
context. It never runs DDL.

## Honest limits

This slice owns the tenant/membership schema and membership-checked tenant
resolution. It does **not** yet add automatic `tenant_id` columns to
application models, automatic query filtering, tenant write guards, or tenant
propagation into jobs and cache keys. Those belong to the tenant-aware model
layer and are opt-in per model; until then every tenant-scoped query must filter
by the granted tenant's id itself.

For now, an application can use the tenant tables directly through their
repositories; model-level tenant scoping will be added without changing the
plugin's schema contract.

## Next steps

- [Plugins](/docs/plugins) — static plugin schema discovery.
- [Database](/docs/database) — the model-driven schema engine.
- [Auth](/docs/auth) — the optional Better Auth plugin.
