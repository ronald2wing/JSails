/**
 * Admin relation managers: declarative descriptors for inline CRUD of
 * related resources shown alongside a parent record.
 *
 * `defineRelationManager(spec)` validates a relation manager specification — a
 * name, a label, the related {@link Resource} descriptor, a foreign key, a
 * `list` callback, and optional `create`/`delete` callbacks — and returns a
 * frozen {@link RelationManager} descriptor. The descriptor is inert: it
 * carries callbacks by identity and is only consumed by the admin panel routes.
 *
 * `renderRelationManager(manager, rows, parentId, options)` renders a
 * server-side `<table>` from the related resource's columns plus optional
 * create/delete forms with real CSRF-gated POST routes. The create form carries
 * the related resource's own fields (all but the foreign key and file fields,
 * which the parent id and no upload path stand in for); the route validates
 * the submission against a schema of exactly those fields before `create`
 * runs, and handles the repeater add/remove buttons by re-rendering.
 * Every cell value is a Preact text child so Preact owns all escaping.
 * Routes are mounted by {@link registerRelationManagerRoutes} (see
 * `routes/relations.ts`).
 *
 * The related resource's own `authorize` applies wherever its rows are read
 * or written through a manager: `list` to see the table (a denied manager is
 * not rendered at all), `create` for the create form and route, and `delete`
 * (with the related id) for the delete buttons and route.
 *
 * Both ids a `delete` receives are checked by the route: the session must
 * pass the parent resource's `update` gate for `parentId`, and the related
 * record (`related.get`) must exist and carry `parentId` in its `foreignKey`.
 * A manager whose related resource has no `get` cannot prove membership, so
 * its delete route refuses every request.
 *
 * The module is ORM-free: it imports only the session contract (a type) and
 * performs no I/O.
 */

import { h, type ComponentChild } from 'preact';
import type { Session } from 'jsails';
import { isRecord } from 'jsails/plugin-sdk';
import { renderToString } from 'jsails/render-to-string';

import { hasShape, RESOURCE_SHAPE } from './descriptor-shape.js';
import type { AdminErrorSink } from './error-report.js';
import { AdminDefinitionError } from './errors.js';
import { csrfInput, hiddenInput } from './forms.js';
import type { ResourceColumn } from './resource/columns.js';
import type { ResourceField } from './resource/field-types.js';
import { resourceAllowed } from './resource/access.js';
import { renderFormFields } from './resource/render-form.js';
import type { Resource, ResourceListResult } from './resource/resource-descriptor.js';
import { assertAdminSlug } from './slug.js';

/** Context handed to a relation manager's `list` callback. */
export interface RelationManagerListContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The parent record's own record id (stringified from `recordId`). */
  readonly parentId: string;
  /** The current page (1-based). */
  readonly page: number;
  /** The number of rows per page. */
  readonly pageSize: number;
}

/** Context handed to a relation manager's `create` callback. */
export interface RelationManagerCreateContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The parent record's own record id (authorized through the parent's `update` gate). */
  readonly parentId: string;
  /**
   * Field values validated and coerced by the related resource's schema. When
   * the related resource declares the foreign key as a field, it holds the
   * parent id, never a client-chosen value.
   */
  readonly values: Record<string, unknown>;
}

/** Context handed to a relation manager's `delete` callback. */
export interface RelationManagerDeleteContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The parent record's own record id (authorized through the parent's `update` gate). */
  readonly parentId: string;
  /** The related record's id; the route has checked it belongs to `parentId`. */
  readonly relatedId: string;
}

/** Specification passed to {@link defineRelationManager}. */
export interface RelationManagerDefinition {
  /** Unique name within the parent resource's relation managers. */
  readonly name: string;
  /** Human label used as the table heading. */
  readonly label: string;
  /** The related resource descriptor (its columns drive the table markup). */
  readonly related: Resource;
  /** The foreign key column on the related table pointing back to the parent. */
  readonly foreignKey: string;
  /** Required: produce one page of related rows plus the total count. */
  readonly list: (context: RelationManagerListContext) => Promise<ResourceListResult>;
  /** Optional: create a new related record scoped to the parent. */
  readonly create?: (context: RelationManagerCreateContext) => Promise<void>;
  /** Optional: delete one related record. */
  readonly delete?: (context: RelationManagerDeleteContext) => Promise<void>;
}

