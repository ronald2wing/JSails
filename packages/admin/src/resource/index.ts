/**
 * Admin resources: the public descriptor surface, re-exported from the split
 * modules.
 *
 * `defineResource(spec)` (see `resource/resource-descriptor.ts`) validates a
 * resource specification and returns a deeply frozen {@link Resource}
 * descriptor; the column types/validation live in `resource/columns.ts`, the
 * field types in `resource/field-types.ts`, their validation in
 * `resource/field-validation.ts`, the Zod coercion in
 * `resource/field-schemas.ts`, and the form/table markup rendering in
 * `resource/render-form.ts` / `resource/render-list.ts`. The `@jsails/admin`
 * barrel re-exports this surface.
 */

export {
  defineResource,
  type Resource,
  type ResourceActions,
  type AdminResourceAction,
  type AdminResourceAuthorize,
  type AdminResourceAuthorizeContext,
  type ResourceFileDiskContext,
  type ResourceFileDiskResolver,
  type ResourceGetContext,
  type ResourceListContext,
  type ResourceListResult,
  type ResourceSaveContext,
  type ResourceDefinition,
} from './resource-descriptor.js';

export {
  DEFAULT_MAX_REPEATER_ITEMS,
  type ResourceAutocompleteConfig,
  type ResourceField,
  type ResourceFieldType,
  type ResourceFormsetConfig,
  type ResourceRepeaterConfig,
  type ResourceRepeaterItemField,
  type ResourceRepeaterItemType,
  type ResourceSelectOption,
} from './field-types.js';

export {
  type ResourceColumn,
  type ResourceColumnFormat,
  type ResourceInfolist,
  type ResourceInfolistEntry,
  type ResourceRelationResolver,
} from './columns.js';

export {
  groupRows,
  renderGroupedTable,
  type RowGroup,
  type GroupRowsOptions,
  type GroupLabelFn,
} from './grouping.js';

export {
  resolveExportColumns,
  serializeExport,
  type ExportFormat,
  type ExportResult,
} from './export.js';
