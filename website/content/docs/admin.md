---
title: Admin Panel
order: 16
section: Extending
---

# Admin Panel

The admin panel is the first-party, ORM-free admin surface built from
declarative resources, widgets, and actions.

The admin surface is assembled from frozen descriptors — panels, pages,
resources, widgets, charts, notices, actions, and admin plugins — and mounted
by the `adminPlugin` factory. Nothing is executed at import time: every
descriptor carries callbacks by identity and is only consumed when the plugin
runs during application assembly. This makes the whole surface inert to define
and trivially testable without a server.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
import { adminPlugin, defineAdminPanel } from '@jsails/admin';

export default {
  extensions: [
    adminPlugin(
      defineAdminPanel({
        resolveSession, // or `auth: authSessionToken` — exactly one
        authorize: (session) => session?.data.role === 'admin',
        resources: [posts],
        widgets: [postCount],
      }),
    ),
  ],
};
```

## Assembly

`defineAdminPanel(options)` validates the panel options and returns a frozen
`AdminPanel` descriptor. `adminPlugin(panel)` turns that descriptor into the
first-party `admin` plugin, which mounts trusted, default-deny Hono routes
under the panel's base path.

- `path` — admin base path, defaulting to `DEFAULT_ADMIN_PATH` (`/admin`). It
  must be an absolute path, not `/` or end with `/`, stay outside the reserved
  `/_jsails` namespace, and contain no backslash, control characters, or
  doubled slash. A malformed path raises a value-free `AdminDefinitionError` at
  construction, never echoing the bad value.
- `title` — the document title, defaulting to `DEFAULT_ADMIN_TITLE` (`Admin`).

Every `define*` factory in `@jsails/admin` reports an invalid descriptor the
same way: it throws `AdminDefinitionError`, a `JsailsError` whose `code`
(`invalid_panel`, `invalid_resource`, `invalid_action`, `duplicate_name`,
`reserved_slug`, `missing_parent`, and so on) names the failure and whose
message never echoes the offending value.
- `theme` — `'light' | 'dark' | 'system'` (default `'system'`), rendered as
  the document's `data-theme` attribute plus minimal light/dark CSS variables.
  No client bundle is involved. `themeCustomization` appends raw CSS or a
  `--name: value` token map after the default theme CSS so it wins on equal
  specificity; values are injected verbatim into a `<style>` tag, so a string
  containing `</style` is rejected at construction.
- `authorize` — **required**, default-deny. The request is served only when the
  callback resolves to exactly `true`; a truthy non-boolean, throw, or rejection
  all deny. It receives the resolved session (`null` when unresolved).
- `onError(error, { surface, slug?, operation? })` — optional. Every failure a
  route turns into a value-free response (a throwing page, resource callback,
  action, disk write, session resolver, or authorize gate) is handed to it; the
  HTTP response does not change. Without it the panel records an `exception`
  entry in the `diagnostics` service when one is registered and writes one
  value-free line to stderr (`[jsails:admin] resource.save (articles) failed:
  QueryFailedError [ECONNREFUSED]`, never the error message).

Every admin mutation checks a same-origin `Origin` plus the `_csrf` token. The
origin is compared with the origin core resolved for the request
(`server.origin`, or an allowed `server.hosts` entry), so a panel behind a
TLS-terminating proxy accepts its own `https://` posts.

### Session resolution

Exactly one of `resolveSession` or `auth` is required.

- `resolveSession(request)` is a trusted resolver returning a `Session` (or
  `null`).
- `auth: authSessionToken` builds the resolver from a session service — any
  service token whose value has a `resolveSession(request)` method
  (`AdminSessionService`). The first-party `auth` plugin's `authSessionToken`
  fits, without `@jsails/admin` depending on `@jsails/auth`. When built from
  `auth`, the `admin` plugin declares `requires: [token]`, so the providing
  plugin must be declared earlier or assembly fails with a value-free error.

The panel rejects a session authenticated by an `Authorization` header (a
bearer or API token, `session.data.authMethod` of `bearer` or `api-token`)
before `authorize` runs: the panel is a browser surface whose mutations rely on
the cookie session's CSRF token, and a leaked API token must not reach it.

