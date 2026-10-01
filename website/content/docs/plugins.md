---
title: Plugins
order: 15
section: Extending
---

# Plugins

A plugin is a packageable extension that can be discovered, installed, and enabled.

A **plugin** is a packageable extension: `JsailsPlugin` extends `JsailsExtension`
with declarative passthroughs (`deployments`, `renderer`) carried by identity for
the config loader, and a `PluginContext` whose `setup` can additionally register
interceptors and observers. `priority`, `disabled`, `requires`, `provides`, and
`commands` are inherited, so a plugin participates in the same contract-ordered
setup phase as every extension. `definePlugin(plugin)` is an identity helper that
keeps the `setup` context typed as `PluginContext` even when the literal is
nested inside a `JsailsExtension[]`.

A plugin may carry an optional `describe?: () => PluginDescription` — a pure,
side-effect-free declarative descriptor readable **without** running `setup`. It
never invokes callbacks, signs snapshots, or performs I/O. `PluginDescription`
currently carries `components` and `commands`; both `jsails describe` and the
introspect `components` section read component metadata through it without
materializing a runtime.

## Declaring plugins

`plugins.use` in `jsails.app.js` lists plugins to load, each a specifier or a
`[specifier, options]` tuple. The loader imports the module's default export and
calls it with the options; a module whose default export is already a
`JsailsPlugin` object is accepted as-is. Every plugin a specifier names
automatically runs — developer plugins are never gated by `enabled`.

```js
import { createDiskFromEnv } from '@jsails/filesystem';

const files = createDiskFromEnv();

export default {
  plugins: {
    use: [
      '@jsails/plugin-tools',
      ['@jsails/auth', { publicOrigin }],
      ['@jsails/filesystem', { disks: { [files.name]: files.disk }, default: files.name }],
    ],
    enabled: ['plugin-tools', 'auth', 'filesystem'],
    managed: true,
    // Required for runtime managed activation. Without it, managed state is
    // simply not read at boot (static export always skips it).
    stateSource: pluginState,
  },
};
```

## Two-source enablement

A plugin id is enabled by either of two independent sources, merged
deterministically by `resolvePluginEnablement({ codeEnabled, state })`:

- **Code list.** `plugins.enabled` names the npm plugins enabled out of the box.
  Installing an npm plugin that self-identifies through its `package.json`
  `jsails` field is activating it, so the code list is the source of truth for
  dependency plugins.
- **Managed state.** A `PluginStateSource` — either the `<pluginsDir>/state.json`
  `PluginStateStore` document (`{ version, plugins: { [id]: { active, enabled } } }`,
  written by the admin) or the database-backed store — records what the admin
  installed and toggled. Every id whose `enabled` is `true` is enabled.

`plugins.enabled` is a marketplace/managed-only gate: it controls admin-installed
plugins, never app-declared `config.extensions` (or `plugins.use` entries), which
always run in full at boot time.

A code-imported plugin is declared as a module descriptor when it needs state
or dependency metadata:

```js
plugins: {
  use: [
    {
      specifier: '@jsails/cache',
      id: 'cache',
      options: {},
    },
    {
      specifier: '@jsails/auth',
      id: 'auth',
      options: { publicOrigin },
      enabled: process.env.DISABLE_AUTH !== '1',
      requires: ['cache'],
    },
  ],
}
```

`enabled` defaults to `true` (the Magento `app/etc/config.php` model). A
disabled descriptor is skipped before import. When enabled modules declare
`requires`/`conflicts`, the loader validates the module graph before importing
anything: a required module must be present and enabled, and two conflicting
modules cannot both be enabled. `plugins.force: true` bypasses that validation
for an emergency deploy. Manually constructed `config.extensions` entries still
support the base `disabled: true` extension flag.

A plugin installed as an npm dependency and imported through `plugins.use` is
enabled by that import. It does not need an entry in `plugins.enabled`, and an
empty `plugins.enabled` list does not disable it. `plugins.enabled` only tells
the managed/marketplace surface which installed plugin ids it may expose.

`loadPluginEnablement({ codeEnabled, managed, stateSource })` is the
managed/non-managed switch: a **non-managed** deployment (`managed !== true`)
performs no state I/O and resolves code-only enablement, while a **managed** one
requires a state source, loads it, then merges it with the code list. The static
export is always non-managed.

The result is frozen and deterministic: `enabled` is the sorted union of the code
list and every state id with `enabled === true`; `conflicts` lists ids present in
**both** sources, which are **excluded** from `enabled` and must be reported by
the caller (fail closed — a conflict is a configuration error, never silently
resolved). `disabledManaged` lists state ids turned off that are not
code-enabled; those ids — and any id that is not installed — are skipped, not
enabled.

