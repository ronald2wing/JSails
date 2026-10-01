/**
 * Admin relation manager routes: the HTTP surface for inline related-record
 * CRUD mounted under each resource's route prefix.
 *
 * `registerRelationManagerRoutes(app, panel, resource, manager)` mounts:
 *
 * - `GET  <resourceRoot>/<name>?parent=<parentId>` — the list table;
 * - `POST <resourceRoot>/<name>` — create (only when `manager.create` is set);
 * - `POST <resourceRoot>/<name>/<relatedId>/delete` — delete (only when
 *   `manager.delete` is set).
 *
 * Every route runs the shared default-deny auth gate (`assertAdminSession`),
 * and every POST enforces same-origin + constant-time CSRF (`_csrf` field).
 * A missing or denying session returns 403; a missing callback returns 405
 * ("read-only" in the message); a callback that throws returns 500.
 */

import type { Context, Hono } from 'hono';
import type { AppEnv } from 'jsails';

import { adminHtmlResponse, adminRedirectResponse } from '../document.js';
import { stripFormMarkers } from '../forms.js';
import { assertAdminMutation, assertAdminSession, readFormBody } from '../guards.js';
import { readPagination } from '../list-query.js';
import type { AdminPanel } from '../panel.js';
import {
  renderRelationManager,
  type RelationManager,
  type RenderRelationManagerOptions,
} from '../relation-manager.js';
import { resourceAllowed } from '../resource/access.js';
import type { Resource } from '../resource/index.js';
import {
  adminBadRequestResponse,
  adminForbiddenResponse,
  adminMethodNotAllowedResponse,
  adminServerErrorResponse,
} from '../responses.js';

/** Validate a non-empty id parameter; returns the id or a 400 Response. */
function requireNonEmpty(value: string | undefined): string | Response {
  return value === undefined || value.trim() === '' ? adminBadRequestResponse() : value;
}

/**
 * Register the relation manager's list, create, and delete routes under the
 * parent resource's route prefix.
 */
export function registerRelationManagerRoutes(
  app: Hono<AppEnv>,
  panel: AdminPanel,
  resource: Resource,
  manager: RelationManager,
): void {
  const root = `${panel.path}/${resource.slug}/${manager.name}`;

  app.get(root, async (c) => handleList(panel, resource, manager, c));

  if (manager.create !== undefined) {
    app.post(root, async (c) => handleCreate(panel, resource, manager, c));
  }

  if (manager.delete !== undefined) {
    app.post(`${root}/:relatedId/delete`, async (c) => handleDelete(panel, resource, manager, c));
  }
}

async function handleList(
  panel: AdminPanel,
  resource: Resource,
  manager: RelationManager,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return adminForbiddenResponse();
  }
  if (!(await resourceAllowed(resource, session, 'list'))) {
    return adminForbiddenResponse();
  }

  const url = new URL(c.req.raw.url);
  const parentId = requireNonEmpty(url.searchParams.get('parent') ?? undefined);
  if (typeof parentId !== 'string') {
    return parentId;
  }
  // The parent record's own `view` gate decides whether its children may be read.
  if (!(await resourceAllowed(resource, session, 'view', parentId))) {
    return adminForbiddenResponse();
  }

  let result;
  try {
    result = await manager.list({ session, parentId, ...readPagination(url) });
  } catch {
    return adminServerErrorResponse();
  }

  const options: RenderRelationManagerOptions = {
    panelPath: panel.path,
    resourceSlug: resource.slug,
    csrfToken: session.csrfToken,
  };
  const html = renderRelationManager(manager, result.rows, parentId, options);
  return adminHtmlResponse(html, 200);
}

async function handleCreate(
  panel: AdminPanel,
  resource: Resource,
  manager: RelationManager,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return adminForbiddenResponse();
  }
  const body = await readFormBody(c.req.raw);
  if (!assertAdminMutation(c.req.raw, session, body)) {
    return adminForbiddenResponse();
  }

  const parentId = requireNonEmpty(body['_parent']);
  if (typeof parentId !== 'string') {
    return parentId;
  }
  // Per-record scoping: the session must be allowed to update this parent.
  if (!(await resourceAllowed(resource, session, 'update', parentId))) {
    return adminForbiddenResponse();
  }

  const create = manager.create;
  if (create === undefined) {
    return adminMethodNotAllowedResponse('This relation manager does not accept creates.');
  }

  const values = stripFormMarkers(body);
  try {
    await create({ session, parentId, values });
  } catch {
    return adminServerErrorResponse();
  }

  return adminRedirectResponse(
    `${panel.path}/${resource.slug}/${manager.name}?parent=${encodeURIComponent(parentId)}`,
  );
}

async function handleDelete(
  panel: AdminPanel,
  resource: Resource,
  manager: RelationManager,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return adminForbiddenResponse();
  }
  const relatedId = requireNonEmpty(c.req.param('relatedId'));
  if (typeof relatedId !== 'string') {
    return relatedId;
  }

  const body = await readFormBody(c.req.raw);
  if (!assertAdminMutation(c.req.raw, session, body)) {
    return adminForbiddenResponse();
  }

  const parentId = requireNonEmpty(body['_parent']);
  if (typeof parentId !== 'string') {
    return parentId;
  }
  // Per-record scoping: the session must be allowed to update this parent.
  if (!(await resourceAllowed(resource, session, 'update', parentId))) {
    return adminForbiddenResponse();
  }

  const del = manager.delete;
  if (del === undefined) {
    return adminMethodNotAllowedResponse('This relation manager does not accept deletes.');
  }

  try {
    await del({ session, parentId, relatedId });
  } catch {
    return adminServerErrorResponse();
  }

  return adminRedirectResponse(
    `${panel.path}/${resource.slug}/${manager.name}?parent=${encodeURIComponent(parentId)}`,
  );
}