The web starters pass `authorize: adminOnly` from `@jsails/auth`, which admits
only a session whose user holds the `admin` role (assigned with `setUserRole`,
never by sign-up). The `--blog` starter grants its blog, media, theme, and
configuration admin plugins the same gate with `withAdminAuthorize` (see
[Default-deny contributions](#default-deny-contributions)). No starter mounts
the plugin manager: a plugin is installed with npm and runs once it is listed
in `plugins.use` (`plugins.enabled` has an effect only in managed mode).

### Default-deny contributions

Every resource, custom page, and row or bulk action is default-deny on top of
the panel gate: one that declares no `authorize` is reachable by no one, and
its dashboard link is hidden. Declare an `authorize` on each one you write.
For an admin plugin you did not write, `withAdminAuthorize(plugin, gate)`
returns a plugin whose contributions that declare no `authorize` get
`gate(session)` (an exact `true` allows); a contribution that declares its own
keeps it. References between the plugin's own resources (a relation
manager's or relation column's `related`, an action's `parent`) are pointed at
the gated copies, so the gate reaches them too. A resource the plugin only
refers to without contributing it, such as one of the app's own, keeps its own
`authorize` and is not opened by the gate.

```js
import { defineAdminPanel, withAdminAuthorize } from '@jsails/admin';
import { adminOnly } from '@jsails/auth';

defineAdminPanel({
  auth: authSessionToken,
  authorize: adminOnly,
  adminPlugins: [mediaAdmin({ library })].map((plugin) => withAdminAuthorize(plugin, adminOnly)),
});
```

## Resources

`defineResource(spec)` builds a frozen `Resource` descriptor: a `slug`, a
`label`, the list-table `columns`, the form `fields`, optional header/row/bulk
`actions`, an optional read-only `infolist`, optional `resolveFileDisk`, and the
trusted `list`/`get`/`save` callbacks plus a strict Zod object schema derived
from the fields.

```ts
// No import: these are projected globals in app code (see conventions.md).
const posts = defineResource({
  slug: 'posts',
  label: 'Posts',
  columns: [
    { name: 'title', label: 'Title', searchable: true, sortable: true },
    { name: 'published', label: 'Published', format: 'boolean' },
    {
      name: 'author',
      label: 'Author',
      type: 'relation',
      related: authors, // the authors Resource; its `list` gate decides who sees the column
      resolve: (row) => row.authorName,
    },
  ],
  fields: [
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'published', label: 'Published', type: 'toggle', required: false },
  ],
  authorize: ({ session }) => session.data.role === 'admin',
  list: async ({ page, pageSize }) => ({ rows, total }),
  get: async ({ id }) => rowOrNull,
  save: async ({ id, values }) => persist(values),
});
```

- `list(context)` is required and returns `{ rows, total }` for one page.
  `context` carries `session`, `page`, `pageSize`, an optional `sort` /
  `direction` (only an allowlisted `sortable` column), an optional clamped
  `search` term, and allowlisted `f_<name>` select filters.
- `get(context)` fetches one record for the edit form; `save(context)` persists
  a create (`id: null`) or update. Omitting `save` makes the resource read-only.
- `authorize` is per-resource and default-deny: without it every route of the
  resource answers 403, and with it only an exact `true` allows. It gates the
  `list` / `view` / `create` / `update` / `delete` / `action` operations via an `AdminResourceAuthorizeContext` carrying
  `session`, `action`, an optional `recordId`, and, for `action`, the
  `actionName`. A callback that allows only a fixed set of operations now also
  has to allow `action` for the actions it should run.
- `resolveFileDisk({ session, fieldName })` resolves the `Disk` that stores a
  `file` field upload (or `null` to skip), wiring the admin upload path to the
  `@jsails/filesystem` disk seam.

Slugs are bare identifiers (`[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?`) and must
not claim the reserved `plugins` slug (owned by the `@jsails/admin-plugin-manager`
plugins page).

`defineStoreResource(definition)` derives a resource's `list`/`get`/`save` from a
`ResourceStore` plus a `Serializer`, so an existing resource-store implementation
can back admin CRUD without writing callbacks by hand. It synthesizes a minimal
request context. The list's sort, search, and select filters reach the store's
`count` and `list` as one `NormalizedQuery`, the same shape the API handlers
pass. Select-filter values are strings unless the definition also passes the API
resource's `filters` options, which coerce each value to its declared type. Every save runs through `serializer.validate` first, partially for an
update, so a read-only or undeclared key never reaches the store. A
`ValidationError` thrown by any `save` callback re-renders the form as a 422
instead of a 500.

## Fields

Form fields cover `text`, `textarea`, `select`, `toggle`, `number`, `date`,
`datetime`, `checkbox`, `radio`, `repeater`, `file`, `keyvalue`, `tags`,
`color`, `slider`, `code`, `markdown`, and `autocomplete`. `required` defaults
to `true`.

Rich-text fields use the `richText` type and accept an editor adapter. Custom
editors are documented in [Editors](/docs/editors).

- `toggle` and `checkbox` coerce an absent key to `false` and never honor
  `required` — an unchecked box is a legitimate `false`, not a missing field.
- `number` coerces numeric strings; an empty or non-numeric value is a
  validation error, never a silent `0`.
- `repeater` renders a bounded, repeatable list of scalar item fields
  (`repeater: { fields, maxItems? }`); item kinds are the scalar field types
  only, never `repeater` or `file`. Items submit as flat `name[i].sub` keys and
  are lifted into an array before the strict schema validates.
- `file` persists a string key; `resolveFileDisk` selects the backing `Disk`.
  A form with a file input (top-level or in a formset row) posts as
  `multipart/form-data`. Each upload is checked before anything is written: it
  must fit `maxBytes` (default `DEFAULT_MAX_UPLOAD_BYTES`, 10 MiB), it must
  not be active content (HTML, SVG, XML, or JavaScript, judged by the sniffed
  bytes, the extension, and the declared type), and, when `accept` is set
  (`image/*,application/pdf,.csv`), its sniffed type or extension must match.
  A refusal is a 422 field error. The stored content type is the sniffed one
  (or `application/octet-stream`), never the client's. Keys are
  `<field>/<random id>/<basename>`, so equal filenames never share an object.
  The values validate first and the bytes are written only after that; a save
  that throws removes what it wrote. A submitted string is never trusted as a
  key: an edit that does not pick a new file keeps the stored key (the form
  carries it in a hidden input, which is accepted only when it matches the
  stored record).

Author collections are deep-frozen; the derived schema is a strict Zod object
that coerces types, enforces `required`, and rejects unknown keys.

## Columns

List columns carry a value-cell format plus optional affordances. The
`ResourceColumnFormat` set is `badge`, `boolean`, `date`, `image`, `icon`,
`color`, and `tags`.

- `sortable` and `searchable` flags opt a column into list sorting and the
  search term.
- `filter` plus `f_<name>` in the query string drive select filters.
- A `type: 'relation'` column with a `resolve(row)` callback renders related
  labels (escaped text) instead of a plain value cell, and must not declare
  value-cell affordances (`format`/`colors`/`sortable`/`searchable`/`filter`).
  It must name the related `Resource` as `related`: the column is shown, and
  `resolve` called, only for a session that resource's `authorize` allows to
  `list`, so a relation column cannot leak what the related resource hides.
- `infolist: { label, entries }` renders a read-only detail section above the
  edit form; entries mirror a column's `name`/`label`/`format`/`colors`.

## Actions

`defineAdminAction(spec)` builds a declarative mutation with a `name`, `label`,
an optional `confirm` prompt, an optional per-record `authorize`, an optional
success `notice` code, and a `run(context)` callback. Actions attach to a
resource as `header` (collection-level), `row` (single record), or `bulk`
(selected records) targets.

Every action needs the resource's `authorize` to allow `action: 'action'` with
the `actionName` (and the `recordId` for a row action), on the confirm page and
on the run, on top of `list`. Per-record `authorize` is default-deny: a row or
bulk action without one authorizes no record and never runs (a header action,
which acts on no record, is gated by the resource alone). When present it is
exact-`true`. It is additive: a `row` or `bulk` action
also runs the resource's own `authorize` with `action: 'update'` and the
record's id, so a session that may not update a record cannot act on it
through an action either. A row or bulk run left with no authorized record is
a 403, not a no-op success.

A `requiresParent` action's parent id comes from the client, so the routes
authorize it: the parent resource's `update` gate must allow the id, and the
record must exist when that resource has `get`. The parent resource is the
action's `parent` option, or, for an attach/detach action, the single resource
that lists its relation manager. An action whose parent resource is unknown is
refused (403).

Relation-manager routes apply the same per-record gate to the parent record
(`view` for the list, `update` for create and delete), and also consult the
related resource's own `authorize`: `list` for the list (and for the inline
manager on the parent's edit form), `create` for a create, and `delete` with
the related record's id for a delete. The create form is rendered only when
those gates allow a create, and each row's delete button only when the delete
gate allows that row's id. `defineReplicateAction`,
`defineRestoreAction`, and `defineImportAction` build the common clone /
soft-delete-restore / bulk-import shapes on the same footing.

## Widgets, notices, and charts

- `defineWidget(spec)` builds a dashboard stat-card descriptor (`name`, `label`,
  `render`). `defineProgressWidget`, `defineListWidget`, and `defineTrendWidget`
  extend the set beyond the base stat card.
- `defineNotice(code, { level, message })` registers a flash message keyed by a
  stable code (`success` / `info` / `warning` / `error`). The built-in
  `ADMIN_ACTION_SUCCESS_CODE` / `ADMIN_ACTION_SUCCESS_NOTICE` pair is the
  standard action-success message. An unknown `?_notice=` code is dropped
  silently.
- `defineChart({ name, label, render })` builds a dashboard chart whose `render`
  returns trusted SVG markup. `lineChartSvg`, `barChartSvg`, `donutChartSvg`,
  and `areaChartSvg` are self-contained, label-escaping SVG helpers.

## Custom pages

`defineAdminPage(spec)` builds a page descriptor (`slug`, `label`, optional
grouping/badge/sort, `authorize`, `render`, optional `handlePost`).
`authorize({ session, slug })` is a per-page gate that runs after the panel's
own `authorize` on every GET and POST; a page without one is served to no one,
only an exact `true` serves the page,
and the dashboard hides the link from a session it denies. `render` receives an
`AdminPageRenderContext` (session, path, raw request, URL) and returns full HTML
— the page owns its own escaping. A page without `handlePost` returns 405 for a
POST; with one, POSTs go through the same-origin, CSRF-checked path as every
other admin mutation.

A page that renders a full document uses the same shell as the framework-owned
pages: `renderAdminDocumentWithTheme(panelDocumentOptions(context, title), ...children)`
lifts the panel's theme, theme customization, theme tokens, and client scripts
out of the render context under a title. The small form helpers keep page markup
consistent: `csrfInput(token)` and `hiddenInput(name, value)` emit hidden inputs,
`actionForm({ path, csrf, action, id, label })` emits a one-button POST form
carrying `_csrf`, `action`, and `id`, and `renderNotice(message)` emits the
`role="status"` banner the dashboard uses for flashes. `adminErrorResponse(status,
title, message)` renders a value-free error document for a status the fixed
400/403/404/500 helpers do not cover.

## Tabs and wizards

- `defineTabs({ tabs })` groups resource fields into named tabs for the
  create/edit form. `collectTabFields(tabs, fields)` returns the covered field
  names as `fields` plus the tab entries with no matching resource field as
  `missing`; `renderTabs` emits tab nav plus the active tab's fields.
- `defineWizard({ steps })` splits the form into sequential steps with per-step
  validation and navigation. `wizardStepValues` extracts the current step's
  values, `collectWizardFields(wizard, fields)` returns the same `{ fields,
  missing }` coverage over all steps, and `renderWizard` emits step navigation
  plus the current step's fields. Validation still runs over the
  full flattened field set.

## Relation managers

`defineRelationManager({ relation, resource })` describes a related-resource
panel for inline CRUD over sibling records. A parent resource declares it via
`relationManagers`, and `adminPlugin` mounts its list/create/delete routes
under the resource. `renderRelationManager(manager, rows, parentId, options)`
emits the server-rendered table for custom pages.

The create form renders the related resource's fields (all but the foreign
key and file fields). The route validates the submission through a strict
schema of exactly those fields (plus the foreign key), so `create` receives
schema-validated values and a field the form leaves out, such as a required
`file` field, cannot fail every create; an unknown or invalid field
re-renders the manager as a 422. A repeater's add/remove buttons re-render
the form (200) without creating anything. A submitted foreign
key is ignored: when the related resource declares it as a field, it holds the
parent id. Delete checks that the related record exists (`related.get`) and
that its foreign key equals the posted parent id; a manager whose related
resource has no `get` cannot prove that, so its delete route refuses every
request.

`defineAttachAction({ manager, attach, authorize })` and `defineDetachAction({
manager, detach, authorize })` build attach/detach `AdminAction` descriptors for many-to-many
relations, wired into the related resource's bulk actions. Both set
`requiresParent`, so the confirm page is opened with `?parent=<id>` and the run
posts it back as `_parent`; the callback receives `{ session, parentId,
relatedIds }` once their per-record `authorize` (default-deny, as for any
action) has allowed the selected records and the parent resource (the optional `parent` option, else the
resource declaring `manager`) has allowed `update` on that id, and a run that
arrives without a parent fails with `AdminDefinitionError` (`missing_parent`)
instead of guessing.

## Grouping and export

- `groupRows(rows, { by })` partitions list rows into ordered groups by a
  column value; `renderGroupedTable` emits group headers plus a per-group table.
- `serializeExport(format, columns, rows)` serializes rows to RFC-4180 CSV or a
  JSON array and returns the content plus its content-type, so a custom page's
  `handleGet` can return a download `Response`; `resolveExportColumns(columns,
  rows)` falls back to the first row's keys when no column list is given.

## Global search

`renderGlobalSearch(panel, resources, session, term)` renders the
cross-resource search page. The term is trimmed and clamped to
`MAX_QUERY_LENGTH` (200); an empty term renders the form without querying.
Resources are queried concurrently, each contributes at most
`RESULTS_PER_RESOURCE` (10) rows, and unauthorized resources or rows are
excluded; a throwing resource is skipped and reported through `onError`.

## Admin plugins

`defineAdminPlugin({ id, register })` builds a Filament-style extension seam.
`register(builder)` runs once during assembly and contributes pages
(`addPage`), resources (`addResource`), and free-form navigation links
(`addNavigationItem`). Contributions are collected before routes mount, so every
plugin-provided surface shares the same dashboard navigation and the same
panel-wide slug-uniqueness guarantee. The first-party
`@jsails/admin-plugin-manager` package is an admin contribution built on this
seam, not a framework plugin of its own: `pluginManagerAdmin(options)` returns
an admin plugin that mounts the curated directory, the install/enable/disable/
uninstall/rollback surface under the reserved `plugins` page, and per-plugin
settings under `plugin-settings`. Its options are validated eagerly into a
frozen `PluginManagerAdminOptions`; an invalid one throws `PluginManagerError`
(`invalid_options`). By
convention an admin-plugin factory is named `<name>Admin()` (`jobsAdmin`,
`mediaAdmin`, `pluginManagerAdmin`) and a single page factory
`define<Name>AdminPage()`.

### Plugin manager access and install policy

The plugin manager decides which code the server runs, so a panel session is
not enough to use it. Every gate defaults to deny:

- `authorize` (an `AdminPageAuthorize`) gates both the `plugins` and
  `plugin-settings` pages, after the panel's own `authorize`. Without it, both
  pages answer 403 to every session and are left out of the dashboard nav.
- `authorizeInstall({ session, action })` gates every action that changes
  which code runs: `action` is `'install'`, `'update'`, `'rollback'`,
  `'uninstall'`, `'enable'`, or `'disable'` (enabling decides whether an
  installed bundle loads on the next start). Only an exact `true` allows it,
  and a throw denies. Without it, those buttons are hidden and the POSTs
  answer 403. Settings saves only need `authorize`.
- The raw id/version/URL install form is off unless `allowRawInstall: true` is
  set, and it is never offered beside a `directory`. It takes only
  credential-free `https:` URLs, and `allowedHosts` limits it to a list of
  host names. The page checks the submitted URL and passes `allowedHosts` to
  the installer, and the core installer (`createPluginInstaller`) downloads
  through `guardedFetch`, which refuses any redirect hop that leaves `https:`
  or the list and connects only to addresses it has checked. A custom
  `installer` must apply `InstallPluginInput.allowedHosts` the same way.
- Every download needs a SHA-256: the raw form's `sha256` field, or the
  `sha256` field of a curated directory entry (64 hex characters, checked
  when the directory is built). A bundle without one is refused, and a
  directory entry without one shows no Install button. The opt-out is
  `allowUnverified: true`. Each unverified install, like every other installer
  warning, goes to `onWarning(message)`, which defaults to
  `process.emitWarning`. A published `@jsails/admin-plugin-manager` gives
  every `firstPartyPluginDirectory` entry the SHA-256 of the tarball that same
  release published (`npm run release` records them in the package build). A
  source checkout or a local build has no digests, so installing from the
  directory there needs `allowUnverified`.

```js
pluginManagerAdmin({
  directory: firstPartyPluginDirectory,
  frameworkVersion: '1.0.0',
  managed: true,
  stateSource: pluginState,
  installer: pluginInstaller,
  authorize: ({ session }) => session.data['role'] === 'admin',
  authorizeInstall: ({ session }) => session.data['role'] === 'owner',
});
```

Installed state is read from `stateSource`, or from the default JSON store
under `pluginsDir` when there is none (the same default the installer uses), so
the directory cards and the plugin table always agree. Enable/disable,
settings saves, and installer calls started from these pages run one at a time
per state source, so two overlapping changes cannot overwrite each other. Each
change writes only its own plugin's entry (`putEntry`/`removeEntry`), so a
`stateSource` must implement all of `load`, `save`, `putEntry`, and
`removeEntry`; one that does not is refused when the page is built. Pass the
installer the same `stateStore` as `stateSource`. The installer behind these
pages must keep its default `allowPrivateHosts: false`: the URL comes from a
form, and the guard is what stops it reaching the server's own network, on the
first URL, on every redirect, and against a DNS answer that changes between the
check and the connection.

Plugin discovery (the walk of the app's dependencies and bundle directory) is
cached for 10 seconds per `pluginManagerAdmin` instance. Every POST to the
plugins page clears the cache, so a change made from the page shows at once; a
change made outside it (the CLI, `npm install`) shows within the 10 seconds.
The state document is read fresh on every view.

On the settings page, an unknown-shaped stored value is never shown: the page
only says whether one is stored. A blank number field is treated as unset, so
it falls back to its declared default or is removed. Setting controls submit
as `setting:<key>`.

## Jobs dashboard

`defineJobsAdminPage(source)` and `jobsAdmin(source)` (`@jsails/admin`)
build a read-only admin page over worker-owned job observability. The dashboard
renders three sections — per-job metrics, live queue counts, and recent failed
jobs — and is fail-closed by construction: every read degrades to an explicit
`unavailable` note rather than a 500.

The source is a `JobsDashboardSource` (`src/jobs/dashboard-source.ts`): a
`metrics` object (with a `snapshot()` function), a `failed` object (with a
`list()` function), and an optional `readCounts` function for live queue totals.
Metrics and the failed-job store are **worker-owned** — they accumulate
per-process as jobs run — so the application injects the same source instance
that the `jobsPlugin({ dashboard })` option validates at boot:

```js
// app/jobs/dashboard.js  (app-owned; plain ESM, compiled JS)
import { InMemoryJobMetrics, InMemoryFailedJobStore } from 'jsails/jobs';

const metrics = new InMemoryJobMetrics();
const failed = new InMemoryFailedJobStore({ maxEntries: 50 });

export const dashboardSource = { metrics, failed };
```

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
import { adminPlugin, defineAdminPanel } from '@jsails/admin';
import { jobsAdmin } from '@jsails/admin';
import { dashboardSource } from './dist/jobs/dashboard.js';

export default {
  extensions: [
    adminPlugin(
      defineAdminPanel({
        resolveSession,
        authorize: (session) => session?.data.role === 'admin',
        adminPlugins: [
          jobsAdmin(dashboardSource, {
            authorize: ({ session }) => session.data.role === 'admin',
          }),
        ],
      }),
    ),
  ],
};
```

`jobsAdmin(source, { authorize })` validates the source eagerly via
`validateJobsDashboardSource` and returns an `AdminPlugin` (id `jobs-dashboard`)
contributing a page at slug `jobs`. Its only mutation is a "Reset counters"
form. Like every admin page it is default-deny: `authorize` (the page gate,
called with `{ session }`) decides who may open it and reset the counters, and
without it (or `withAdminAuthorize(jobsAdmin(source), gate)`) no session
reaches it. The panel's same-origin and CSRF gates apply as for any page.

### Honest limits — jobs dashboard

- **Metrics are worker-owned and injected.** There is no process-global metrics
  registry the admin can read from. The application must pass the same
  `InMemoryJobMetrics` / `InMemoryFailedJobStore` instances to both the worker
  process and the admin dashboard. A web process that only dispatches jobs
  (through `jobsPlugin`) has no metrics; wire it only where the worker runs.
- **Viewing never resets the counters.** A collector with a non-destructive
  `peek()` (as `InMemoryJobMetrics` has) is read through it. Otherwise `JobMetrics.snapshot()` drains the
  collector, so the page folds each drained snapshot into a running total it
  keeps (averages weighted by run counts); every viewer sees the same numbers,
  but another consumer of the same collector (a `MetricsHistory`) still loses
  what the page drained. The counters reset only through the reset POST.
- **Queue counts are a transport capability.** When the transport has no
  `readCounts` (or the source omits it), the queue section renders `unavailable`
  rather than invented zeros.
- **No retry UI.** The failed-job table is a read-only listing. Manual retries
  must go through application code or the CLI.

## Feature flags admin page

`@jsails/flags/admin` contributes a feature-flags page (slug `flags`, label
`Feature Flags`) that lists every global flag with activate/deactivate toggle
buttons. It is a separate subpath so `@jsails/flags` never loads
`@jsails/admin`, which is only an optional peer of the flags package.

`flagsAdmin({ store })` returns an admin plugin for the panel's `adminPlugins`
list; `defineFlagsAdminPage({ store })` builds the page alone for `pages`. Pass
the same `FeatureStore` you hand `flagsPlugin`, so the admin and the runtime
`FeatureFlags` service read and write one store.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
import { defineAdminPanel, withAdminAuthorize } from '@jsails/admin';
import { createMemoryFlagStore } from '@jsails/flags';
import { flagsAdmin } from '@jsails/flags/admin';

const flagStore = createMemoryFlagStore();
const adminOnly = (session) => session.data.role === 'admin';

export default {
  plugins: {
    use: [
      ['@jsails/flags', { store: flagStore }],
      [
        '@jsails/admin',
        defineAdminPanel({
          resolveSession,
          authorize: (session) => session?.data.role === 'admin',
          // The page declares no authorize of its own, so it is default-deny;
          // withAdminAuthorize grants it the admin gate.
          adminPlugins: [withAdminAuthorize(flagsAdmin({ store: flagStore }), adminOnly)],
        }),
      ],
    ],
  },
};
```

After each toggle the page redirects back to itself with a `flag_activated` /
`flag_deactivated` notice and renders the matching status message.

### Honest limits — feature flags admin page

- **Global scope only.** The page reads `all()` (no scope argument) and passes
  no scope to `activate`/`deactivate`. Scoped flags must be toggled through
  application code. The page renders an explicit note to this effect.
- **No key creation or deletion.** The page lists only flags that already exist
  in the store — it cannot add or remove flag keys. A flag with no stored value
  (absent from `all()`) is invisible on the page.
- **Same store, same process.** The memory store is per-process; use
  `createDatabaseFlagStore` when several processes must see a toggle.

## Next steps

- [Plugins](/docs/plugins) — packaging, discovering, and installing extensions.
- [Authentication](/docs/auth) — the first-party auth plugin and session flow.
