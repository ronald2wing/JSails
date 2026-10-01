/**
 * Admin action routes: the confirm-then-run HTTP surface for a resource's
 * header, row, and bulk actions.
 *
 * `registerActionRoutes(app, panel, resource)` mounts, under the resource root:
 *
 * - `GET/POST <slug>/actions/:actionName` — a collection-level (header/bulk)
 *   action's server-rendered confirm page and its CSRF/origin-checked run;
 * - `GET/POST <slug>/:id/actions/:actionName` — a row action's confirm page and
 *   run.
 *
 * A confirm page resolves the target records (a bulk action de-duplicates and
 * drops unknown ids through `get`; a row action fetches the single record),
 * filters them through the action's per-record `authorize` (default-allow), and
 * renders a summary plus a POST form carrying a hidden CSRF token, the resolved
 * record ids, the canonicalized `_back` table state, and, for an action that
 * declares `requiresParent`, the `?parent=` id as `_parent` (a missing parent
 * is a 400 on both the confirm page and the run). On success the run
 * redirects (303) to the list with a `?_notice=<code>` flash mapped through the
 * notice registry (unknown codes are dropped). Actions run the shared
 * default-deny auth gate first, exactly like every other admin route.
 */

import type { Context, Hono } from 'hono';
import type { AppEnv, Session } from 'jsails';
import { h, type ComponentChild } from 'preact';

import type { AdminAction } from '../actions.js';
import {
  adminHtmlResponse,
  adminRedirectResponse,
  panelDocumentOptions,
  renderAdminDocumentWithTheme,
} from '../document.js';
import { csrfInput, hiddenInput } from '../forms.js';
import { assertAdminMutation, assertAdminSession, readFormBody } from '../guards.js';
import {
  buildListQuery,
  canonicalizeBack,
  listQuery,
  parseListState,
  readBulkIds,
  type ListState,
} from '../list-query.js';
import { ADMIN_ACTION_SUCCESS_CODE } from '../notices.js';
import type { AdminPanel } from '../panel.js';
import { recordId, resourceAllowed } from '../resource/access.js';
import type { Resource } from '../resource/index.js';
import {
  adminBadRequestResponse,
  adminForbiddenResponse,
  adminNotFoundResponse,
  adminServerErrorResponse,
} from '../responses.js';

/** Maximum records a bulk action may target in one request. */
const MAX_BULK_IDS = 100;

/** The kind of a resource action, resolved from its `actions` object. */
type ActionKind = 'header' | 'row' | 'bulk';

/** A resolved action plus the kind it was declared under. */
interface LocatedAction {
  readonly kind: ActionKind;
  readonly action: AdminAction;
}

/** Register the header/bulk (collection) and row action routes for a resource. */
export function registerActionRoutes(
  app: Hono<AppEnv>,
  panel: AdminPanel,
  resource: Resource,
): void {
  const root = `${panel.path}/${resource.slug}`;
  app.get(`${root}/actions/:actionName`, (c) => handleCollectionActionConfirm(panel, resource, c));
  app.post(`${root}/actions/:actionName`, (c) => handleCollectionActionRun(panel, resource, c));
  app.get(`${root}/:id/actions/:actionName`, (c) => handleRowActionConfirm(panel, resource, c));
  app.post(`${root}/:id/actions/:actionName`, (c) => handleRowActionRun(panel, resource, c));
}

/** The inputs of one confirm page render. */
interface ConfirmPage {
  readonly panel: AdminPanel;
  readonly resource: Resource;
  readonly action: AdminAction;
  readonly session: Session;
  readonly state: ListState;
  readonly records: readonly Record<string, unknown>[];
  /** The URL the confirm form posts to (the row route carries the record id). */
  readonly formAction: string;
  /** The parent id carried as `_parent`, when the action requires one. */
  readonly parentId?: string;
}

/** The inputs of one action run. */
interface ActionRun {
  readonly panel: AdminPanel;
  readonly resource: Resource;
  readonly action: AdminAction;
  readonly session: Session;
  readonly records: readonly Record<string, unknown>[];
  /** The submitted form body (`_back`, `_parent`). */
  readonly body: Record<string, string>;
}

/**
 * The parent id an action runs under: `undefined` when the action does not
 * need one, the non-empty value otherwise, or a 400 when it is required and
 * absent.
 */
function requireParent(
  action: AdminAction,
  raw: string | null | undefined,
): string | undefined | Response {
  if (action.requiresParent !== true) return undefined;
  if (raw === null || raw === undefined || raw.trim() === '') return adminBadRequestResponse();
  return raw;
}

