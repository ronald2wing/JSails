---
title: Admin Panel
order: 16
section: Extending
---

# Admin Panel

The Admin Panel is the first-party, ORM-free admin surface built from
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
  doubled slash. A malformed path raises a value-free `AdminPanelError` at
  construction, never echoing the bad value.
- `title` — the document title, defaulting to `DEFAULT_ADMIN_TITLE` (`Admin`).
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
- `auth: authSessionToken` builds the resolver from the first-party `auth`
  plugin's `AuthSessionService`. When built from `auth`, the `admin` plugin
  declares `requires: [authSessionToken]`, so the `auth` plugin must be declared
  earlier or assembly fails with a value-free error.

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
  `direction` (only a whitelisted `sortable` column), an optional clamped
  `search` term, and whitelisted `f_<name>` select filters.
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
not claim the reserved `plugins` slug (owned by the first-party
admin-plugin-manager page).

`defineStoreResource(spec)` derives a resource's `list`/`get`/`save` from a
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
present. `defineReplicateAction`, `defineRestoreAction`, and `defineImportAction`
build the common clone / soft-delete-restore / bulk-import shapes on the same
footing.

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

## Tabs and wizards

- `defineTabs({ tabs })` groups resource fields into named tabs for the
  create/edit form. `collectTabFields` flattens the tab set into a single field
  list; `renderTabs` emits tab nav plus the active tab's fields.
- `defineWizard({ steps })` splits the form into sequential steps with per-step
  validation and navigation. `wizardStepValues` extracts the current step's
  values, `collectWizardFields` flattens all steps, and `renderWizard` emits
  step navigation plus the current step's fields. Validation still runs over the
  full flattened field set.

## Relation managers

`defineRelationManager({ relation, resource })` describes a related-resource
panel for inline CRUD over sibling records. It is an inert descriptor — route
mounting is not part of the surface — and a parent resource declares it via
`relationManagers`. `renderRelationManager(manager, rows, parentId, options)`
emits a server-rendered table.

`defineAttachAction` and `defineDetachAction` build attach/detach `AdminAction`
descriptors for many-to-many relations, wired into the related resource's bulk
actions.

## Grouping and export

- `groupRows(rows, { by })` partitions list rows into ordered groups by a
  column value; `renderGroupedTable` emits group headers plus a per-group table.
- `defineExportAction({ name, label, format, columns? })` builds a bulk action
  that serializes selected rows to CSV or JSON;
  `serializeExport(format, columns, rows)` returns the content plus content-type.

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
`@jsails/admin-plugin-manager` plugin is built on this seam to mount the plugin
install/enable surface under the reserved `plugins` page.

## Jobs dashboard

`defineJobsDashboardPage(source)` and `jobsDashboard(source)` (`@jsails/admin`)
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
import { jobsDashboard } from '@jsails/admin';
import { dashboardSource } from './dist/jobs/dashboard.js';

export default {
  extensions: [
    adminPlugin(
      defineAdminPanel({
        resolveSession,
        authorize: (session) => session?.role === 'admin',
        adminPlugins: [jobsDashboard(dashboardSource)],
      }),
    ),
  ],
};
```

`jobsDashboard(source)` validates the source eagerly via
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

`defineFlagsAdminPage(options)` (`@jsails/flags`) builds a read-only admin page
(slug `flags`, label `Feature Flags`) that lists every global flag and provides
activate/deactivate toggle buttons. Scoped flags (per-user, per-tenant) are
deliberately excluded — toggling them requires application code.

The page resolves the `FeatureFlags` service from the extension registry lazily
per request, so a process restart picks it up. When the `flags` plugin is not
enabled, the page renders an "unavailable" message rather than a 500.

```js
// app/admin/flags-page.js  (app-owned; plain ESM, compiled JS)
import { flagsToken } from '@jsails/flags';

// defineFlagsAdminPage({ flags, path }) builds an AdminPage descriptor:
// - `flags` — the FeatureFlags service (or undefined for fail-closed).
// - `path` — admin panel base path, defaults to '/admin'.
// When `flags` is undefined, the page renders "unavailable" rather than 500.
export function createFlagsAdminPage(services) {
  return defineFlagsAdminPage({
    flags: services.tryGet(flagsToken),
    path: '/admin',
  });
}
```

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
import { adminPlugin, defineAdminPanel } from '@jsails/admin';
import { flagsToken } from '@jsails/flags';

export default {
  plugins: {
    use: ['@jsails/flags'],
  },
  setup({ services }) {
    const flags = services.tryGet(flagsToken);
    // Build the flags admin page inside setup so the service registry is live;
    // defineFlagsAdminPage({ flags, path }) returns an AdminPage descriptor.
    // Pass it to the admin panel through an admin plugin or a custom page
    // extension — see "Admin plugins" above for the `register(builder)` pattern.
  },
  extensions: [
    adminPlugin(
      defineAdminPanel({
        resolveSession,
        authorize: (session) => session?.role === 'admin',
        // Include the two flag-specific notice codes the page emits:
        notices: [
          { code: 'flag_activated', level: 'success', message: 'Flag activated.' },
          { code: 'flag_deactivated', level: 'success', message: 'Flag deactivated.' },
        ],
      }),
    ),
  ],
};
```

The two built-in notice codes (`flag_activated` / `flag_deactivated`) produce a
success flash message after each toggle, visible on the redirect back to the
flags page.

### Honest limits — feature flags admin page

- **Global scope only.** The page reads `flags.all()` (no scope argument) and
  passes no scope to `activate`/`deactivate`. Scoped flags must be toggled
  through application code. The page renders an explicit note to this effect.
- **No key creation or deletion.** The page lists only flags that already exist
  in the store — it cannot add or remove flag keys. A flag with no stored value
  (absent from `all()`) is invisible on the page.
- **The `flags` service must be registered.** When the `flags` plugin is not
  enabled, the page renders "unavailable" rather than a 500. This is the same
  fail-closed pattern as the jobs dashboard.

## Next steps

- [Plugins](/docs/plugins) — packaging, discovering, and installing extensions.
- [Authentication](/docs/auth) — the first-party auth plugin and session flow.
