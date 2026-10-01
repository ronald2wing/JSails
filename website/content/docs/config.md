---
title: Config Management
order: 40
section: Reference
---

# Config Management

`@jsails/config` gives an app settings that are edited in the admin, exported
to files you commit, imported on deploy, and optionally forced from code. It is
the same workflow as Drupal's configuration management: the database holds the
**active** config, `config:export` writes it to a sync directory, and
`config:import` applies that directory on another environment.

Keep secrets out of config. Sync files are committed, so passwords and API keys
belong in [encrypted credentials](/docs/configuration), and per-user or
per-tenant toggles that change while the app runs belong in
[feature flags](/docs/flags).

## Declaring a config set

A set is a named group of fields. Its name is also its sync file name, so it is
lowercase words joined by `.`, `_`, or `-`.

```js
import { object, string } from 'jsails/api';
import { boolean, choice, defineConfig, integer, json, text } from '@jsails/config';

export const shopConfig = defineConfig('shop', {
  label: 'Shop',
  fields: {
    name: text({ label: 'Shop name', default: 'My shop', required: true, max: 80 }),
    perPage: integer({ default: 24, min: 1, max: 100 }),
    reviews: boolean({ default: true }),
    currency: choice({ options: ['USD', 'EUR', 'GBP'], default: 'USD' }),
    banner: json({ default: { text: '' }, schema: object({ text: string() }) }),
  },
});
```

| Field     | Value                | Form control       |
| --------- | -------------------- | ------------------ |
| `text`    | string; `required`, `max`, `multiline` | text input or textarea |
| `integer` | whole number; `min`, `max` | number input   |
| `boolean` | `true`/`false`       | checkbox           |
| `choice`  | one of `options`     | select             |
| `json`    | any JSON value; `schema` or `validate` | JSON textarea |

Every default must pass its own field's check, and a bad declaration fails when
the module loads.

## Registering and reading

```js
// jsails.app.js
import { defineAdminPanel } from '@jsails/admin';
import { adminOnly } from '@jsails/auth';
import { blogSiteConfig } from '@jsails/blog';
import { cachePlugin } from '@jsails/cache';
import { choice, configPlugin, configStoreToken, defineConfig } from '@jsails/config';
import { configAdmin } from '@jsails/config/admin';
import { configEntities, createDatabaseConfigStore } from '@jsails/config/database';
import { JsailsDataSource, readDatabaseEnvironment } from 'jsails';
import { definePlugin } from 'jsails/kernel';

// The shop set from above, usually imported from its own module.
const shopConfig = defineConfig('shop', {
  fields: { currency: choice({ options: ['USD', 'EUR', 'GBP'], default: 'USD' }) },
});

const dataSource = new JsailsDataSource({
  ...readDatabaseEnvironment(),
  entities: [...configEntities],
});

// The store is a service another plugin provides; this one is the app's own.
// The store connects on its first read, and closes the source when the app
// closes, since it initialized it.
const configStore = definePlugin({
  name: 'config-store',
  provides: [configStoreToken],
  setup: ({ services }) => {
    const store = createDatabaseConfigStore({ getDataSource: () => dataSource });
    services.provide(configStoreToken, store);
    return () => store.close?.();
  },
});

const admin = defineAdminPanel({
  authorize: adminOnly,
  adminPlugins: [configAdmin()],
});

export default {
  plugins: {
    use: [
      cachePlugin(),
      configStore(),
      configPlugin({
        sets: [shopConfig, blogSiteConfig],
        store: configStoreToken,
        overrides: { shop: { currency: process.env.SHOP_CURRENCY ?? 'USD' } },
      }),
      ['@jsails/admin', admin],
    ],
  },
};
```

The options are checked when `configPlugin(...)` is called
(`config.invalid_options`, value-free): every set must come from
`defineConfig`, a set name may appear once, and every override must name a
declared key with a valid value. Read values through the `configToken`
service, from a plugin's setup, a request's services, or a command that needs
`{ services: [] }`:

```ts
// commands/shop/show.ts: `jsails shop:show`
import { configToken, defineConfig, integer, text } from '@jsails/config';
import { defineCommand } from 'jsails';

// The shop set, usually imported from its own module.
const shopConfig = defineConfig('shop', {
  fields: { perPage: integer({ default: 24 }), currency: text({ default: 'USD' }) },
});

export default defineCommand({
  summary: 'Print the shop settings',
  needs: { services: [] },
  async run(context) {
    const config = context.services.registry.get(configToken);
    const { perPage, currency } = await config.get(shopConfig);
    context.stdout(`${perPage} per page, in ${currency}`);
  },
});
```

