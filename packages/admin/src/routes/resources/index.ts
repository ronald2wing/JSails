/**
 * Admin resource routes: the CRUD HTTP surface for a resource descriptor.
 *
 * `registerResourceRoutes(registrar, resource, owners)` registers, under the resource
 * root (`<path>/<slug>`):
 *
 * - `GET <slug>` — the sortable, filterable, searchable, paginated list table;
 * - `GET <slug>/new`, `POST <slug>` — the empty create form and the create;
 * - `GET <slug>/:id`, `POST <slug>/:id` — the populated edit form and update.
 *
 * It also delegates the confirm-then-run action routes to
 * `registerActionRoutes` (`../actions.ts`) and the relation manager routes to
 * `registerRelationManagerRoutes` (`../relations.ts`). The handlers themselves
 * are split by surface: the list table (`list.ts`), the create/edit forms
 * (`form.ts`), and the create/update POST handlers (`crud.ts`). This module
 * only wires the routes in registration
 * order — `new` is registered before `:id` so the create form wins the `/new`
 * path.
 *
 * The create and update routes read a form as large as the resource's file
 * fields accept ({@link resourceFormBytes}): each file field's `maxBytes`
 * (10 MiB unless stated), a formset's once per row it may hold, summed, plus
 * room for the multipart framing and
 * the other fields, never under the panel's 1 MiB default nor over the
 * framework's 100 MiB route ceiling.
 */

import { registerActionRoutes, type RelationOwners } from '../actions.js';
import { ADMIN_FORM_BYTES, type PanelRegistrar } from '../panel-registrar.js';
import { registerRelationManagerRoutes } from '../relations.js';
import {
  DEFAULT_MAX_REPEATER_ITEMS,
  DEFAULT_MAX_UPLOAD_BYTES,
} from '../../resource/field-types.js';
import type { Resource, ResourceField } from '../../resource/index.js';
import { handleCreate, handleUpdate } from './crud.js';
import { handleCreateForm, handleEditForm } from './form.js';
import { handleList } from './list.js';

/** Room a multipart form needs beyond its files' bytes: part headers and the other fields. */
const FORM_FRAMING_BYTES = 64 * 1024;

/** The framework's ceiling on a route's declared body. */
const MAX_FORM_BYTES = 100 * 1024 * 1024;

/** Register the list/new/create/edit/update routes, action routes, and relation manager routes. */
export function registerResourceRoutes(
  registrar: PanelRegistrar,
  resource: Resource,
  owners: RelationOwners = new Map(),
): void {
  const panel = registrar.panel;
  const root = `${panel.path}/${resource.slug}`;
  const form = { maxBodyBytes: resourceFormBytes(resource) };
  registrar.get(root, (context) => handleList(panel, resource, context));
  // `new` is registered before `:id` so the create form wins the `/new` path.
  registrar.get(`${root}/new`, (context) => handleCreateForm(panel, resource, context));
  registrar.post(root, (context) => handleCreate(panel, resource, context), form);
  // Relation manager routes (also before `:id` so a manager name does not
  // get captured as a record id).
  for (const manager of resource.relationManagers ?? []) {
    registerRelationManagerRoutes(registrar, resource, manager);
  }
  registrar.get(`${root}/:id`, (context) => handleEditForm(panel, resource, context));
  registrar.post(`${root}/:id`, (context) => handleUpdate(panel, resource, context), form);
  // Header/bulk action routes (collection-level) and row action routes.
  registerActionRoutes(registrar, resource, owners);
}

/**
 * The form cap of `resource`'s create and update routes: the bytes its file
 * fields accept (a formset's rows included), plus framing, within the panel's
 * default and the framework's ceiling.
 */
export function resourceFormBytes(resource: Resource): number {
  const files = fileBytes(resource.fields);
  if (files === 0) return ADMIN_FORM_BYTES;
  return Math.min(MAX_FORM_BYTES, Math.max(ADMIN_FORM_BYTES, files + FORM_FRAMING_BYTES));
}

/** The bytes the file fields among `fields` accept, a formset's rows included. */
function fileBytes(fields: readonly ResourceField[]): number {
  let total = 0;
  for (const field of fields) {
    if (field.type === 'file') total += field.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    if (field.formset !== undefined) {
      const rows = field.formset.maxItems ?? DEFAULT_MAX_REPEATER_ITEMS;
      total += rows * fileBytes(field.formset.fields);
    }
  }
  return total;
}