/** GET <slug>/actions/:name: confirm a header or bulk action. */
async function handleCollectionActionConfirm(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) return adminForbiddenResponse();
  if (!(await resourceAllowed(resource, session, 'list'))) return adminForbiddenResponse();

  const name = c.req.param('actionName');
  if (name === undefined) return adminNotFoundResponse();
  const located = locateAction(resource, name);
  if (located === undefined || located.kind === 'row') return adminNotFoundResponse();

  const url = new URL(c.req.raw.url);
  const state = parseListState(url, resource);
  const parentId = requireParent(located.action, url.searchParams.get('parent'));
  if (parentId instanceof Response) return parentId;
  const page = {
    panel,
    resource,
    action: located.action,
    session,
    state,
    formAction: `${panel.path}/${resource.slug}/actions/${located.action.name}`,
    ...(parentId === undefined ? {} : { parentId }),
  };

  if (located.kind === 'header') {
    return adminHtmlResponse(renderActionConfirmPage({ ...page, records: [] }), 200);
  }

  // Bulk: resolve the selected ids through `get`, dropping unknown records.
  const get = resource.get;
  if (get === undefined) return adminNotFoundResponse();
  const records = await resolveRecords(resource, get, session, readBulkIds(url), located.action);
  return adminHtmlResponse(renderActionConfirmPage({ ...page, records }), 200);
}

/** POST <slug>/actions/:name: run a header or bulk action. */
async function handleCollectionActionRun(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) return adminForbiddenResponse();
  if (!(await resourceAllowed(resource, session, 'list'))) return adminForbiddenResponse();

  const name = c.req.param('actionName');
  if (name === undefined) return adminNotFoundResponse();
  const located = locateAction(resource, name);
  if (located === undefined || located.kind === 'row') return adminNotFoundResponse();

  const body = await readFormBody(c.req.raw);
  if (!assertAdminMutation(c.req.raw, session, body)) return adminForbiddenResponse();

  let records: readonly Record<string, unknown>[] = [];
  if (located.kind === 'bulk') {
    const get = resource.get;
    if (get === undefined) return adminNotFoundResponse();
    const ids = body['ids'] === undefined ? [] : body['ids'].split(',');
    records = await resolveRecords(resource, get, session, ids, located.action);
  }
  return runAction({ panel, resource, action: located.action, session, records, body });
}

/** GET <slug>/:id/actions/:name: confirm a row action. */
async function handleRowActionConfirm(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) return adminForbiddenResponse();
  if (!(await resourceAllowed(resource, session, 'list'))) return adminForbiddenResponse();

  const name = c.req.param('actionName');
  if (name === undefined) return adminNotFoundResponse();
  const located = locateAction(resource, name);
  if (located === undefined || located.kind !== 'row') return adminNotFoundResponse();

  const id = c.req.param('id');
  if (id === undefined) return adminNotFoundResponse();
  const get = resource.get;
  if (get === undefined) return adminNotFoundResponse();

  let record;
  try {
    record = await get({ session, id });
  } catch {
    return adminServerErrorResponse();
  }
  if (record === null) return adminNotFoundResponse();

  if (!(await resourceAllowed(resource, session, 'update', id))) return adminForbiddenResponse();

  const url = new URL(c.req.raw.url);
  const state = parseListState(url, resource);
  const parentId = requireParent(located.action, url.searchParams.get('parent'));
  if (parentId instanceof Response) return parentId;
  const records = await authorizeRecords(located.action, session, [record]);
  return adminHtmlResponse(
    renderActionConfirmPage({
      panel,
      resource,
      action: located.action,
      session,
      state,
      records,
      formAction: `${panel.path}/${resource.slug}/${encodeURIComponent(id)}/actions/${located.action.name}`,
      ...(parentId === undefined ? {} : { parentId }),
    }),
    200,
  );
}

