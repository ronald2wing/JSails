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
 * Besides the parent resource's gates, each route needs the related
 * resource's own: `list` for the table, `create` for a create, and `delete`
 * (with the related id) for a delete.
 * A missing or denying session returns 403; a missing callback returns 405
 * ("read-only" in the message); a callback that throws returns 500 and is
 * reported through the panel's `onError`.
 *
 * Create parses the submission through a strict schema built from the fields
 * the create form renders (a failure re-renders the manager with field errors,
 * 422); the foreign key is always the authorized parent id, never a submitted
 * value. A repeater add/remove button re-renders the form (200) without
 * creating anything. Delete checks
 * that the related record exists (`related.get`) and that its foreign key is
 * the posted parent id before `delete` runs, so an editor of one parent cannot
 * delete another parent's children; without `related.get` membership cannot
 * be proven and the delete is refused.
 */

import type { Context, Hono } from 'hono';
import type { AppEnv, Session } from 'jsails';

import type { z, ZodError } from 'zod';

import { adminHtmlResponse, adminRedirectResponse } from '../document.js';
import { reportAdminError } from '../error-report.js';
import { stripFormMarkers } from '../forms.js';
import { assertAdminMutation, assertAdminSession, readFormBody } from '../guards.js';
import { readPagination } from '../list-query.js';
import type { AdminPanel } from '../panel.js';
import {
  relationCreateFields,
  relationManagerAccess,
  renderRelationManager,
  type RelationManager,
  type RenderRelationManagerOptions,
} from '../relation-manager.js';
import { resourceAllowed } from '../resource/access.js';
import { buildSchema } from '../resource/field-schemas.js';
import { applyRepeaterIntent, detectRepeaterIntent } from '../resource/repeater-intent.js';
import type { Resource } from '../resource/index.js';
import {
  adminBadRequestResponse,
  adminForbiddenResponse,
  adminMethodNotAllowedResponse,
  adminNotFoundResponse,
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
    const schema = relationCreateSchema(manager);
    app.post(root, async (c) => handleCreate(panel, resource, manager, schema, c));
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
  if (!(await resourceAllowed(resource, session, 'list', undefined, { report: panel }))) {
    return adminForbiddenResponse();
  }

  const url = new URL(c.req.raw.url);
  const parentId = requireNonEmpty(url.searchParams.get('parent') ?? undefined);
  if (typeof parentId !== 'string') {
    return parentId;
  }
  // The parent record's own `view` gate decides whether its children may be
  // read, and the related resource's `list` gate whether its rows may be.
  if (
    !(await resourceAllowed(resource, session, 'view', parentId, { report: panel })) ||
    !(await resourceAllowed(manager.related, session, 'list', undefined, { report: panel }))
  ) {
    return adminForbiddenResponse();
  }

  let result;
  try {
    result = await manager.list({ session, parentId, ...readPagination(url) });
  } catch (error) {
    reportAdminError(panel, error, { surface: 'relation', slug: manager.name, operation: 'list' });
    return adminServerErrorResponse();
  }

  const options: RenderRelationManagerOptions = {
    panelPath: panel.path,
    resourceSlug: resource.slug,
    csrfToken: session.csrfToken,
    ...(await relationManagerAccess(manager, resource, session, parentId, result.rows, panel)),
  };
  const html = renderRelationManager(manager, result.rows, parentId, options);
  return adminHtmlResponse(html, 200);
}

/**
 * The schema a relation create is validated against: only the fields the
 * create form accepts, plus the foreign key when the related resource declares
 * it. A related field the form deliberately leaves out (a required `file`
 * field, say) therefore cannot fail every create.
 */
function relationCreateSchema(manager: RelationManager): z.ZodType<Record<string, unknown>> {
  const foreignKey = manager.related.fields.find((field) => field.name === manager.foreignKey);
  return buildSchema([
    ...relationCreateFields(manager),
    ...(foreignKey === undefined ? [] : [foreignKey]),
  ]);
}