/** A frozen, validated relation manager descriptor. */
export interface RelationManager {
  readonly name: string;
  readonly label: string;
  readonly related: Resource;
  readonly foreignKey: string;
  readonly list: (context: RelationManagerListContext) => Promise<ResourceListResult>;
  readonly create?: (context: RelationManagerCreateContext) => Promise<void>;
  readonly delete?: (context: RelationManagerDeleteContext) => Promise<void>;
}

/** Raise the relation manager's value-free definition error. */
function invalid(message: string): AdminDefinitionError {
  return new AdminDefinitionError('invalid_relation_manager', message);
}

/**
 * Validate a relation manager spec and return a frozen descriptor. The
 * callbacks are carried by identity; every other field is copied onto a
 * frozen object.
 */
export function defineRelationManager(spec: RelationManagerDefinition): RelationManager {
  if (!isRecord(spec)) {
    throw invalid('defineRelationManager requires a spec object');
  }
  assertAdminSlug(spec.name, { code: 'invalid_relation_manager', label: 'relation manager name' });
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    throw invalid('relation manager label must be a non-empty string');
  }
  if (typeof spec.foreignKey !== 'string' || spec.foreignKey.trim() === '') {
    throw invalid('relation manager foreignKey must be a non-empty string');
  }
  if (!hasShape(spec.related, RESOURCE_SHAPE)) {
    throw invalid('relation manager related must be a Resource descriptor');
  }
  if (typeof spec.list !== 'function') {
    throw invalid('relation manager must define a list function');
  }
  if (spec.create !== undefined && typeof spec.create !== 'function') {
    throw invalid('relation manager create must be a function when present');
  }
  if (spec.delete !== undefined && typeof spec.delete !== 'function') {
    throw invalid('relation manager delete must be a function when present');
  }
  return Object.freeze({
    name: spec.name,
    label: spec.label,
    related: spec.related,
    foreignKey: spec.foreignKey,
    list: spec.list,
    ...(spec.create === undefined ? {} : { create: spec.create }),
    ...(spec.delete === undefined ? {} : { delete: spec.delete }),
  });
}

/** Options for rendering a relation manager's forms with real routes. */
export interface RenderRelationManagerOptions {
  readonly panelPath: string;
  readonly resourceSlug: string;
  readonly csrfToken: string;
  /** Submitted create-form values to repopulate (a 422 re-render). */
  readonly createValues?: Record<string, string>;
  /** Per-field create-form errors to show (a 422 re-render). */
  readonly createErrors?: Record<string, string>;
  /** Whether the session may create here; `false` leaves the create form out. */
  readonly allowCreate?: boolean;
  /**
   * The ids of the rows the session may delete; a row outside the set gets no
   * delete button, and an empty set leaves the delete column out. Unset, every
   * row gets one.
   */
  readonly deletable?: ReadonlySet<string>;
}

/** The related fields a relation create form renders and accepts. */
export function relationCreateFields(manager: RelationManager): readonly ResourceField[] {
  return manager.related.fields.filter(
    (field) => field.name !== manager.foreignKey && field.type !== 'file',
  );
}

/** The id a related row is addressed by in the delete route. */
function rowId(row: Record<string, unknown>): string {
  return String(row['id'] ?? '');
}

/**
 * The create/delete affordances a session gets on one parent's manager: each
 * needs the parent's `update` gate and the related resource's own `create` or
 * `delete` gate, exactly what the create and delete routes enforce. The delete
 * gate is asked per row with that row's id, as the delete route asks it, so a
 * gate that decides per record shows exactly the buttons the route honours.
 */