/** POST <slug>/:id/actions/:name: run a row action. */
async function handleRowActionRun(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) return adminForbiddenResponse();
  if (!(await resourceAllowed(resource, session, 'list'))) return adminForbiddenResponse();

  const name = c.req.param('actionName');
  if (name === undefined) return adminNotFoundResponse();
  const located = locateAction(resource, name);
  if (located === undefined || located.kind !== 'row') return adminNotFoundResponse();

  const id = c.req.param('id');
  if (id === undefined) return adminNotFoundResponse();
  const get = resource.get;
  if (get === undefined) return adminNotFoundResponse();

  const body = await readFormBody(c.req.raw);
  if (!assertAdminMutation(c.req.raw, session, body)) return adminForbiddenResponse();

  let record;
  try {
    record = await get({ session, id });
  } catch {
    return adminServerErrorResponse();
  }
  if (record === null) return adminNotFoundResponse();
  // A row action mutates its record, so the resource's per-record `update`
  // gate applies in addition to the action's own optional `authorize`.
  if (!(await resourceAllowed(resource, session, 'update', id))) return adminForbiddenResponse();

  const records = await authorizeRecords(located.action, session, [record]);
  return runAction({ panel, resource, action: located.action, session, records, body });
}

/** Resolve + authorize a set of record ids for a bulk action. */
async function resolveRecords(
  resource: Resource,
  get: (context: { session: Session; id: string }) => Promise<Record<string, unknown> | null>,
  session: Session,
  ids: readonly string[],
  action: AdminAction,
): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for (const id of ids.slice(0, MAX_BULK_IDS)) {
    // Each targeted record passes the resource's per-record `update` gate;
    // ids the session may not touch are silently left out of the batch.
    if (!(await resourceAllowed(resource, session, 'update', id))) continue;
    let record;
    try {
      record = await get({ session, id });
    } catch {
      continue;
    }
    if (record !== null) records.push(record);
  }
  return authorizeRecords(action, session, records);
}

/** Filter records through the action's per-record `authorize` (default-allow). */
async function authorizeRecords(
  action: AdminAction,
  session: Session,
  records: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (action.authorize === undefined) return [...records];
  const authorized: Record<string, unknown>[] = [];
  for (const record of records) {
    try {
      if ((await action.authorize({ session, record })) === true) authorized.push(record);
    } catch {
      // Deny on throw, exactly like every other default-deny gate.
    }
  }
  return authorized;
}

/** Run a resolved action and 303-redirect to the list with a success notice. */
async function runAction(run: ActionRun): Promise<Response> {
  const { panel, resource, action, session, records, body } = run;
  const parentId = requireParent(action, body['_parent']);
  if (parentId instanceof Response) return parentId;
  try {
    await action.run(
      { session, path: panel.path, ...(parentId === undefined ? {} : { parentId }) },
      records,
    );
  } catch {
    return adminServerErrorResponse();
  }
  const query = canonicalizeBack(body['_back'], resource);
  const notice = action.notice ?? ADMIN_ACTION_SUCCESS_CODE;
  const separator = query === '' ? '' : `&`;
  const suffix = `_notice=${encodeURIComponent(notice)}`;
  return adminRedirectResponse(
    `${panel.path}/${resource.slug}${query === '' ? `?${suffix}` : `?${query}${separator}${suffix}`}`,
  );
}

/** Locate an action by name across header/row/bulk (names are unique). */
function locateAction(resource: Resource, name: string): LocatedAction | undefined {
  for (const kind of ['header', 'row', 'bulk'] as const) {
    const found = (resource.actions?.[kind] ?? []).find((action) => action.name === name);
    if (found !== undefined) {
      return { kind, action: found };
    }
  }
  return undefined;
}

/** The action confirm page: a summary plus a POST form (CSRF + hidden records). */
function renderActionConfirmPage(page: ConfirmPage): string {
  const { panel, resource, action, session, state, records } = page;
  const root = `${panel.path}/${resource.slug}`;
  const summary =
    records.length === 0
      ? null
      : h(
          'p',
          null,
          `This will affect ${records.length} record${records.length === 1 ? '' : 's'}.`,
        );
  const children: ComponentChild[] = [h('h1', null, action.label)];
  if (action.confirm !== undefined) {
    children.push(h('p', null, action.confirm));
  }
  if (summary !== null) {
    children.push(summary);
  }
  children.push(
    h(
      'form',
      { method: 'post', action: page.formAction },
      csrfInput(session.csrfToken),
      ...(records.length === 0
        ? []
        : [hiddenInput('ids', records.map(recordId).filter(Boolean).join(','))]),
      ...(listQuery(state) === '' ? [] : [hiddenInput('_back', listQuery(state))]),
      ...(page.parentId === undefined ? [] : [hiddenInput('_parent', page.parentId)]),
      h('button', { type: 'submit' }, 'Confirm'),
    ),
    h('a', { href: `${root}${buildListQuery(state)}` }, 'Cancel'),
  );
  return renderAdminDocumentWithTheme(
    panelDocumentOptions(panel, `${panel.title} - ${action.label}`),
    ...children,
  );
}
