/**
 * `@jsails/admin`: the server-only administration surface.
 *
 * `defineAdminPanel` builds a frozen, validated panel descriptor;
 * `adminPlugin` turns it into a first-party `JsailsPlugin` (named `admin`) that
 * mounts trusted, default-deny Hono routes (the dashboard, per-page routes,
 * per-resource CRUD routes, and a 404 catch-all) under the panel's base path.
 * `defineAdminPage` builds a frozen page descriptor (slug, label, `render`,
 * optional `handlePost`); `defineAdminPlugin` builds a plugin descriptor whose
 * `register` contributes pages, resources, and navigation links through a
 * builder; `defineResource` builds a frozen resource descriptor (slug, list
 * columns, form fields, and `list`/`get`/`save` callbacks plus a derived strict
 * Zod schema) that the panel mounts as list/create/edit pages. Every `define*`
 * factory raises one value-free `AdminDefinitionError` for a malformed spec.
 *
 * The shared document, form, and response helpers (`panelDocumentOptions`,
 * `renderAdminDocumentWithTheme`, `adminHtmlResponse`, `adminRedirectResponse`,
 * `csrfInput`, `actionForm`, `renderNotice`, `adminErrorResponse`, and the
 * `readFormBodyAndFiles` parser) are exported so a page or admin plugin can
 * assemble its own responses on the same default-deny, origin/CSRF-checked
 * footing. This barrel is the curated public seam; the route registrars and
 * the session/mutation guards the routes run stay internal.
 */

export { AdminDefinitionError, type AdminDefinitionErrorCode } from './errors.js';

export {
  defineAdminPanel,
  DEFAULT_ADMIN_PATH,
  DEFAULT_ADMIN_TITLE,
  type AdminPanel,
  type AdminPanelAuthorize,
  type AdminPanelOptions,
  type AdminPanelResolveSession,
  type AdminSessionService,
  type AdminTheme,
  type AdminThemeCustomization,
  type AdminThemeTokens,
} from './panel.js';

// `adminPlugin(panel)` is also the package's default export, matching every
// other first-party plugin package: `plugins.use` resolves `'@jsails/admin'` by
// importing the default export and calling it with the panel descriptor passed
// in the options tuple.
export { adminPlugin, adminPlugin as default } from './plugin.js';

export {
  defineAdminPage,
  type AdminPage,
  type AdminPageDefinition,
  type AdminPageRenderContext,
  type AdminPagePostContext,
} from './page.js';

export {
  defineAdminPlugin,
  type AdminPlugin,
  type AdminPluginDefinition,
  type AdminPluginBuilder,
  type AdminNavigationItem,
} from './admin-plugin.js';

export {
  panelDocumentOptions,
  renderAdminDocumentWithTheme,
  adminHtmlResponse,
  adminRedirectResponse,
  type AdminDocumentOptions,
  type AdminDocumentSource,
} from './document.js';

// The hidden inputs and one-button form every admin surface posts back with.
export {
  actionForm,
  csrfInput,
  hiddenInput,
  stripFormMarkers,
  type ActionFormOptions,
} from './forms.js';

// Value-free error responses, shared with admin plugins (the plugin manager,
// the flags page) so every admin surface fails with the same documents.
export {
  adminBadRequestResponse,
  adminErrorResponse,
  adminForbiddenResponse,
  adminNotFoundResponse,
  adminServerErrorResponse,
} from './responses.js';

export { readFormBodyAndFiles, type ParsedFormBody, type UploadedFilePart } from './guards.js';

export {
  defineResource,
  type Resource,
  type ResourceActions,
  type AdminResourceAction,
  type AdminResourceAuthorize,
  type AdminResourceAuthorizeContext,
  type ResourceAutocompleteConfig,
  type ResourceColumn,
  type ResourceColumnFormat,
  type ResourceField,
  type ResourceFieldType,
  type ResourceFileDiskContext,
  type ResourceFileDiskResolver,
  type ResourceFormsetConfig,
  type ResourceGetContext,
  type ResourceInfolist,
  type ResourceInfolistEntry,
  type ResourceListContext,
  type ResourceListResult,
  type ResourceRelationResolver,
  type ResourceRepeaterConfig,
  type ResourceRepeaterItemField,
  type ResourceRepeaterItemType,
  type ResourceSaveContext,
  type ResourceSelectOption,
  type ResourceDefinition,
  groupRows,
  renderGroupedTable,
  type GroupLabelFn,
  type GroupRowsOptions,
  type RowGroup,
  resolveExportColumns,
  serializeExport,
  type ExportFormat,
  type ExportResult,
} from './resource/index.js';

