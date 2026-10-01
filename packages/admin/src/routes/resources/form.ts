/**
 * Admin resource form routes: the empty create form and the populated edit form
 * (`GET <slug>/new` and `GET <slug>/:id`).
 *
 * Both routes' access is the panel's session gate; the handlers run the resource's
 * own `authorize` (`create`/`view`), preserve the allowlisted table state, and
 * render the shared form page. The edit form resolves the record through the
 * trusted `get` callback (a throw is a 500 reported through the panel's
 * `onError`, `null`/absent `get` is a 404).
 * Markup is server-rendered through Preact, which owns all escaping.
 */

import type { Session } from 'jsails';
import type { RouteContext } from 'jsails/kernel';
import { DEFAULT_PAGE_SIZE } from 'jsails/api';

import { adminHtmlResponse } from '../../document.js';
import { reportAdminError } from '../../error-report.js';
import { admittedSession } from '../../guards.js';
import { listQuery, parseListState } from '../../list-query.js';
import type { AdminPanel } from '../../panel.js';
import { relationManagerAccess, renderRelationManager } from '../../relation-manager.js';
import { renderFormPage } from '../../resource/render-form.js';
import { resourceAllowed } from '../../resource/access.js';
import type { Resource } from '../../resource/index.js';
import {
  adminForbiddenResponse,
  adminNotFoundResponse,
  adminServerErrorResponse,
} from '../../responses.js';

/**
 * Render each inline relation manager for a record id into an HTML string
 * safe to embed. `renderRelationManager` server-renders the table through
 * Preact (escaping every cell), so its output — and only its output — is the
 * trusted source the form page injects. A manager whose related resource
 * denies the session `list` is left out, as is one whose `list` throws (a
 * related-row failure must not 500 the parent form); its create form and
 * delete buttons appear only where the related resource allows them.
 */
async function renderInlineManagers(
  panel: AdminPanel,
  resource: Resource,
  session: Session,
  parentId: string,
): Promise<readonly string[]> {
  const managers = resource.relationManagers ?? [];
  if (managers.length === 0) {
    return [];
  }
  const rendered: string[] = [];
  for (const manager of managers) {
    if (!(await resourceAllowed(manager.related, session, 'list', undefined, { report: panel }))) {
      continue;
    }
    try {
      const result = await manager.list({
        session,
        parentId,
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
      });
      const access = await relationManagerAccess(
        manager,
        resource,
        session,
        parentId,
        result.rows,
        panel,
      );
      rendered.push(
        renderRelationManager(manager, result.rows, parentId, {
          panelPath: panel.path,
          resourceSlug: resource.slug,
          ...access,
        }),
      );
    } catch (error) {
      // A single manager's list failure is isolated: the parent form still
      // renders, and the offending manager is dropped rather than surfacing a
      // raw callback error to the admin. The operator still hears about it.
      reportAdminError(panel, error, {
        surface: 'relation',
        slug: manager.name,
        operation: 'list',
      });
    }
  }
  return rendered;
}

/** GET <slug>/new: the empty create form, preserving any table state. */
export async function handleCreateForm(
  panel: AdminPanel,
  resource: Resource,
  context: RouteContext,
): Promise<Response> {
  const session = await admittedSession(panel, context);
  if (!(await resourceAllowed(resource, session, 'create', undefined, { report: panel }))) {
    return adminForbiddenResponse();
  }
  const state = parseListState(context.url, resource);
  return adminHtmlResponse(
    renderFormPage(panel, resource, {
      id: null,
      values: {},
      errors: {},
      action: `${panel.path}/${resource.slug}`,
      back: listQuery(state),
    }),
    200,
  );
}

/** GET <slug>/:id: the edit form populated from `get`, preserving table state. */
export async function handleEditForm(
  panel: AdminPanel,
  resource: Resource,
  context: RouteContext,
): Promise<Response> {
  const session = await admittedSession(panel, context);
  const id = context.params['id'];
  if (id === undefined) {
    return adminNotFoundResponse();
  }
  if (!(await resourceAllowed(resource, session, 'view', id, { report: panel }))) {
    return adminForbiddenResponse();
  }
  const get = resource.get;
  if (get === undefined) {
    return adminNotFoundResponse();
  }
  let record;
  try {
    record = await get({ session, id });
  } catch (error) {
    reportAdminError(panel, error, { surface: 'resource', slug: resource.slug, operation: 'get' });
    return adminServerErrorResponse();
  }
  if (record === null) {
    return adminNotFoundResponse();
  }
  const state = parseListState(context.url, resource);
  const relationManagerHtml = await renderInlineManagers(panel, resource, session, id);
  return adminHtmlResponse(
    renderFormPage(panel, resource, {
      id,
      record,
      values: {},
      errors: {},
      action: `${panel.path}/${resource.slug}/${id}`,
      back: listQuery(state),
      relationManagerHtml,
    }),
    200,
  );
}
