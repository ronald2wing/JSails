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
        authorize: (session) => session?.role === 'admin',
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

The starter ships a default-deny `authorize` that allows any signed-in session;
restrict it to an admin role in production.

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
    { name: 'author', label: 'Author', type: 'relation', resolve: (row) => row.authorName },
  ],
  fields: [
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'published', label: 'Published', type: 'toggle', required: false },
  ],
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
- `authorize` is per-resource and optional; when present it is default-deny
  (exact `true` allows). It gates the `list` / `view` / `create` / `update`
  actions via an `AdminResourceAuthorizeContext` carrying `session`, `action`, and an
  optional `recordId`.
- `resolveFileDisk({ session, fieldName })` resolves the `Disk` that stores a
  `file` field upload (or `null` to skip), wiring the admin upload path to the
  `@jsails/filesystem` disk seam.

Slugs are bare identifiers (`[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?`) and must
not claim the reserved `plugins` slug (owned by the `@jsails/admin-plugin-manager`
plugins page).

`defineStoreResource(definition)` derives a resource's `list`/`get`/`save` from a
`ResourceStore` plus a `Serializer`, so an existing resource-store implementation
can back admin CRUD without writing callbacks by hand. It synthesizes a minimal
request context and ignores sort/filter/search value-free.

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
- `file` persists a string reference; `resolveFileDisk` selects the backing
  `Disk`.

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
- `infolist: { label, entries }` renders a read-only detail section above the
  edit form; entries mirror a column's `name`/`label`/`format`/`colors`.

## Actions

`defineAdminAction(spec)` builds a declarative mutation with a `name`, `label`,
an optional `confirm` prompt, an optional per-record `authorize`, an optional
success `notice` code, and a `run(context)` callback. Actions attach to a
resource as `header` (collection-level), `row` (single record), or `bulk`
(selected records) targets.

Per-record `authorize` is default-allow when absent and exact-`true` when
present. It is additive: a `row` or `bulk` action also runs the resource's own
`authorize` with `action: 'update'` and the record's id, so a session that may
not update a record cannot act on it through an action either. Relation-manager
routes apply the same per-record gate to the parent record (`view` for the
list, `update` for create and delete). `defineReplicateAction`,
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
grouping/badge/sort, `render`, optional `handlePost`). `render` receives an
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

`defineAttachAction({ manager, attach })` and `defineDetachAction({ manager,
detach })` build attach/detach `AdminAction` descriptors for many-to-many
relations, wired into the related resource's bulk actions. Both set
`requiresParent`, so the confirm page is opened with `?parent=<id>` and the run
posts it back as `_parent`; the callback receives `{ session, parentId,
relatedIds }`, and a run that arrives without a parent fails with
`AdminDefinitionError` (`missing_parent`) instead of guessing.

## Grouping and export

- `groupRows(rows, { by })` partitions list rows into ordered groups by a
  column value; `renderGroupedTable` emits group headers plus a per-group table.
- `serializeExport(format, columns, rows)` serializes rows to RFC-4180 CSV or a
  JSON array and returns the content plus its content-type, so a custom page's
  `handleGet` can return a download `Response`; `resolveExportColumns(columns,
  rows)` falls back to the first row's keys when no column list is given.

## Global search

`renderGlobalSearch(panel, resources, session, term)` renders the
cross-resource search page. The term is clamped to `MAX_QUERY_LENGTH` (200),
each resource contributes at most `RESULTS_PER_RESOURCE` (10) rows, and
unauthorized resources or rows are excluded; a throwing resource is skipped.

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
        authorize: (session) => session?.role === 'admin',
        adminPlugins: [jobsAdmin(dashboardSource)],
      }),
    ),
  ],
};
```

`jobsAdmin(source)` validates the source eagerly via
`validateJobsDashboardSource` and returns an `AdminPlugin` (id `jobs-dashboard`)
contributing a page at slug `jobs`. The page is read-only — it declares no
`handlePost`, so POST receives a 405 — and inherits the panel's default-deny
authorization, same-origin, and CSRF gates.

### Honest limits — jobs dashboard

- **Metrics are worker-owned and injected.** There is no process-global metrics
  registry the admin can read from. The application must pass the same
  `InMemoryJobMetrics` / `InMemoryFailedJobStore` instances to both the worker
  process and the admin dashboard. A web process that only dispatches jobs
  (through `jobsPlugin`) has no metrics; wire it only where the worker runs.
- **Counters reset on each read.** `JobMetrics.snapshot()` clears the counters
  after returning them, so each page load shows counts accumulated since the
  previous read. The dashboard renders a note to that effect.
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
import { defineAdminPanel } from '@jsails/admin';
import { createMemoryFlagStore } from '@jsails/flags';
import { flagsAdmin } from '@jsails/flags/admin';

const flagStore = createMemoryFlagStore();

export default {
  plugins: {
    use: [
      ['@jsails/flags', { store: flagStore }],
      [
        '@jsails/admin',
        defineAdminPanel({
          resolveSession,
          authorize: (session) => session?.role === 'admin',
          adminPlugins: [flagsAdmin({ store: flagStore })],
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
