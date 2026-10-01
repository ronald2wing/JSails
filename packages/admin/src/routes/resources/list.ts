/**
 * Admin resource list route: the sortable, filterable, searchable, paginated
 * list table (`GET <slug>`).
 *
 * The route's access is the panel's session gate; the handler runs the resource's
 * own `authorize` (deny when absent; exact `true` when present), parses
 * the allowlisted list-table state, invokes the trusted `list` callback, and
 * renders the list page. Markup is server-rendered through Preact, which owns
 * all escaping.
 */

import type { RouteContext } from 'jsails/kernel';

import { adminHtmlResponse } from '../../document.js';
import { reportAdminError } from '../../error-report.js';
import { admittedSession } from '../../guards.js';
import { parseListState } from '../../list-query.js';
import type { AdminPanel } from '../../panel.js';
import { renderListPage, visibleColumns } from '../../resource/render-list.js';
import { readNotice } from '../../notices.js';
import { resourceAllowed } from '../../resource/access.js';
import type { Resource, ResourceListContext } from '../../resource/index.js';
import { adminForbiddenResponse, adminServerErrorResponse } from '../../responses.js';

/** GET <slug>: the sortable, filterable, searchable, paginated list table. */
export async function handleList(
  panel: AdminPanel,
  resource: Resource,
  context: RouteContext,
): Promise<Response> {
  const session = await admittedSession(panel, context);
  if (!(await resourceAllowed(resource, session, 'list', undefined, { report: panel }))) {
    return adminForbiddenResponse();
  }
  const state = parseListState(context.url, resource);
  const query: ResourceListContext = {
    session,
    page: state.page,
    pageSize: state.pageSize,
    ...(state.sort !== undefined ? { sort: state.sort, direction: state.direction } : {}),
    ...(state.search !== undefined ? { search: state.search } : {}),
    ...(Object.keys(state.filters).length > 0 ? { filters: state.filters } : {}),
  };
  let result;
  try {
    result = await resource.list(query);
  } catch (error) {
    reportAdminError(panel, error, { surface: 'resource', slug: resource.slug, operation: 'list' });
    return adminServerErrorResponse();
  }
  const notice = readNotice(context.url, panel);
  const columns = await visibleColumns(panel, resource, session);
  return adminHtmlResponse(
    await renderListPage(panel, resource, columns, result, state, notice),
    200,
  );
}
