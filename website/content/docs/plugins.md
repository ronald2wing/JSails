---
title: Plugins
order: 15
section: Extending
---

# Plugins

A plugin is a packageable extension that can be discovered, installed, and enabled.

A **plugin** is a packageable extension: `JsailsPlugin` extends `JsailsExtension`
with a declarative `renderer` passthrough carried by identity for
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

`plugins.use` in `jsails.app.js` lists plugins to load, each a specifier, a
`[specifier, options]` tuple, or a `{ specifier, id, options, enabled, requires }`
module descriptor (see [Two-source enablement](#two-source-enablement)). The
loader imports the module's default export and
calls it with the options; a module whose default export is already a
`JsailsPlugin` object is accepted as-is. Every plugin a specifier names
automatically runs — developer plugins are never gated by `enabled`.

```js
import { createDiskFromEnv } from '@jsails/filesystem';

const files = createDiskFromEnv();

export default {
  plugins: {
    use: [
      ['@jsails/auth', { registration: { enabled: true } }],
      ['@jsails/filesystem', { disks: { [files.name]: files.disk }, default: files.name }],
    ],
    enabled: ['auth', 'filesystem'],
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
  A custom source implements `load()`, `save(state)`, `putEntry(id, entry)`,
  and `removeEntry(id)`. `save` adds or replaces the entries it carries and
  never deletes an id it omits, so a stale snapshot cannot erase a plugin
  another process installed; the installer and the admin plugin manager write
  one entry at a time through `putEntry` and `removeEntry`.

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
      options: { registration: { enabled: true } },
      enabled: process.env.DISABLE_AUTH !== '1',
      requires: ['cache'],
    },
  ],
}
```

`enabled` defaults to `true`, so a descriptor is an opt-out switch that lives in
the config rather than in code. A disabled descriptor is skipped before import. When enabled modules declare
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

A plugin describes itself in a manifest that tools, the marketplace, and the
framework read **without importing any plugin code**. An npm package carries it
in the `jsails` field of its `package.json`; a marketplace bundle carries the
same schema as `manifest.json`. The format is version 1 (`manifestVersion: 1`)
and strict: an unknown field is an issue, never silently ignored.

```json
{
  "manifestVersion": 1,
  "id": "acme-tasks",
  "version": "1.2.0",
  "name": "Tasks",
  "summary": "A task list for the admin.",
  "publisher": "acme",
  "jsailsCompat": "^1.0.0",
  "apiTier": "stable",
  "permissions": ["http.routes", "admin.pages", "data.own", "net.fetch:api.acme.dev"],
  "plugins": [{ "id": "acme-core", "range": "^1.0.0" }],
  "entry": "@acme/tasks",
  "settings": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string", "format": "secret", "title": "API key" },
      "retries": { "type": "integer", "minimum": 0, "maximum": 10, "default": 3 }
    },
    "required": ["apiKey"]
  },
  "schema": { "tablePrefix": "acme_tasks_" },
  "admin": { "nav": [{ "label": "Tasks", "path": "/tasks" }] },
  "host": { "imports": ["jsails", "jsails/http", "@jsails/admin"] },
  "marketplace": true,
  "env": [{ "name": "TASKS_TOKEN", "kind": "secret", "required": true }]
}
```

| Field | Meaning |
| --- | --- |
| `manifestVersion` | Always `1`. |
| `id` | Unique plugin id: a lowercase letter or digit, then lowercase letters, digits, `.`, `_`, or `-` (`PLUGIN_ID_PATTERN`). |
| `version` | The plugin version, valid semver. |
| `name`, `summary` | Display name and one-sentence summary, single lines. |
| `publisher` | The publisher id whose release key signs the plugin. |
| `jsailsCompat` | One caret or tilde range of a release version (`^1.2.0`, `~1.4.0`). |
| `apiTier` | `stable` or `experimental`. An experimental plugin tracks one framework minor, so its `jsailsCompat` must be a tilde range. |
| `browserSafe` | Whether the entry may load in a browser bundle. Defaults to `false`. |
| `permissions` | Registered permissions (see below). Defaults to `[]`. |
| `plugins` | Required plugins, `{ id, range }`, unique by id, never the plugin itself. Defaults to `[]`. |
| `entry` | A bundle's module file (`./index.mjs`), or an npm package's own specifier or a path inside it. Never a URL. |
| `settings` | The settings an operator may set, in the settings schema subset. |
| `schema` | The tables the plugin owns: `{ tablePrefix, file? }`. Requires `data.own`. A bundle must describe its tables in `file`, a JSON model description inside it. |
| `admin.nav` | Admin navigation entries `{ label, path }`. Requires `admin.pages`. |
| `host.imports` | The exact framework specifiers the plugin's code imports. |
| `marketplace` | Whether the plugin may ship as a marketplace bundle. Defaults to `false`; a bundle must set `true`. |
| `commands`, `generators` | CLI contributions `{ name, summary, module }`, loaded from the package's own export only when they run. npm packages only. |
| `autoload` | Bare-name exposure. npm packages only. |
| `env` | Environment variables read: `{ name, kind, required?, generate?, description? }`, with `kind` one of `string`, `url`, `integer`, `boolean`, `secret`; only a secret may be generated. npm packages only. |

`commands`, `generators`, `autoload`, and `env` are developer tools: they come
from code a developer installed and reviewed, never from a bundle an admin
uploaded, so **a bundle manifest that carries any of them is invalid**. A
manifest carries no integrity data either: a bundle's authority is its signed
release statement, not a checksum beside it.

Read a manifest with `parsePackageManifest(raw)` (an npm `jsails` field) or
`parseBundleManifest(raw)` (a `manifest.json`), both from `jsails/plugins`;
they throw a value-free `PluginManifestError` (`invalid_manifest`) whose
`issues` are `{ path, code, message }` and never repeat the input. An unknown
key is named in the path only when it is a short plain identifier
(`checksums`); any other key is reported at its parent object.
`checkPluginManifest(raw, source)` returns `{ ok, manifest }` or
`{ ok: false, issues }` instead of throwing.

### Permissions

The permission registry is closed: every name a manifest may declare is
defined by the framework with a plain-language title, a description, and a
risk (`low`, `elevated`, `high`), so an install screen always has a sentence
for each grant. A name nothing defines (`database.read`, `network.connect`) is
an `unknown_permission` issue. A scoped permission names its target after a
colon.

| Permission | Risk | Allows |
| --- | --- | --- |
| `http.routes` | low | Routes under the plugin's own path prefix. |
| `http.routes.any` | elevated | Routes at any free path. |
| `http.middleware` | high | Middleware on every request. |
| `http.transform` | high | Rewriting responses. |
| `http.guard` | high | A guard before routing and static files. |
| `http.scope` | high | A per-request scope every handler runs inside. |
| `http.serve` | high | The running HTTP server (WebSockets). |
| `admin.pages` | elevated | Admin pages and navigation. |
| `data.own` | low | Its own tables under its table prefix. |
| `data.read:<Model>` | elevated | Reading another owner's model. |
| `data.write:<Model>` | high | Changing another owner's model. |
| `net.fetch:<host>` | elevated | Outbound HTTPS to one host name (no IP literal, no wildcard). |
| `mail.send` | elevated | Sending email. |
| `notifications.send` | elevated | Sending notifications. |
| `jobs.define` | low | Background jobs. |
| `jobs.schedule` | low | Recurring jobs. |
| `events.observe` | elevated | Observing framework events. |
| `interceptors.register` | high | Running code around framework operations. |
| `services.provide` | low | New services under untaken names. |
| `services.replace` | high | Replacing an existing service. |
| `files.disk:<name>` | elevated | Files on one named disk. |
| `auth.session.read` | elevated | The signed-in user's identity. |
| `users.read` | elevated | User accounts. |
| `health.readiness` | elevated | A readiness probe. |
| `client.assets` | low | Its own static files. |
| `env.read:<NAME>` | high | One environment variable (never a `JSAILS_` one). |

`PERMISSIONS`, `getPermission(id)`, `parsePermission(text)` (a value-free
`code` on refusal), and `describePermission(text)` (the title with the scope
filled in) are exported from `jsails/plugins`.

### Settings schema

`settings` is a closed subset of JSON Schema: one object of `string`,
`number`, `integer`, `boolean`, string-`enum`, and string-list (`array` of
`string`) fields. Strings take the formats `email`, `uri` (absolute http or
https), `textarea` (the only multi-line kind), and `secret`; every field takes
`title`, `description`, and `default`; the object takes `required`; numbers
take `minimum`/`maximum`, strings `maxLength`, lists `minItems`/`maxItems`, and
list items `maxLength` or `enum`. There is no `pattern`, no `$ref`, and no
nesting, and a `secret` takes no default, since a default in a published
manifest is a published value.

```ts
import { describeSettings, parseSettingsSchema, validateSettings } from 'jsails/plugins';

const parsed = parseSettingsSchema({
  type: 'object',
  properties: { retries: { type: 'integer', minimum: 0, maximum: 10, default: 3 } },
});
if (parsed.ok) {
  const fields = describeSettings(parsed.schema); // [{ key: 'retries', control: 'integer', ... }]
  const result = validateSettings(parsed.schema, { retries: 12 });
  if (!result.ok) console.log(fields.length, result.issues); // [{ path: ['retries'], code: 'too_big' }]
}
```

`validateSettings` fills defaults and returns a frozen value holding only
schema keys. Its issues are a path and a code and never carry a value; a key
the schema does not define is reported once, at the root, without its name,
because a settings value may be a secret.

### Permissions at activation

`permissions` are enforced for plugins activated through the managed surface:
each setup capability the framework grants requires a declared permission, and
an undeclared one throws a value-free `PluginPermissionError`
(`missing_permission`) during `setup`.

| Setup capability                         | Permission              |
| ---------------------------------------- | ----------------------- |
| `configureHttp`                          | `http.routes`           |
| `configureMiddleware`                    | `http.middleware`       |
| `configureRequestScope`                  | `http.scope`            |
| `onServe`                                | `http.serve`            |
| `intercept`                              | `interceptors.register` |
| `observe`                                | `events.observe`        |
| `services.provide(…, { replace: true })` | `services.replace`      |
| a non-empty `readiness` field            | `health.readiness`      |

The `interceptorRegistry` handle a gated plugin receives carries the same
checks on its `intercept` and `observe`, and its `seal` does nothing (the
runner seals the shared registry after every `setup`).

`readiness` is a declared field rather than a setup call, so a plugin that
declares probes without `health.readiness` is refused when its `setup` would
run: its probes run plugin code on anonymous readiness requests, and a failing
one returns 503 for the whole app.

This is a declaration check, not a sandbox: plugin code runs in-process with
the application's privileges and can still reach `node:fs` or `process.env`.
It guarantees that the permissions an operator reviews at install time match
what the framework wires. Services other extensions expose are outside the
gate: observing through a shared signals bus obtained with `services.get` is
governed by that service's provider, not by the caller's manifest. Plugins
loaded through `plugins.use` or `config.extensions` are developer code and are
not gated.

`autoload` opts some of the plugin's public subpaths into bare `globalThis`
names; the default is `none`. `selected` names its own `specifiers` and,
optionally, the ids of `plugins` it installs whose own `autoload` it exposes;
`all` exposes every plugin it installs. The names are projected when the plugin
is activated, from its loaded modules. They are runtime-only and never reach the
ambient `.d.ts`, so a type-checked reference uses an explicit import.

### First-party plugins

Every first-party plugin package under `packages/*` carries its v1 manifest as
the `jsails` field of its `package.json`, the only plugin metadata file.
Dependency discovery reads it, so `jsails plugins list` sees the package
without importing it. The id follows the package name (`@jsails/auth` →
`jsails-auth`), the publisher is `jsails`, and `jsailsCompat` tracks the
framework's supported range. The `plugin-manifests` gate checks each one
against its plugin's own declaration: the `definePlugin` name matches the
package, owned tables (`schema.entities`) and the manifest `schema` agree, every
setup capability the plugin uses is a declared permission, and every declared
environment variable is read by the package. Library packages under
`packages/*` that export no plugin factory carry no manifest.

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

A plugin whose tables are created by its own migrator declares their names as
`schema.unmanagedTables` instead (`@jsails/auth` does this for Better Auth's
tables). The schema commands collect those from `plugins.use` the same way and
plan no operation for the live tables, so they are never dropped or altered.
See [Tables another migrator owns](/docs/migrations#tables-another-migrator-owns).

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
  storage-backed plugins folder. In that folder it reads only
  `<pluginsDir>/<id>/<version>/manifest.json`: it does not walk deeper, skips
  symlinks, staging directories, and names that are not a plugin id or a semver
  version, reports a version directory with no manifest as `manifest_missing`,
  and skips a manifest whose `id` or `version` differs from its directory names
  as `bundle_mismatch`. It is synchronous and filesystem-only, follows no
  symlinks, and never evaluates a module.
- **Installer** (`createPluginInstaller`) downloads a `.tgz` bundle through
  [`guardedFetch`](/docs/support#guardedfetch-outbound-http), the
  framework's one outbound primitive. Every hop, the submitted URL and each of
  at most five redirects, must be credential-free `https:` and, when the
  install input passes `allowedHosts` (host names), name one of those hosts, so
  an allowed host cannot hand the download to an unvetted one. Each hop's host
  is resolved once, and the download is refused with `private_address` when
  any address is loopback, link-local, private, carrier-grade NAT,
  unique-local, unspecified, multicast, documentation, or reserved (IPv4 and
  IPv6, including IPv6 forms that carry an IPv4 address such as
  `::ffff:10.0.0.1`). The connection then goes to one of exactly the addresses
  that were checked, so a second DNS answer (rebinding) cannot point it at the
  server's own network or a cloud metadata endpoint. The `createPluginInstaller`
  option `allowPrivateHosts: true` lifts the address check and admits plain
  `http:` to a loopback address, for an installer whose URLs come from the
  operator directly and never from a request. The `fetch` option replaces the
  outbound function (a test passes `createGuardedFetch` with its own resolver
  and connector); it receives the installer's guard options and must honour
  them. The whole download runs under a 30-second deadline and the installer's
  `maxBytes`.
  A failed, non-2xx, timed-out, or oversize download closes its connection.
  The installer then verifies the bundle's integrity and extracts
  it into a private staging directory. The archive must hold exactly one
  `manifest.json`, at its root once a single shared top-level directory (such
  as npm's `package/`) is stripped: a second one at any depth is
  `multiple_manifests`, and a lone nested one is `manifest_missing`. The
  manifest is validated against the requested id/version, and the flattened
  bundle is atomically renamed into `<pluginsDir>/<id>/<version>/` and the
  installer records the active version. An upgrade or a rollback keeps the plugin's
  settings and its enabled flag. It never evaluates plugin code, and every
  failure raises a value-free `PluginInstallerError`.
- **Integrity is mandatory.** `install` requires a SHA-256 `checksums` entry
  for the artifact (keyed by the URL basename; a map that does not cover it is
  `checksum_missing`) or a detached `signature` verified by the installer's
  `verifySignature` option. A signature without a verifier is
  `signature_unverifiable`, never skipped. A bundle with neither is refused
  (`unverified_bundle`) unless the call passes `allowUnverified: true`; the
  result then carries a warning (`UNVERIFIED_BUNDLE_WARNING`) the caller must
  log. Transport is not part of that choice: verified or not, a bundle comes
  over `https:`, or over plain `http:` only from a loopback address with
  `allowPrivateHosts: true` (anything else is `invalid_url`).
- **Activation** (`activatePlugins`) is the one slice that imports plugin code.
  It resolves the enabled ids, discovers the matching plugins, and dynamically
  imports each entry module — executing trusted plugin top-level code at import
  time. It structurally validates the exported plugin object(s) but **never
  calls `setup`**; the extension runner does that later. Only the bundle version
  recorded as `active` in managed state is loaded, so a rollback really stops
  the version it rolled away from; older versions stay on disk for the next
  rollback. A bundle id with several installed versions and no recorded active
  version loads none (`ambiguous_bundle_version`), and an active version that
  is not on disk is `active_version_missing`; both are reported only for an
  enabled plugin, so stale state for a disabled one never fails boot. Installer staging
  directories are never discovered, and a bundle with a nested manifest is refused at install. A
  failed import is a `plugin_load_failed` issue whose `detail` carries only a
  Node error code or built-in error name, never the error message.

**`activatePlugins` is an exported, opt-in capability — it is not wired into
`createApplication`.** The runtime's boot path does not discover or dynamically
import plugins: `createApplication` runs the extensions the app config declares
directly (`config.extensions` and `plugins.use`), always in full —
`plugins.enabled` is a marketplace/managed-only gate for admin-installed plugins,
never a boot-time filter. When `plugins.managed` is true **and** a
`plugins.stateSource` is supplied, boot also discovers installed bundles under
`plugins.pluginsDir` and activates the enabled ones from persisted state.
Static export (`jsails build`) and a config without a state source skip that
discovery pass, so boot stays free of managed-state I/O in those cases.

`plugins.pluginsDir` resolves against `rootDir` (never the working directory)
and defaults to `<storageDir>/plugins`; the absolute path is
`ResolvedAppConfig.pluginsDir`. It must not overlap the public, out, pages, or
api directories, because it holds bundle source and `state.json`.

The `jsails plugins` subcommands that work on the plugins folder (`list`,
`check`, `install`, `uninstall`, `export`, and `import`) default to that same
resolved path. They read it from the app config named by `--config` (default
`jsails.app.js`), so the CLI installs into, lists, and snapshots the folder the
server scans. Each of them also accepts `--dir <path>` as an override. The
override resolves against the working directory and must stay inside it, so a
`..` traversal or an absolute path elsewhere is refused with a message that
never echoes the value. When `--dir` is given, `list` and `check` skip reading
the app config. Without an app config file, `list`, `check`, `install`, and
`uninstall` fall back to `<cwd>/storage/plugins`; `export` and `import` require
an app config with `plugins.managed`. `enable`, `disable`, and `rollback` change
only the persisted state, and `resolve` only reads it, so these take `--config`
(and `--db-config`) but not `--dir`.

```sh
jsails plugins list --config config/jsails.app.js  # the folder that config names
jsails plugins check --dir vendor/plugins          # an override inside cwd
jsails plugins export --dir vendor/plugins --output plugin.state.json
```

An enabled managed plugin that does not load — not installed, an invalid entry,
a failed import, a missing or ambiguous active version — fails boot with an
`AppConfigError` naming the plugin ids and value-free issue codes. Set
`plugins.allowLoadFailures: true` to boot anyway; every activation issue is
then reported through `process.emitWarning` (code `JSAILS_PLUGIN_ISSUE`).

## Managed state

A managed deployment (`plugins.managed: true`) can persist plugin state in the
application's database instead of the `<pluginsDir>/state.json` document. The
table is **framework-owned**: the `DatabasePluginState` entity maps to
`jsails_plugin_state` with a generated integer primary key and four scalar
columns — `pluginId` varchar(190), `activeVersion` varchar(64), `enabled`
boolean, `updatedAt` datetime. An app opts in by adding `pluginStateEntities` to
its `JsailsDataSource` `entities` and running the normal history:

```js
// jsails.database.js  (app-owned; plain ESM)
import { JsailsDataSource, pluginStateEntities } from 'jsails';
import { User } from './entities/user.js';

export default new JsailsDataSource({
  type: 'mariadb',
  /* ... */
  entities: [...pluginStateEntities, User],
});
```

```sh
jsails db:push --config jsails.database.js
```

`createDatabasePluginStateStore({ dataSource })` reads and writes that table
through the injected data source's **repository** — no raw SQL and **no runtime
DDL**. The table must already exist: a missing table fails with a clear,
value-free error telling the caller to run `jsails db:push`; the store
**never creates it**. The table check runs once per store. `putEntry` updates
or inserts one id's row and `removeEntry` deletes one id's rows, each in its
own transaction; `save` updates or inserts the rows of the ids it carries
inside one transaction and deletes nothing. No write truncates: `TRUNCATE`
commits implicitly on MySQL/MariaDB, so a failed write after it would have
emptied the table.

An explicit `dataSource` is caller-owned and must already be initialized. For
an app config, pass `getDataSource` instead: it resolves and initializes the
source on the first managed read/write, so importing the config stays inert and
a static build never connects. The returned `pluginState` is both the boot
`stateSource` and the installer/admin manager store, so a bundle install writes
files and the state row through the same lifecycle.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
import { dataSource } from './jsails.database.js';
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
the same table; `enable`/`disable`/`rollback` flip the state row and keep the
plugin's persisted settings. They write that one row (`putEntry`), so a change
another process made to a different plugin in the meantime is kept. Newly
installed or enabled bundles are activated on the **next app boot** — plugin
code is loaded at boot, not hot-swapped while the process is running.

`jsails plugins install <id> --version <v> --url <tgz> --sha256 <hex>` pins the
bundle to its SHA-256 checksum, and the checksum is required. Passing
`--allow-unverified` instead installs without an integrity check, and the
command logs a warning. Either way the URL is `https:`, or plain `http:` to a
loopback host (`localhost`, `127.0.0.1`, `[::1]`). The command is run by the
operator at a terminal, so its installer sets `allowPrivateHosts: true`: a
bundle URL on a loopback, private, or internal host (a local registry,
`http://localhost:…`) is not refused with `private_address`. The admin install
form keeps the guard on.
`--signature` is refused, because the CLI has no signature verifier and a
signature that cannot be checked must not pass as verified.

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
  merges: each accepted entry is added or replaced, and a plugin the snapshot
  does not list, or whose entry is rejected, keeps its stored state, so a stale
  or partial snapshot never erases a plugin installed since. It refuses to
  enable a plugin whose bundle/version is missing and reports every rejected
  entry without echoing its value. `--force` overrides only the
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