async function handleCreate(
  panel: AdminPanel,
  resource: Resource,
  manager: RelationManager,
  schema: z.ZodType<Record<string, unknown>>,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return adminForbiddenResponse();
  }
  const body = await readFormBody(c.req.raw);
  if (!assertAdminMutation(c, session, body)) {
    return adminForbiddenResponse();
  }

  const parentId = requireNonEmpty(body['_parent']);
  if (typeof parentId !== 'string') {
    return parentId;
  }
  // Per-record scoping: the session must be allowed to update this parent and
  // to create a record of the related resource.
  if (
    !(await resourceAllowed(resource, session, 'update', parentId, { report: panel })) ||
    !(await resourceAllowed(manager.related, session, 'create', undefined, { report: panel }))
  ) {
    return adminForbiddenResponse();
  }

  const create = manager.create;
  if (create === undefined) {
    return adminMethodNotAllowedResponse('This relation manager does not accept creates.');
  }

  // Only the fields the create form renders are accepted from the client; the
  // foreign key, when the related resource declares it, is the parent id.
  const submitted = stripFormMarkers(body);
  const accepted = new Set(relationCreateFields(manager).map((field) => field.name));
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(submitted)) {
    if (accepted.has(key) || isRepeaterItemKeyOf(accepted, key)) input[key] = value;
  }
  // A submitted foreign key is ignored rather than refused: the parent id
  // replaces it below. Any other key the form does not render is refused.
  const unknown = Object.keys(submitted).some(
    (key) =>
      key !== manager.foreignKey && !accepted.has(key) && !isRepeaterItemKeyOf(accepted, key),
  );
  const renderOptions = {
    panelPath: panel.path,
    resourceSlug: resource.slug,
    csrfToken: session.csrfToken,
    deletable: new Set<string>(),
  };

  // A repeater add/remove button submits the form: apply the intent and
  // re-render it (200) instead of creating a record.
  const intent = detectRepeaterIntent(manager.related, body);
  if (intent !== undefined && accepted.has(intent.field)) {
    return adminHtmlResponse(
      renderRelationManager(manager, [], parentId, {
        ...renderOptions,
        createValues: applyRepeaterIntent(manager.related, intent, input),
        createErrors: {},
      }),
      200,
    );
  }

  const values: Record<string, string> = { ...input };
  if (manager.related.fields.some((field) => field.name === manager.foreignKey)) {
    values[manager.foreignKey] = parentId;
  }
  const parsed = schema.safeParse(values);
  if (!parsed.success || unknown) {
    return adminHtmlResponse(
      renderRelationManager(manager, [], parentId, {
        ...renderOptions,
        createValues: input,
        createErrors: parsed.success ? {} : relationFieldErrors(parsed.error),
      }),
      422,
    );
  }

  try {
    await create({ session, parentId, values: parsed.data });
  } catch (error) {
    reportAdminError(panel, error, {
      surface: 'relation',
      slug: manager.name,
      operation: 'create',
    });
    return adminServerErrorResponse();
  }

  return adminRedirectResponse(
    `${panel.path}/${resource.slug}/${manager.name}?parent=${encodeURIComponent(parentId)}`,
  );
}

/** Whether `key` is a flat repeater item key (`name[i].sub`) of an accepted field. */
function isRepeaterItemKeyOf(accepted: ReadonlySet<string>, key: string): boolean {
  const open = key.indexOf('[');
  return open > 0 && accepted.has(key.slice(0, open));
}

/** One value-free message per invalid field, keyed by its dotted path. */
function relationFieldErrors(error: ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.map(String).join('.');
    if (path !== '' && !(path in errors)) {
      errors[path] = 'Invalid value';
    }
  }
  return errors;
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
  if (!assertAdminMutation(c, session, body)) {
    return adminForbiddenResponse();
  }

  const parentId = requireNonEmpty(body['_parent']);
  if (typeof parentId !== 'string') {
    return parentId;
  }
  // Per-record scoping: the session must be allowed to update this parent and
  // to delete this record of the related resource.
  if (
    !(await resourceAllowed(resource, session, 'update', parentId, { report: panel })) ||
    !(await resourceAllowed(manager.related, session, 'delete', relatedId, { report: panel }))
  ) {
    return adminForbiddenResponse();
  }

  const del = manager.delete;
  if (del === undefined) {
    return adminMethodNotAllowedResponse('This relation manager does not accept deletes.');
  }

  const membership = await relatedBelongsToParent(panel, manager, session, relatedId, parentId);
  if (membership !== true) {
    return membership;
  }

  try {
    await del({ session, parentId, relatedId });
  } catch (error) {
    reportAdminError(panel, error, {
      surface: 'relation',
      slug: manager.name,
      operation: 'delete',
    });
    return adminServerErrorResponse();
  }

  return adminRedirectResponse(
    `${panel.path}/${resource.slug}/${manager.name}?parent=${encodeURIComponent(parentId)}`,
  );
}

/**
 * Prove the related record belongs to the parent: it must exist and its
 * foreign key must equal the parent id. Without `related.get` nothing can be
 * proven, so the request is refused (403); an unknown record is a 404 and a
 * record of another parent a 403.
 */
async function relatedBelongsToParent(
  panel: AdminPanel,
  manager: RelationManager,
  session: Session,
  relatedId: string,
  parentId: string,
): Promise<true | Response> {
  const get = manager.related.get;
  if (get === undefined) {
    return adminForbiddenResponse();
  }
  let record: Record<string, unknown> | null;
  try {
    record = await get({ session, id: relatedId });
  } catch (error) {
    reportAdminError(panel, error, { surface: 'relation', slug: manager.name, operation: 'get' });
    return adminServerErrorResponse();
  }
  if (record === null) {
    return adminNotFoundResponse();
  }
  const owner = record[manager.foreignKey];
  return owner !== undefined && owner !== null && String(owner) === parentId
    ? true
    : adminForbiddenResponse();
}
