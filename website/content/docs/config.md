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
import { blogSiteConfig } from '@jsails/blog';
import { configPlugin, createDatabaseConfigStore } from '@jsails/config';
import { configAdmin } from '@jsails/config/admin';

const config = configPlugin({
  sets: [shopConfig, blogSiteConfig],
  store: createDatabaseConfigStore({ getDataSource }),
  overrides: {
    shop: { currency: process.env.SHOP_CURRENCY ?? 'USD' },
  },
});

const admin = defineAdminPanel({
  // ...auth and authorize...
  adminPlugins: [configAdmin({ config: config.config })],
});

export default {
  // The plugin goes in `extensions`, so the CLI sees its commands and the admin
  // page shares its service.
  extensions: [config],
  plugins: { use: [['@jsails/admin', admin]] },
};
```

Read values through the service, from `configPlugin(...).config` or the
`configToken` service:

```js
const { perPage, currency } = await config.config.get(shopConfig);
```

- **Stores.** `createDatabaseConfigStore` keeps one row per set in the
  `jsails_config` table. Add `configEntities` to the entities of the data
  source it uses and of `jsails.database.js`, so `db:push` creates the table.
  Without a `store`, values live in memory.
- **Resolution.** A value is its default, then the stored value, then the
  override. A stored value that no longer passes its field's check (after you
  tighten a field) falls back to the default instead of breaking the app.
- **Writes.** `config.set(set, values)` checks every key and refuses an
  unknown, invalid, or overridden one. Saves of one set are serialized within
  the process, so two admins saving different keys keep both changes.
- **Read cache.** Resolved values are cached per set for `cacheTtlMs`
  (default 5 000 ms), so a set read in a layout or middleware costs one store
  read per TTL rather than one per call. `set` and `replace` (the admin page
  and `config:import` in the same process) invalidate it at once. A write from
  another process (a second app instance, a `config:import` run from a shell)
  is visible once the TTL lapses, so the TTL is the longest a multi-instance
  deployment can serve a stale value. Pass `cacheTtlMs: 0` to
  `configPlugin`/`createConfig` to read through on every call. Each call
  returns a copy, so mutating a result never changes the cache.

## Overrides

`overrides` forces values from code, like Drupal's `settings.php`. An override
wins at runtime whatever is stored or imported, is checked against its field
when the app loads, and shows in the admin as a disabled field marked **Set in
code**. Use it for values that differ per environment, typically read from an
environment variable.

## The admin page

`configAdmin({ config })` from `@jsails/config/admin` adds a **Configuration**
page with one form per set, built from the field declarations. A save checks
every submitted field and refuses the whole form on one invalid value.
Overridden fields are never submitted.

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
- The sync directory defaults to `config/sync` beside `jsails.app.js`; change it
  with `configPlugin({ syncDir })` or `--dir`.
- Output and errors name sets and keys, never values.

A typical deploy runs `db:push`, then `config:import`.

Managed plugin state has its own snapshot, `jsails plugins export` and
`jsails plugins import` ([Plugins](/docs/plugins)), because importing it also
checks for plugin bundles on disk.
