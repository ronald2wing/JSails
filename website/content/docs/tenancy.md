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
import { tenancyPlugin } from '@jsails/tenancy';
import { Tenant } from '@jsails/tenancy';

export default {
  plugins: {
    use: [
      ['@jsails/tenancy', {
        resolveTenant: async (request) => {
          const slug = new URL(request.url).host.split('.')[0];
          return Tenant.findOneBy({ slug });
        },
      }],
    ],
  },
};
```

The plugin declares its schema statically. `db:push` discovers it from the
enabled plugin entry — no `tenancyEntities` array to add to `jsails.config.js`.

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

The unique constraint is `(tenant_id, user_id)`.

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

This slice owns the tenant/membership schema and tenant resolution service. It
does **not** yet add automatic `tenant_id` columns to application models,
automatic query filtering, or tenant write guards. Those belong to the
tenant-aware model layer and are opt-in per model.

For now, an application can use the tenant tables directly through their
repositories; model-level tenant scoping will be added without changing the
plugin's schema contract.

## Next steps

- [Plugins](/docs/plugins) — static plugin schema discovery.
- [Database](/docs/database) — the model-driven schema engine.
- [Auth](/docs/auth) — the optional Better Auth plugin.