## The manifest

A plugin package or bundle declares a `manifest.json` so the framework can
discover, check, and activate it without importing any plugin code. The manifest
is validated with Zod and then checked for semver soundness; `parsePluginManifest`
throws a value-free `PluginManifestError` whose messages never echo input. The
schema is strict — unknown fields are rejected rather than ignored.

```json
{
  "id": "acme-blog",
  "version": "1.2.0",
  "jsailsCompat": ">=0.1.0 <1.0.0",
  "permissions": ["blog.read", "blog.write"],
  "plugins": [{ "id": "acme-core", "range": "^1.0.0" }],
  "settingsSchema": { "apiKey": "string" },
  "entry": "./dist/plugin.js",
  "checksums": { "acme-blog-1.2.0.tgz": "sha256-..." },
  "signature": "..."
}
```

`id` must match `PLUGIN_ID_PATTERN` (a lowercase/digit start followed by
lowercase letters, digits, `.`, `_`, or `-`); `version` and `jsailsCompat` must
be valid semver; `permissions` and `plugins` default to `[]`; `settingsSchema`,
`checksums`, and `signature` are optional. `entry` is a bare module specifier
(imported directly) or a relative path (resolved against the package directory).

### First-party plugins

Every first-party plugin package under `plugins/*` ships two inert files:

- `jsails.plugin.json` — the declaration (`id`, `provides`, optional `autoload`,
  `symbols`, and `plugins`). `provides` lists the package's public subpaths and
  must match its `package.json` `exports` (minus `./package.json`).
- a `jsails` field in `package.json` — the full manifest (`id`, `version`,
  `jsailsCompat`, `permissions`, `entry`). This is what dependency discovery
  reads, so `jsails plugins list` sees the package without importing it.

The declaration id uses the package-name convention (`@jsails/auth` →
`jsails-auth`), and `jsailsCompat` tracks the framework's supported range.
Library packages under `plugins/*` that export no plugin factory carry neither
file.

### Plugin-owned schema

A plugin may declare static schema entities:

```ts
import { definePlugin } from 'jsails/extensions';
import { Tenant } from './tenant.js';

export const tenancyPlugin = definePlugin({
  name: 'tenancy',
  schema: { entities: [Tenant] },
  setup() {},
});
```

`jsails db:push` and `jsails db:diff` load the app config, resolve the plugins in
`plugins.use`, and collect `schema.entities` **without calling `setup`**. The
plugin therefore owns its tables without forcing the app to list entities
manually, while the schema command remains deterministic and does not run plugin
runtime code.

Plugin schemas are opt-in by plugin enablement: a plugin that is not in
`plugins.use` contributes no tables. `--app-config <path>` overrides the app
config used for discovery.

## Discovery, installer, and activation

The plugin system lives in `src/plugins/` (exported as `jsails/plugins`): the
manifest contract, two-source discovery, the framework-version check, the `.tgz`
extractor, the persisted state store, the enablement merge, download-capability
resolution, the installer, and activation.

- **Discovery** (`discoverPlugins`) walks the two origins without importing any
  plugin code: the direct npm `dependencies` of the app package (each dependency
  that self-identifies through its own `package.json` `jsails` field) and the
  storage-backed plugins folder (each `manifest.json` bundle). It is synchronous
  and filesystem-only, follows no symlinks, and never evaluates a module.
- **Installer** (`createPluginInstaller`) downloads a `.tgz` bundle, verifies an
  optional SHA-256 checksum and detached signature, extracts it into a private
  staging directory, validates the embedded manifest against the requested
  id/version, then atomically renames it into `<pluginsDir>/<id>/<version>/` and
  records the active version. It never evaluates plugin code, and every failure
  raises a value-free `PluginInstallerError`.
- **Activation** (`activatePlugins`) is the one slice that imports plugin code.
  It resolves the enabled ids, discovers the matching plugins, and dynamically
  imports each entry module — executing trusted plugin top-level code at import
  time. It structurally validates the exported plugin object(s) but **never
  calls `setup`**; the extension runner does that later.

**`activatePlugins` is an exported, opt-in capability — it is not wired into
`createApplication`.** The runtime's boot path does not discover or dynamically
import plugins: `createApplication` runs the extensions the app config declares
directly (`config.extensions` and `plugins.use`), always in full —
`plugins.enabled` is a marketplace/managed-only gate for admin-installed plugins,
never a boot-time filter. When `plugins.managed` is true **and** a
`plugins.stateSource` is supplied, boot also discovers installed bundles under
`plugins.pluginsDir` (default `storage/plugins`) and activates the enabled ones
from persisted state. Static export (`jsails build`) and a config without a
state source skip that discovery pass, so boot stays free of managed-state I/O
in those cases.