export { defineStoreResource, type StoreResourceDefinition } from './resource/store-resource.js';

// Declarative dashboard widgets, flash notices, resource actions, and the
// cross-resource search renderer: ORM-free descriptors consumed by `adminPlugin`.
export {
  defineWidget,
  defineProgressWidget,
  defineListWidget,
  defineTrendWidget,
  type AdminWidgetContext,
  type AdminWidgetRender,
  type Widget,
  type WidgetDefinition,
  type ProgressWidgetDefinition,
  type ListWidgetDefinition,
  type TrendWidgetDefinition,
} from './widgets.js';

export {
  defineNotice,
  renderNotice,
  ADMIN_ACTION_SUCCESS_CODE,
  ADMIN_ACTION_SUCCESS_NOTICE,
  type Notice,
  type NoticeLevel,
  type NoticeDefinition,
} from './notices.js';

export {
  defineAdminAction,
  defineReplicateAction,
  defineRestoreAction,
  defineImportAction,
  type AdminAction,
  type AdminActionAuthorize,
  type AdminActionAuthorizeContext,
  type AdminActionContext,
  type AdminActionRun,
  type AdminActionDefinition,
} from './actions.js';

export { renderGlobalSearch } from './global-search.js';

// A small declarative chart surface. `defineChart` builds a frozen chart
// descriptor whose `render` returns trusted SVG markup; the shape helpers
// produce deterministic, label-escaping SVG for a chart renderer to return
// directly or compose.
export {
  defineChart,
  lineChartSvg,
  barChartSvg,
  donutChartSvg,
  areaChartSvg,
  type Chart,
  type ChartContext,
  type ChartDefinition,
  type ChartRender,
  type ChartSeriesPoint,
} from './charts.js';

// Tabbed and wizard form layouts. `defineTabs` groups resource fields into
// named tabs for the create/edit form; `defineWizard` splits the form into
// sequential steps with per-step validation and navigation state. Both return
// frozen descriptors with render helpers that emit Preact markup; validation
// still runs over the full flattened field set.
export {
  defineTabs,
  collectTabFields,
  renderTabs,
  type Tabs,
  type TabsDefinition,
  type TabDefinition,
  type TabRenderState,
  type RenderTabsOptions,
} from './tabs.js';

export {
  defineWizard,
  wizardStepValues,
  collectWizardFields,
  renderWizard,
  type Wizard,
  type WizardDefinition,
  type WizardStep,
  type RenderWizardOptions,
} from './wizard.js';

export type { NamedSection, SectionFieldCoverage } from './named-sections.js';

// Relation managers. `defineRelationManager` builds a frozen, inert descriptor
// for inline CRUD over a related resource; a parent resource that declares it in
// `relationManagers` gets its routes mounted by `adminPlugin`, and
// `renderRelationManager` emits the server-rendered table for custom pages.
export {
  defineRelationManager,
  renderRelationManager,
  type RelationManager,
  type RelationManagerDefinition,
  type RelationManagerListContext,
  type RelationManagerCreateContext,
  type RelationManagerDeleteContext,
  type RenderRelationManagerOptions,
} from './relation-manager.js';

// Attach/detach relation actions: thin `AdminAction` builders over a relation
// manager, for wiring into a related resource's bulk actions.
export {
  defineAttachAction,
  defineDetachAction,
  type AttachActionDefinition,
  type DetachActionDefinition,
  type RelationActionContext,
} from './relation-actions.js';

// Jobs observability dashboard (read-only admin page/plugin).
export { defineJobsAdminPage, jobsAdmin } from './jobs-dashboard.js';