export async function relationManagerAccess(
  manager: RelationManager,
  parent: Resource,
  session: Session,
  parentId: string,
  rows: readonly Record<string, unknown>[],
  report: AdminErrorSink,
): Promise<{ readonly allowCreate: boolean; readonly deletable: ReadonlySet<string> }> {
  const options = { report };
  const [parentUpdate, create] = await Promise.all([
    resourceAllowed(parent, session, 'update', parentId, options),
    manager.create === undefined
      ? false
      : resourceAllowed(manager.related, session, 'create', undefined, options),
  ]);
  const deletable = new Set<string>();
  if (parentUpdate && manager.delete !== undefined) {
    const ids = [...new Set(rows.map(rowId).filter((id) => id !== ''))];
    const allowed = await Promise.all(
      ids.map((id) => resourceAllowed(manager.related, session, 'delete', id, options)),
    );
    ids.forEach((id, index) => {
      if (allowed[index] === true) deletable.add(id);
    });
  }
  return { allowCreate: parentUpdate && create, deletable };
}

/**
 * Render a server-side table of related rows from the manager's related
 * resource columns, plus optional create/delete forms with real POST actions
 * and CSRF protection. Every cell value is rendered as a Preact text child so
 * escaping is owned by Preact.
 */
export function renderRelationManager(
  manager: RelationManager,
  rows: readonly Record<string, unknown>[],
  parentId: string,
  options: RenderRelationManagerOptions,
): string {
  const { related } = manager;
  const canDelete = (id: string): boolean =>
    manager.delete !== undefined && (options.deletable === undefined || options.deletable.has(id));
  const showDelete = rows.some((row) => canDelete(rowId(row)));
  const showCreate = manager.create !== undefined && options.allowCreate !== false;

  const headerCells: ComponentChild[] = related.columns.map((column) =>
    h('th', null, column.label),
  );
  if (showDelete) {
    headerCells.push(h('th', null, ''));
  }

  const bodyRows: ComponentChild[] = rows.map((row) => {
    const id = rowId(row);
    const cells: ComponentChild[] = related.columns.map((column) =>
      h('td', null, renderCellValue(column, row)),
    );
    if (showDelete) {
      cells.push(
        h('td', null, canDelete(id) ? renderDeleteForm(manager, parentId, id, options) : ''),
      );
    }
    return h('tr', null, ...cells);
  });

  const children: ComponentChild[] = [
    h('h3', null, manager.label),
    h(
      'table',
      null,
      h('thead', null, h('tr', null, ...headerCells)),
      h('tbody', null, ...bodyRows),
    ),
  ];

  if (showCreate) {
    children.push(renderCreateForm(manager, parentId, options));
  }

  return renderToString(h('div', { class: 'admin-relation-manager' }, ...children));
}

/** Render one cell value as escaped text. */
function renderCellValue(column: ResourceColumn, row: Record<string, unknown>): ComponentChild {
  const value = row[column.name];
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

/** Render a create form for adding a new related record. */
function renderCreateForm(
  manager: RelationManager,
  parentId: string,
  options: RenderRelationManagerOptions,
): ComponentChild {
  const action = `${options.panelPath}/${options.resourceSlug}/${manager.name}`;
  const state = {
    id: null,
    values: options.createValues ?? {},
    errors: options.createErrors ?? {},
    csrf: options.csrfToken,
    action,
    back: '',
  };
  return h(
    'form',
    {
      method: 'post',
      action,
      class: 'admin-relation-create',
    },
    csrfInput(options.csrfToken),
    hiddenInput('_parent', parentId),
    ...renderFormFields(relationCreateFields(manager), state, `relation-${manager.name}-`),
    h('button', { type: 'submit' }, `New ${manager.related.label}`),
  );
}

/** Render a delete button wrapped in a form for one related row. */
function renderDeleteForm(
  manager: RelationManager,
  parentId: string,
  relatedId: string,
  options: RenderRelationManagerOptions,
): ComponentChild {
  const action = `${options.panelPath}/${options.resourceSlug}/${manager.name}/${relatedId}/delete`;
  return h(
    'form',
    {
      method: 'post',
      action,
      class: 'admin-relation-delete',
    },
    csrfInput(options.csrfToken),
    hiddenInput('_parent', parentId),
    h('button', { type: 'submit' }, 'Delete'),
  );
}