## Managed state

A managed deployment (`plugins.managed: true`) can persist plugin state in the
application's database instead of the `<pluginsDir>/state.json` document. The
table is **framework-owned**: the `DatabasePluginState` entity maps to
`jsails_plugin_state` with a generated integer primary key and four scalar
columns — `pluginId` varchar(190), `activeVersion` varchar(64), `enabled`
boolean, `updatedAt` datetime. An app opts in by adding `pluginStateEntities` to
its `JsailsDataSource` `entities` and running the normal history:

```js
// jsails.config.js  (app-owned; plain ESM)
import { JsailsDataSource, pluginStateEntities } from 'jsails';
import { User } from './entities/user.js';

export default new JsailsDataSource({
  type: 'mariadb',
  /* ... */
  entities: [...pluginStateEntities, User],
});
```

```sh
jsails db:push --config jsails.config.js
```

`createDatabasePluginStateStore({ dataSource })` reads and writes that table
through the injected data source's **repository** — no raw SQL and **no runtime
DDL**. The table must already exist: a missing table fails with a clear,
value-free error telling the caller to run `jsails db:push`; the store
**never creates it**.

An explicit `dataSource` is caller-owned and must already be initialized. For
an app config, pass `getDataSource` instead: it resolves and initializes the
source on the first managed read/write, so importing the config stays inert and
a static build never connects. The returned `pluginState` is both the boot
`stateSource` and the installer/admin manager store, so a bundle install writes
files and the state row through the same lifecycle.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
import { dataSource } from './jsails.config.js';
import { createDatabasePluginStateStore } from 'jsails/plugins';

const pluginState = createDatabasePluginStateStore({
  getDataSource: () => dataSource,
});

export default {
  plugins: {
    managed: true,
    stateSource: pluginState,
    pluginsDir: 'storage/plugins',
  },
};
```

The admin installer and the CLI (`jsails plugins install|uninstall`) persist to
the same table; `enable`/`disable`/`rollback` flip the state row. Newly
installed or enabled bundles are activated on the **next app boot** — plugin
code is loaded at boot, not hot-swapped while the process is running.

## Exporting and importing state

`jsails plugins export` and `jsails plugins import` round-trip the managed
plugin state as a deterministic, versioned snapshot document — the same model
as Drupal `config:export`/`config:import` or Magento `app:config:dump`. They
require a managed deployment (`plugins.managed: true`) and read/write the
**database state only**; they never install, download, or remove bundle files.

```sh
jsails plugins export                        # snapshot to stdout
jsails plugins export --output plugin.state.json
jsails plugins import plugin.state.json
jsails plugins import plugin.state.json --force
```

The snapshot is a strict JSON document sorted by plugin id, with no secrets,
absolute paths, or timestamps:

```json
{
  "format": "jsails.plugins",
  "version": 1,
  "plugins": [
    { "id": "acme-blog", "version": "1.2.0", "enabled": true, "source": "bundle" },
    { "id": "acme-core", "version": "1.0.0", "enabled": true, "source": "bundle", "checksum": "sha256-..." }
  ]
}
```

- **`export`** loads the app config, refuses a non-managed deployment, opens the
  managed state source, and projects each entry. `source` is always `bundle`
  (managed installs are bundles); `checksum` is captured from the active
  bundle's manifest when the bundle is present on disk, and omitted otherwise.
  The `--output` file is written atomically (temp file + rename).
- **`import`** validates the snapshot, then reconciles persisted state only. It
  refuses to enable a plugin whose bundle/version is missing and reports every
  rejected entry without echoing its value. `--force` overrides only the
  missing-bundle enablement refusal — it never fabricates a bundle. Re-importing
  the same snapshot is idempotent.

### DB and file drift

The database is the source of truth for managed state; a snapshot is a
point-in-time projection of it. The two can drift:

- A bundle removed from disk after export leaves its id/version in the exported
  snapshot. Import then reports that entry as missing (unless `--force`).
- A snapshot exported from one environment reflects that environment's state;
  importing it into another does **not** transfer the bundle files — it only
  reconciles the `active`/`enabled`/`settings` rows. Install the bundles first,
  then import, or the entries will be rejected.
- `source` and `checksum` are capture-time provenance: import never writes them
  back (the `jsails_plugin_state` table has no such columns), so they are for
  audit/human review, not reconciliation.

## Next steps

- [Admin Panel](/docs/admin) — the first-party admin surface.
- [Extending JSails](/docs/extending) — the extension seam.