- **Stores.** `createDatabaseConfigStore` (from `@jsails/config/database`,
  a separate subpath so the plugin's own entry loads no TypeORM) keeps one row
  per set in the
  `jsails_config` table, which the plugin declares, so `db:push` creates it
  from `plugins.use`. Add `configEntities` to the entities of the data source
  the store uses. Without a `store`, values live in memory.
- **Resolution.** A value is its default, then the stored value, then the
  override. A stored value that no longer passes its field's check (after you
  tighten a field) falls back to the default instead of breaking the app.
- **Writes.** `config.set(set, values)` checks every key and refuses an
  unknown, invalid, or overridden one. Saves of one set are serialized within
  the process, so two admins saving different keys keep both changes.
- **Read cache.** Resolved values are read through a [defined
  cache](/docs/services#defined-caches) (`CONFIG_CACHE`: in-process, one entry
  per set, tagged `config:<set>`), so a set read in a layout or middleware
  costs no store read once warm. The plugin binds it in `setup`, so it
  requires the `@jsails/cache` services; the `jsails-config` manifest
  declares that plugin as a dependency. `set` and `replace` (the admin page,
  and `config:import`) invalidate the sets they wrote after the store write,
  in every process of the app: at once over the Valkey tag bus, within the
  tag table's `syncMs` (5 s) otherwise. A write that bypasses the service is
  seen once the entry's 60 s TTL lapses. Each call returns a copy, so mutating
  a result never changes the cache. `createConfig` without a `cache` reads
  through on every call.

## Overrides

`overrides` forces values from code, like Drupal's `settings.php`. An override
wins at runtime whatever is stored or imported, is checked against its field
when the app loads, and shows in the admin as a disabled field marked **Set in
code**. Use it for values that differ per environment, typically read from an
environment variable.

## The admin page

`configAdmin()` from `@jsails/config/admin` adds a **Configuration**
page with one form per set, built from the field declarations, over the
`configToken` service; a panel without the `config` plugin fails at boot
(`extension.missing_service`). A save checks
every submitted field and refuses the whole form on one invalid value.
Overridden fields are never submitted.

Admin pages are default-deny: without an `authorize` the page answers 403 to
everyone, admins included. Pass `authorize`, a page gate checked after the
panel's own (`({ session }) => adminOnly(session)` above), or wrap the plugin
with `withAdminAuthorize(configAdmin(), gate)` from `@jsails/admin`.
Like every `authorize`, it allows only on an exact `true`.

## Export and import

```sh
npx jsails config:export              # write config/sync/<set>.json
npx jsails config:import --dry-run    # list the sets and keys that would change
npx jsails config:import              # apply them, all or nothing
```

Each set is one file:

```json
{
  "format": "jsails.config",
  "version": 1,
  "set": "shop",
  "values": { "currency": "USD", "name": "My shop", "perPage": 24 }
}
```

- Keys are sorted at every depth, so an export of unchanged config rewrites
  nothing and a diff shows only real changes.
- Export writes active values, never overrides, because overrides already live
  in code.
- Import checks every file first. An unknown set, an unknown key, an invalid
  value, or a malformed file refuses the whole import before anything is
  written; the store then applies every change in one transaction.
- A declared set with no file is left unchanged. A file that names no declared
  set is reported by export as stale, never deleted.
- The commands come from this package's `jsails.commands`, so a project that
  installs `@jsails/config` has them. They run over the app's services (the
  plugin set up, with its store), so the sets, store and overrides are the
  app's.
- The sync directory defaults to `config/sync` under the app root; change it
  with `configPlugin({ syncDir })`, or `--dir` against the working directory.
- Output and errors name sets and keys, never values.

A typical deploy runs `db:push`, then `config:import`.

Both commands are ordinary `defineCommand` values, exported from
`@jsails/config/commands/export` and `/import`, so a test can run one with
`runCommand` (see [Testing a command](/docs/testing#testing-a-command)):

```ts
import exportCommand from '@jsails/config/commands/export';
import importCommand from '@jsails/config/commands/import';

console.log(exportCommand.summary); // the line `jsails --help` shows for it
console.log(Object.keys(importCommand.options)); // [ 'dir', 'dry-run' ]
```

Managed plugin state has its own snapshot, `jsails plugins export` and
`jsails plugins import` ([Plugins](/docs/plugins)), because importing it also
checks for plugin bundles on disk.
