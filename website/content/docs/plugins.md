---
title: Plugins
order: 15
section: Extending
---

# Plugins

A plugin is a packageable unit of services, configured by options, that an
application runs by listing it in `plugins.use`.

Plugins are written with `definePlugin` from `jsails/kernel` (the contract
below). A first-party plugin not yet converted still uses the older
`JsailsPlugin` object of `jsails/extensions`; both run in the same setup phase
(see [Legacy extension plugins](#legacy-extension-plugins)).

## The plugin contract

`definePlugin(spec)` validates a declaration and returns a **factory**. Calling
the factory with options parses them against the plugin's Zod schema and
returns an inert `PluginInstance`; nothing runs until the host runs the
application's plugins. The factory's `definition` (name, options schema, env
declaration, contributed slots) is readable without configuring an instance,
which is how tools and gates inspect a plugin.

```ts
import { definePlugin, envVar, tokenRef } from 'jsails/kernel';
import { createServiceToken } from 'jsails/kernel';
import { z } from 'zod';

interface Search {
  query(text: string): Promise<readonly string[]>;
}
interface Index {
  lookup(
    text: string,
    options: { readonly limit: number; readonly apiKey: string },
  ): Promise<readonly string[]>;
}

export const searchToken = createServiceToken<Search>('search');
export const indexToken = createServiceToken<Index>('search.index');

export const searchPlugin = definePlugin({
  name: 'search',
  options: z
    .object({
      index: tokenRef(indexToken).default(indexToken),
      limit: z.number().int().positive().default(20),
    })
    .strict(),
  env: { SEARCH_API_KEY: envVar.secret({ minLength: 24 }) },
  requires: (options) => [options.index],
  provides: [searchToken],
  setup({ options, env, services }) {
    const index = services.get(options.index);
    services.provide(searchToken, {
      query: (text) => index.lookup(text, { limit: options.limit, apiKey: env.SEARCH_API_KEY }),
    });
  },
});

export const configured = searchPlugin({ limit: 10 });
```

The spec fields:

| Field | Meaning |
| --- | --- |
| `name` | An identifier; each instance's name is unique within the application. |
| `options` | A Zod schema. Without one the factory takes nothing (or `{}`). |
| `key` | A function of the parsed options naming one instance, for a plugin configured more than once. |
| `env` | The environment variables the plugin reads, each built with `envVar.*`. |
| `requires` | Service tokens that must be provided before this plugin's setup runs. |
| `optional` | Tokens read when another plugin provides them; that provider runs first when present. |
| `provides` | Tokens this plugin's setup must provide. |
| `substrate` | Resources (a connection pool, a client) the kernel opens on first use and closes at shutdown, declared from `{ options, env, rootDir }`. |
| `setup` | Wires the services: a function, or `lazy(() => import('./setup.js'))`. |
| `schema`, `jobs`, `schedules`, `release` | Contributions read without setup, each a `lazy(() => import(...))` module. |

`requires`, `optional` and `provides` are token lists or functions of the
parsed options, so an option can choose which instance of a service the plugin
uses. A plugin cannot both provide and depend on one token
(`plugin.conflicting_token`).

### One plugin, several instances

An application configures a plugin once, unless the plugin declares `key`: a
function of its parsed options that names the instance. Each instance is then
named `<plugin>:<key>`, so one application can run a disk plugin for `media`
and another for `backups`, each providing its own keyed token. The same key
twice, or an unkeyed plugin configured twice, fails before any setup
(`extension.invalid_extension`, `duplicate_name`); a key that is not an
identifier fails the factory call (`plugin.invalid_instance_key`). Setup
receives the instance's `name` and `key`.

```ts
import { z } from 'zod';
import { createServiceToken, definePlugin } from 'jsails/kernel';

interface Disk {
  readonly root: string;
}

const diskToken = createServiceToken<Disk>('disk');

export const diskPlugin = definePlugin({
  name: 'disk',
  options: z.object({ disk: z.string(), root: z.string() }).strict(),
  key: ({ disk }) => disk,
  provides: ({ disk }) => [diskToken.named(disk)],
  setup({ options, services }) {
    services.provide(diskToken.named(options.disk), { root: options.root });
  },
});

export const disks = [
  diskPlugin({ disk: 'media', root: 'storage/media' }),
  diskPlugin({ disk: 'backups', root: 'storage/backups' }),
];
```

### Options are data

Options hold data, functions, service tokens and module references, never
instances. Besides plain Zod schemas, `jsails/kernel` has one helper for each
of the other three: `fn<F>()` (a callback), `tokenRef(token)` (the token or one
of its keyed members) and `moduleOption<T>()` (a `moduleRef<T>('app/policies/post')`,
an app-relative module the host resolves). `boundObject(shape)` takes an object
of data and functions a caller may write as a class instance (a log channel, a
notification channel, a webhook verifier): each key of `shape` is read from the
caller's object, inherited members included, each function bound to that
object so a method keeps its `this` and private fields, and the result is
checked as a strict object of `shape`. `checkOptionSchema(schema)` lists
every other `z.custom`, `z.instanceof`, `z.any`, `z.unknown`, `z.promise` or
`z.file` in a schema, and the `unconverted-plugins` gate runs it on every
first-party plugin.

Invalid options throw `config.invalid_options` from the factory call, before
any setup. Its issues carry a path and a code only: object keys appear in the
path when the schema declares them, array indexes always, and a record key or
an unknown key never, so no option value or attacker-chosen key reaches a log.

### Environment variables

`env` maps variable names (upper snake case) to `envVar.string({ refuseBlank? })`,
`envVar.url()`, `envVar.integer()`, `envVar.boolean()` or
`envVar.secret({ minLength?, generate? })`, each optionally `.optional()` or
`.default(value)`. The host reads exactly the declared names, treats an empty
value as unset (except for a string declared with `refuseBlank: true`, whose
blank value fails with the problem `blank`: a selector whose unset default
must not stand in for a value a deployment meant to render), and hands setup
and substrate the parsed values as `env`; a
variable that fails its rule throws `config.invalid_env` naming the variable
and the rule, never the value. A plugin reads no other variable:
`describePluginEnv(name, env)` lists the declaration in the manifest's terms,
and for a package with a manifest the `plugin-manifests` gate checks that
`jsails.env` lists the same variables.

### Services and tokens

A plugin's setup sees only the tokens it declared: reading an undeclared token
or providing one it did not list throws `plugin.undeclared_service`, a missing
required service throws `plugin.missing_service`, and a declared provision that
setup never made throws `plugin.missing_provision`. Two plugins that declare
the same provided token fail before any setup with
`extension.duplicate_provider`. See [Keyed and live tokens](/docs/services#keyed-and-live-tokens)
for one token family with several named instances (`diskToken.named('media')`)
and for services that exist only in a live process.

### HTTP routes and the mode

Setup receives `routes`, the plugin instance's HTTP registrar, and `mode`:
`'development'`, `'test'` or `'production'`, read from the `NODE_ENV` of the
environment the runner was given (anything else is production), so a plugin
that serves a development-only surface asks `mode` instead of reading
`process.env`.

`routes.add({ methods, path, access, credentials?, body?, timeoutMs?, handler })`
registers a route that runs inside the request pipeline like a filesystem API
route: it states its access (`publicAccess(reason)`, exported from
`jsails/kernel`, or a check function that admits only on exactly `true`),
refuses a cross-site unsafe request unless it declares `credentials: []` (it
reads no credential and sees no session), and its handler takes a `RouteContext` and returns a
`Response`. Path parameters (`/outbox/:index`) arrive in `context.params`.
`routes.transform(kinds, transform)` rewrites the answers of `page`, `api`,
`component` or `mount` routes; `routes.guard(guard)` runs before every route;
a code plugin (not a managed one) may also `routes.mount(prefix, fetch,
options)`. Every registration is stamped with the instance's name and listed in
`api/routes.md` for first-party plugins. A registration made after setup
returned throws `plugin.routes_closed`. A handler reads the request's resolved
client from `context.client`, and the whole request frame (whether the request
arrived through a proxy, say) from `currentRequestFrame()` of `jsails`.

```ts
import { definePlugin, publicAccess } from 'jsails/kernel';

export const statusPlugin = definePlugin({
  name: 'status',
  setup({ routes, mode }) {
    if (mode !== 'development') return;
    routes.add({
      methods: ['GET'],
      path: '/_status',
      access: publicAccess('development status page; it shows no data'),
      handler: () => Response.json({ ok: true }),
    });
  },
});
```

### Inert setup, substrate and lifecycle

Setup wires services; it opens no connection, writes no file, starts no
subprocess, arms no recurring timer and leaves no timer pending. A plugin that needs a connection
declares it as a substrate resource: the kernel registers a handle under the
resource's token before any setup runs, `handle.get()` opens it on first use,
and it closes once, after every cleanup. Long-running work (a queue worker, a
listener) is a lifecycle unit, `lifecycle.register(roles, unit, options?)`,
for the `web`, `worker` or `export` role; setup also sees the process's
`roles`.

```ts
import { definePlugin } from 'jsails/kernel';

interface Indexer {
  start(): Promise<void>;
  finish(deadline: AbortSignal): Promise<void>;
  stop(): void;
  healthy(): Promise<boolean>;
}
declare function createIndexer(): Indexer;

export const searchPlugin = definePlugin({
  name: 'search',
  setup({ lifecycle }) {
    const indexer = createIndexer(); // connection-free until start
    lifecycle.register(
      ['worker'],
      {
        name: 'search.indexer',
        start: () => indexer.start(), // connect and begin; a throw fails the process start
        drain: (deadline) => indexer.finish(deadline), // stop taking work, finish in-flight
        abort: () => indexer.stop(), // the deadline passed: stop now
        ready: () => indexer.healthy(), // optional readiness probe, named after the unit
      },
      { transport: { name: 'search', reach: 'shared' } },
    );
  },
});
```

The kernel plans the units from the registrations before any starts, the same
way in every process: two units with one name (`kernel.duplicate_unit`), an
`after` naming a unit nobody registers (`kernel.unknown_unit`) and a cycle
(`kernel.unit_cycle`) are refused. `jsails serve` starts the units of the `web`
role (with `--with worker`, the `worker` role's too), `jsails work` those of
the `worker` role, in dependency order; a unit whose start throws aborts the
units already started, last first. On shutdown the HTTP servers drain first,
then the units in reverse dependency order (independent units together), all
under the app's one `shutdownTimeoutMs` deadline, whose signal each `drain`
receives. A unit not idle at the deadline, or when a second SIGINT/SIGTERM
arrives, is aborted, and each abort gets at most one second. The plugin
cleanups run last.

`transport` names what the unit's work travels on and how far it reaches:
`shared` (any process on it) or `process` (only this process, like the
in-memory jobs adapter). The roles of every unit on a `process` transport must
all run in the process or none of them may: a web process alone over the
in-memory jobs adapter is refused (`kernel.adapter_not_shared`) instead of
dispatching jobs no worker will see. A runner without a start stage (the
`runExtensions` of a command) refuses a unit registered for a role it runs
(`plugin.lifecycle_unavailable`) and ignores one for another role; a managed
plugin cannot register units.

[`testPlugin`](/docs/testing#testing-a-plugin) runs a plugin's setup with every
one of those side effects trapped, and returns the routes, transforms and
guards it registered.

### Legacy extension plugins

The older contract is the `JsailsPlugin` object: it extends `JsailsExtension`
with a declarative `renderer` passthrough and a `PluginContext` whose `setup`
can additionally register interceptors and observers. `priority`, `disabled`,
`requires` and `provides` are inherited, so such a plugin takes
part in the same contract-ordered setup phase as every extension.
`definePlugin(plugin)` from `jsails/extensions` is an identity helper that keeps
the `setup` context typed as `PluginContext`. A legacy plugin may carry
`describe?: () => PluginDescription`, a pure descriptor readable without
running `setup` (its `components`). The first-party plugins still on
this contract are listed in `scripts/expected-failures/unconverted-plugins.json`
until they convert.

## Declaring plugins

`plugins.use` lists the plugin instances the app runs, in order: each is the
result of calling a plugin's `definePlugin` factory with its options. Every
listed plugin always runs.
The graph is resolved before any setup: a plugin that `requires` a service
runs after the plugin that `provides` it whatever the list order, and a
cycle, a required service no plugin provides, two plugins of one name, or two
providers of one service is `config.misconfigured`.

```ts
import { defineApp, definePlugin } from 'jsails/kernel';

const audit = definePlugin({ name: 'audit', setup() {} });

export default defineApp({
  config: () => ({
    plugins: { use: [audit()], activation: { mode: 'locked' } },
  }),
});
```

Until KRN-11b removes them, a legacy `jsails.app.js` may still list a
specifier or a `[specifier, options]` tuple, which the loader imports and
calls with the options (see [Legacy keys](/docs/configuration#legacy-keys)).
The `{ specifier, id, enabled, requires, conflicts }` descriptor form and
`plugins.force` are removed (`config.removed_option`): declare `requires` and
`provides` on the plugin instead.

The activation mode (`plugins.activation`, see
[Plugin activation](/docs/configuration#plugin-activation)) is sealed in
code. Today both modes run exactly the plugins above: the marketplace plugin
source, which will add verified, signed plugin bundles in managed mode only,
is not part of this release. Nothing else activates plugin code: no database
row, no file in the storage directory and no admin page. The options of the
removed plugin installer and plugin state store (`plugins.enabled`,
`downloads`, `stateSource`, `pluginsDir` and `allowLoadFailures`) are
`config.removed_option`.

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

`permissions` are enforced for plugins a marketplace plugin source activates
(none does yet; the gate is in place for it): each setup capability the
framework grants requires a declared permission, and an undeclared one throws
a value-free `PluginPermissionError` (`missing_permission`) during `setup`.

| Setup capability                         | Permission              |
| ---------------------------------------- | ----------------------- |
| `routes.add`, `routes.mount`             | `http.routes`           |
| `routes.transform`                       | `http.transform`        |
| `configureRequestScope`                  | `http.scope`            |
| `routes.guard`, `configureGuard`         | `http.guard`            |
| `onServe`                                | `http.serve`            |
| `intercept`                              | `interceptors.register` |
| `observe`                                | `events.observe`        |
| `services.provide(…, { replace: true })` | `services.replace`      |
| a non-empty `readiness` field            | `health.readiness`      |

A plugin a marketplace source activates registers its routes as a
`managed-plugin` owner: it is never granted `routes.mount`, it cannot use the
`/_jsails` namespace, and an app whose activation mode is not
`managed` fails assembly on any of its routes
(`route.managed_origin_refused`) or response transforms
(`route.managed_transform_refused`).

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

`autoload` declares which of an npm plugin's public subpaths it would expose
as bare names; the default is `none`. `selected` names its own `specifiers`
and, optionally, the ids of `plugins` it installs whose own `autoload` it
exposes; `all` exposes every plugin it installs. The manifest validates the
field, but nothing projects it onto `globalThis`: a plugin in `plugins.use` is
constructed directly, and a reference to its exports is an explicit import.

### First-party plugins

Every first-party plugin package under `packages/*` carries its v1 manifest as
the `jsails` field of its `package.json`, the only plugin metadata file.
Dependency discovery reads it, so `jsails plugins list` sees the package
without importing it. The id follows the package name (`@jsails/auth` →
`jsails-auth`), the publisher is `jsails`, and `jsailsCompat` tracks the
framework's supported range. The `plugin-manifests` gate checks each one
against its plugin's own declaration. For a plugin on the `jsails/kernel`
contract it reads the runtime definition (so a lazy setup or schema module is
read like an inline one): a factory named after the package exists, its `env`
equals the manifest's `env`, it contributes a `schema` exactly when the
manifest declares one, and a plugin that provides services declares
`services.provide`. For a legacy plugin it reads the source: the
`definePlugin` name matches the package, owned tables (`schema.entities`) and
the manifest `schema` agree, every setup capability the plugin uses is a
declared permission, and every declared environment variable is read by the
package. The `unconverted-plugins` gate requires, besides the options rule and
a light config entry, that a test of the package awaits
`testPlugin(<factory>(...))`. Library packages under `packages/*` that export no
plugin factory carry no manifest.

### Plugin-owned schema

A `definePlugin` plugin contributes the tables it owns through its lazy
`schema` slot, whose module default-exports `{ models }`, the model classes. A
package writes `schema: lazy(() => import('./schema.js'))`, so its config entry
loads none of the models; the sample inlines the module:

```ts
import { definePlugin, lazy } from 'jsails/kernel';

class Tenant {
  name = '';
}

export const tenancyPlugin = definePlugin({
  name: 'tenancy',
  schema: lazy(async () => ({ default: { models: [Tenant] } })),
  setup() {},
});
```

`jsails db:push`, `jsails db:diff` and `jsails test` load that module (and
never the setup) and register the models beside the application's. The slot's
`tables` and `dataMigrations` are the phased schema planner's shapes; until
that planner reads them, a contribution that carries any fails the schema
commands with `plugin.unsupported_contribution` rather than planning without
them. A legacy plugin may declare static schema entities:

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

Plugin schemas are opt-in through `plugins.use`: a plugin that is not listed
there contributes no tables. `--app-config <path>` overrides the app
config used for discovery.

## Discovery and check

`discoverPlugins({ rootDir })` from `jsails/plugins` lists the plugin packages
an application depends on without importing any plugin code: each direct npm
`dependencies` entry of the app's `package.json` that self-identifies through
its own `jsails` field, then, transitively, each plugin package those depend
on, resolved Node-style from the plugin's directory and never above `rootDir`.
It returns the plugins sorted by id with their provenance (`root` for a direct
dependency, `requiredBy` and `provenanceChain` for a transitive one), the
plugin-to-plugin dependency `edges`, and value-free `issues` (an unreadable or
invalid manifest, a missing transitive dependency, a cycle, two versions of one
id). Two packages declaring one id at one version throw a
`PluginDiscoveryError`. Discovery is synchronous, reads `package.json` files
only, and activates nothing: a discovered plugin runs only when the app config
lists it in `plugins.use`.

`checkPlugins(result, frameworkVersion)` checks each discovered plugin's
`jsailsCompat` range and declared `plugins` against the running framework and
the other plugins, and returns value-free findings.

```sh
jsails plugins list           # the plugin packages, with provenance
jsails plugins check --json   # their compatibility findings; exit 1 on any
```

`jsails plugins` has only these two read-only subcommands. The subcommands of
the removed installer and plugin state store (`install`, `uninstall`,
`enable`, `disable`, `rollback`, `resolve`, `export`, `import`) are a usage
error (exit 2) that says plugins run when the app config lists them in
`plugins.use`.

## Release trust

The marketplace's trust primitives live in `@jsails/marketplace`, a package
with no third-party dependencies (Node's `zlib` and `crypto`, and the manifest
contract from `jsails`). It is private until the marketplace server and admin
packages build on it, so this section states the formats a publisher signs and
the rules a site applies. The archive reader and `openBundle` throw registry
errors (`bundle_archive.*`, `bundle_intake.*`); the verifiers return a verdict
(`{ ok: true, … }` or `{ ok: false, code }`) for any untrusted input and throw
only for site config that is wrong (`marketplace_config.*`). No code or message
echoes a value from the input.

### Bundles

A bundle is a gzip-compressed tar archive. The reader (`readTarGz`) accepts
ustar, GNU (`L` long names) and pax (`x` per-entry records; a `g` global header
carrying only metadata, as `git archive` writes) headers, so GNU tar, bsdtar
and `git archive` output all read. It refuses, with a `bundle_archive.*` code:

- links (`symlink_entry`, `hardlink_entry`), devices and FIFOs
  (`device_entry`), native addons (`native_addon_entry`, any `.node` file),
  and every header kind it does not read (`unsupported_archive_format`:
  sparse files, base-256 sizes, `hdrcharset`, a pax `g` record that changes a
  path or size);
- a name that is not UTF-8, is absolute, has an empty, `.`, `..` or
  `__proto__` segment, a backslash, a Windows-reserved character or device
  name (`CON`, `nul.js`), a segment ending in a dot or space, a control or
  bidirectional formatting character, a segment over 255 bytes, or a path over
  1,024 characters (`unsafe_path`);
- two names that collide once case and Unicode normalisation are folded the
  way case-insensitive file systems fold them (APFS joins `ſ` and `s`, `ς`
  and `σ`, `ß` and `ss`; NTFS joins `ı` and `i`), or a file that is also a
  directory (`duplicate_entry`);
- a bad checksum, a malformed size or pax record, data after the end blocks
  (`invalid_header`), and an archive cut short (`truncated`).

Limits are enforced while reading, and a caller may only tighten them: 16 MiB
compressed, 64 MiB extracted, 2,000 entries (`too_large`, `too_many_entries`).
Every file and directory header counts as an entry, repeats included, and is
counted before its name is checked, so a stream of tiny headers cannot buy
unbounded work; a pax or GNU long-name header belongs to the entry it
describes.

`openBundle` applies the single-root rule on top: one shared top-level
directory (npm's `package/`) is stripped, the archive then holds exactly one
`manifest.json`, at its root (a second one at any depth, in any case, is
`bundle_intake.multiple_manifests`), the manifest passes the bundle profile of
the manifest contract, and its `entry` and `schema.file` exist. It returns the
bundle's SHA-256 `digest` and the `manifestDigest` of the manifest's bytes.

### Signed records

Every signed record is serialised as canonical JSON (RFC 8785, restricted to
safe integers): members sorted by UTF-16 code units, no whitespace, strings
escaped as `JSON.stringify` does, and nothing a value cannot round-trip
(fractions, `undefined`, lone surrogates, more than 32 levels). A signature is
Ed25519 over the UTF-8 bytes of a domain tag, a newline and that text:

```text
jsails.marketplace.<kind>.v1\n<canonical JSON>
```

`<kind>` is `release`, `delegation` or `catalog`, so a signature over one kind
can never be replayed as another. Signatures and public keys are standard
base64 (a public key is the raw 32 bytes). Every object is closed: an unknown
member is refused, and a new member is a new `v`. The package's tests carry
checked-in vectors (key seed, record, canonical text, signature) for each kind.

A release statement says what the publisher vouches for. It is detached from
the bundle, and the bundle's own digest is never authority:

```json
{
  "statement": {
    "v": 1,
    "id": "acme-notes",
    "version": "1.2.0",
    "digest": "<sha256 of the .tgz, lowercase hex>",
    "size": 4096,
    "manifestDigest": "<sha256 of manifest.json>",
    "permissions": ["http.routes", "net.fetch:api.example.com"],
    "jsailsCompat": "^1.0.0",
    "publisher": "acme",
    "issuedAt": "2026-11-01T00:00:00.000Z"
  },
  "signatures": [{ "keyId": "acme-release-1", "sig": "<base64>" }]
}
```

`permissions` are unique and sorted, `issuedAt` is in `Date#toISOString` form,
and an optional `provenance` (`repo`, `commit`, `run`) names the build.

### Publishers, ceilings and verification

A site trusts publishers it declares with `publisher({ id, ids, keys,
ceiling })`. `ids` are the plugin ids the publisher may release, exact or as a
dash-terminated prefix (`acme-*`); each key has a `use` (`root`, `release`,
`catalog`); `ceiling` lists the permissions the publisher may ever request
(`net.fetch:*` covers every host). `createTrust({ publishers, ceiling, revoked,
catalogs, delegations })` adds the site's own ceiling and revocations.

`verifyRelease(envelope, bytes, trust)` checks, in order, and refuses with the
first failure:

| Code | Meaning |
| --- | --- |
| `invalid_envelope` | The envelope or statement is malformed. |
| `digest_mismatch` | The bytes are not the ones the statement names. |
| `unknown_publisher` | The site does not trust that publisher. |
| `release_revoked` | The digest is revoked. |
| `unknown_key`, `key_revoked`, `key_use`, `key_expired`, `bad_signature` | No signature verifies under a usable `release` key (the furthest stage any signature reached is reported). |
| `id_outside_namespace` | The plugin id is not in the publisher's `ids`. |
| `permission_above_publisher_ceiling`, `permission_above_site_ceiling` | A requested permission exceeds a ceiling. |
| `invalid_bundle` | The signed bytes are not a valid bundle. |
| `statement_mismatch` | The bundle's manifest disagrees with the statement (id, version, publisher, compatibility range, manifest digest or permission set). |

The bytes are digested before anything is opened, and opened only after a
trusted key signed them. `verifyRelease(envelope, bytes, trust, { limits })`
takes tighter archive limits; limits that are wrong are the site's mistake, so
they throw `bundle_archive.invalid_limits` before any input is read instead of
blaming the release as `invalid_bundle`.

### Delegated keys and catalogs

A root key delegates a short-lived `release` or `catalog` key by signing
`{ v: 1, publisher, keyId, publicKey, use, notAfter }`. A delegation holds
only while one of the roots that signed it is still configured with the same
public key and is not revoked, so revoking or rotating a root drops every key
it delegated. A delegated key refuses a record whose `issuedAt` is after its
`notAfter` (`key_expired`). A key delegated more than once (a renewal with a
later `notAfter`, a grant of another use) keeps every grant that holds, so the
verdict never depends on the order delegations and catalogs are passed in.

A catalog is the publisher's signed list of plugins and releases, with a
`sequence`, `issuedAt`, `expiresAt`, the publisher's current delegations, and
its revocations (`revoked.keys` by key id, `revoked.releases` by digest).
`verifyCatalog(raw, trust, { accepted, now })` refuses a catalog that lists an
id outside the publisher's namespace, a delegation in it whose root signature
fails (`invalid_delegation`), and a rollback: a sequence lower than that of the
newest catalog the site has accepted (`catalog_rollback`; an equal sequence is
a refetch). `accepted` is `{ sequence, keyId }`, stored from the verified
catalog, and options that are wrong throw
`marketplace_config.invalid_catalog_options`. A catalog past `expiresAt` still
verifies, marked `stale`: its revocations still apply, but a site does not
offer installs from it. Passing the verified catalog to `createTrust` applies
its delegations and revocations, the revocations to that publisher only.

Revocations only restrict, so they are honoured from any catalog whose
signature verified, a refused rollback included: its verdict carries
`revocations`, which `createTrust` accepts in `catalogs` and which add no key.
Without that, one catalog signed with a stolen key at a huge sequence would
turn every later catalog, the one revoking that key included, into a rollback.
The rollback floor is also bound to the key that set it, as TUF recovers from
a fast-forward attack: once that key is revoked, in the site's config or in
the candidate catalog itself, the floor no longer holds, so a publisher
recovers by revoking the stolen key in its next catalog, signed by another
key, at its usual next sequence.

**Revocation, not expiry, is the real control.** `issuedAt` is written by the
signer, so a stolen delegated key can backdate a statement to before its
`notAfter`, and expiry alone never stops it. A compromised key is stopped by
revoking it (in the site's `revoked` config, or in the publisher's next
catalog, which a rollback cannot undo), and a compromised root by removing it
from the site's publisher config. Keep delegations short, publish catalogs
often, and treat `notAfter` as hygiene that limits honest mistakes.

## Next steps

- [Admin Panel](/docs/admin) — the first-party admin surface.
- [Extending JSails](/docs/extending) — the extension seam.
