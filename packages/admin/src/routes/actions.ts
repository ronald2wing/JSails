/**
 * Admin action routes: the confirm-then-run HTTP surface for a resource's
 * header, row, and bulk actions.
 *
 * `registerActionRoutes(app, panel, resource, owners)` mounts, under the resource root:
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
 *
 * Beyond the session gate, every confirm and run needs the resource's `list`
 * gate and its `action` gate for the action name (with the record id for a row
 * action); row and bulk records each need `update`. A row or bulk run left with
 * no authorized record is a 403, never a no-op success. A `requiresParent`
 * action's parent id is client input, so it must pass the parent resource's
 * `update` gate (and exist, when the parent has `get`); the parent resource is
 * the action's `parent`, else the single resource declaring its relation
 * manager, else the action is refused.
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
import { reportAdminError } from '../error-report.js';
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
import type { RelationManager } from '../relation-manager.js';
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

/**
 * Every resource that declares each relation manager, collected once over the
 * panel's resources. An attach/detach action without an explicit `parent`
 * authorizes its parent id against the single owner found here.
 */
export type RelationOwners = ReadonlyMap<RelationManager, readonly Resource[]>;

/** Index the panel's resources by the relation managers they declare. */
export function collectRelationOwners(resources: readonly Resource[]): RelationOwners {
  const owners = new Map<RelationManager, Resource[]>();
  for (const resource of resources) {
    for (const manager of resource.relationManagers ?? []) {
      const list = owners.get(manager) ?? [];
      list.push(resource);
      owners.set(manager, list);
    }
  }
  return owners;
}

/** The panel-wide inputs every action route shares. */
interface ActionScope {
  readonly panel: AdminPanel;
  readonly resource: Resource;
  readonly owners: RelationOwners;
}

/** Register the header/bulk (collection) and row action routes for a resource. */
export function registerActionRoutes(
  app: Hono<AppEnv>,
  panel: AdminPanel,
  resource: Resource,
  owners: RelationOwners = new Map(),
): void {
  const scope: ActionScope = { panel, resource, owners };
  const root = `${panel.path}/${resource.slug}`;
  app.get(`${root}/actions/:actionName`, (c) => handleCollectionActionConfirm(scope, c));
  app.post(`${root}/actions/:actionName`, (c) => handleCollectionActionRun(scope, c));
  app.get(`${root}/:id/actions/:actionName`, (c) => handleRowActionConfirm(scope, c));
  app.post(`${root}/:id/actions/:actionName`, (c) => handleRowActionRun(scope, c));
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
  /** The authorized parent id, when the action requires one. */
  readonly parentId: string | undefined;
  /** The submitted form body (`_back`). */
  readonly body: Record<string, string>;
}

/**
 * The parent id an action runs under: `undefined` when the action does not
 * need one; otherwise the id once it is present (400 when absent), its parent
 * resource is known and allows `update` on it (403 otherwise), and, when that
 * resource has `get`, the record exists (404 otherwise).
 */
async function authorizeParent(
  scope: ActionScope,
  action: AdminAction,
  session: Session,
  raw: string | null | undefined,
): Promise<string | undefined | Response> {
  if (action.requiresParent !== true) return undefined;
  if (raw === null || raw === undefined || raw.trim() === '') return adminBadRequestResponse();
  const parent = parentResource(scope, action);
  if (parent === undefined) return adminForbiddenResponse();
  const report = { report: scope.panel };
  if (!(await resourceAllowed(parent, session, 'update', raw, report))) {
    return adminForbiddenResponse();
  }
  if (parent.get !== undefined) {
    let record: Record<string, unknown> | null;
    try {
      record = await parent.get({ session, id: raw });
    } catch (error) {
      reportAdminError(scope.panel, error, {
        surface: 'resource',
        slug: parent.slug,
        operation: 'get',
      });
      return adminServerErrorResponse();
    }
    if (record === null) return adminNotFoundResponse();
  }
  return raw;
}

/** The resource a `requiresParent` action's parent id belongs to, when determinable. */
function parentResource(scope: ActionScope, action: AdminAction): Resource | undefined {
  if (action.parent !== undefined) return action.parent;
  if (action.relationManager === undefined) return undefined;
  const owners = scope.owners.get(action.relationManager) ?? [];
  // A manager shared by several resources leaves the parent table ambiguous.
  return owners.length === 1 ? owners[0] : undefined;
}

/** The `list` gate plus the `action` gate every confirm and run shares. */
async function actionAllowed(
  scope: ActionScope,
  session: Session,
  action: AdminAction,
  recordId?: string,
): Promise<boolean> {
  const { panel, resource } = scope;
  if (!(await resourceAllowed(resource, session, 'list', undefined, { report: panel }))) {
    return false;
  }
  return resourceAllowed(resource, session, 'action', recordId, {
    actionName: action.name,
    report: panel,
  });
}

/** GET <slug>/actions/:name: confirm a header or bulk action. */
async function handleCollectionActionConfirm(scope: ActionScope, c: Context): Promise<Response> {
  const { panel, resource } = scope;
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) return adminForbiddenResponse();

  const name = c.req.param('actionName');
  if (name === undefined) return adminNotFoundResponse();
  const located = locateAction(resource, name);
  if (located === undefined || located.kind === 'row') return adminNotFoundResponse();
  if (!(await actionAllowed(scope, session, located.action))) return adminForbiddenResponse();

  const url = new URL(c.req.raw.url);
  const state = parseListState(url, resource);
  const parentId = await authorizeParent(
    scope,
    located.action,
    session,
    url.searchParams.get('parent'),
  );
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
  const records = await resolveRecords(scope, get, session, readBulkIds(url), located.action);
  return adminHtmlResponse(renderActionConfirmPage({ ...page, records }), 200);
}

/** POST <slug>/actions/:name: run a header or bulk action. */
async function handleCollectionActionRun(scope: ActionScope, c: Context): Promise<Response> {
  const { panel, resource } = scope;
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) return adminForbiddenResponse();

  const name = c.req.param('actionName');
  if (name === undefined) return adminNotFoundResponse();
  const located = locateAction(resource, name);
  if (located === undefined || located.kind === 'row') return adminNotFoundResponse();
  if (!(await actionAllowed(scope, session, located.action))) return adminForbiddenResponse();

  const body = await readFormBody(c.req.raw);
  if (!assertAdminMutation(c, session, body)) return adminForbiddenResponse();
  const parentId = await authorizeParent(scope, located.action, session, body['_parent']);
  if (parentId instanceof Response) return parentId;

  let records: readonly Record<string, unknown>[] = [];
  if (located.kind === 'bulk') {
    const get = resource.get;
    if (get === undefined) return adminNotFoundResponse();
    const ids = body['ids'] === undefined ? [] : body['ids'].split(',');
    records = await resolveRecords(scope, get, session, ids, located.action);
    if (records.length === 0) return adminForbiddenResponse();
  }
  return runAction({ panel, resource, action: located.action, session, records, parentId, body });
}

/** GET <slug>/:id/actions/:name: confirm a row action. */
async function handleRowActionConfirm(scope: ActionScope, c: Context): Promise<Response> {
  const { panel, resource } = scope;
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) return adminForbiddenResponse();

  const name = c.req.param('actionName');
  if (name === undefined) return adminNotFoundResponse();
  const located = locateAction(resource, name);
  if (located === undefined || located.kind !== 'row') return adminNotFoundResponse();

  const id = c.req.param('id');
  if (id === undefined) return adminNotFoundResponse();
  const get = resource.get;
  if (get === undefined) return adminNotFoundResponse();
  if (!(await actionAllowed(scope, session, located.action, id))) return adminForbiddenResponse();

  const record = await fetchRecord(scope, get, session, id);
  if (record instanceof Response) return record;

  if (!(await resourceAllowed(resource, session, 'update', id, { report: panel }))) {
    return adminForbiddenResponse();
  }

  const url = new URL(c.req.raw.url);
  const state = parseListState(url, resource);
  const parentId = await authorizeParent(
    scope,
    located.action,
    session,
    url.searchParams.get('parent'),
  );
  if (parentId instanceof Response) return parentId;
  const records = await authorizeRecords(panel, located.action, session, [record]);
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
async function handleRowActionRun(scope: ActionScope, c: Context): Promise<Response> {
  const { panel, resource } = scope;
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) return adminForbiddenResponse();

  const name = c.req.param('actionName');
  if (name === undefined) return adminNotFoundResponse();
  const located = locateAction(resource, name);
  if (located === undefined || located.kind !== 'row') return adminNotFoundResponse();

  const id = c.req.param('id');
  if (id === undefined) return adminNotFoundResponse();
  const get = resource.get;
  if (get === undefined) return adminNotFoundResponse();
  if (!(await actionAllowed(scope, session, located.action, id))) return adminForbiddenResponse();

  const body = await readFormBody(c.req.raw);
  if (!assertAdminMutation(c, session, body)) return adminForbiddenResponse();

  const record = await fetchRecord(scope, get, session, id);
  if (record instanceof Response) return record;
  // A row action mutates its record, so the resource's per-record `update`
  // gate applies in addition to the action's own optional `authorize`.
  if (!(await resourceAllowed(resource, session, 'update', id, { report: panel }))) {
    return adminForbiddenResponse();
  }
  const parentId = await authorizeParent(scope, located.action, session, body['_parent']);
  if (parentId instanceof Response) return parentId;

  const records = await authorizeRecords(panel, located.action, session, [record]);
  if (records.length === 0) return adminForbiddenResponse();
  return runAction({ panel, resource, action: located.action, session, records, parentId, body });
}

/** The record getter a resource declares. */
type RecordGetter = NonNullable<Resource['get']>;

/** Fetch one record: a throw is a reported 500, an unknown id a 404. */
async function fetchRecord(
  scope: ActionScope,
  get: RecordGetter,
  session: Session,
  id: string,
): Promise<Record<string, unknown> | Response> {
  let record: Record<string, unknown> | null;
  try {
    record = await get({ session, id });
  } catch (error) {
    reportAdminError(scope.panel, error, {
      surface: 'resource',
      slug: scope.resource.slug,
      operation: 'get',
    });
    return adminServerErrorResponse();
  }
  return record ?? adminNotFoundResponse();
}

/**
 * Resolve + authorize a set of record ids for a bulk action. The ids are
 * independent, so each one's `update` gate and `get` run concurrently; the
 * result keeps the submitted order.
 */
async function resolveRecords(
  scope: ActionScope,
  get: RecordGetter,
  session: Session,
  ids: readonly string[],
  action: AdminAction,
): Promise<Record<string, unknown>[]> {
  const { panel, resource } = scope;
  const resolved = await Promise.all(
    ids.slice(0, MAX_BULK_IDS).map(async (id): Promise<Record<string, unknown> | null> => {
      // Each targeted record passes the resource's per-record `update` gate;
      // ids the session may not touch are silently left out of the batch.
      if (!(await resourceAllowed(resource, session, 'update', id, { report: panel }))) {
        return null;
      }
      try {
        return await get({ session, id });
      } catch (error) {
        reportAdminError(panel, error, {
          surface: 'resource',
          slug: resource.slug,
          operation: 'get',
        });
        return null;
      }
    }),
  );
  const records = resolved.filter((record): record is Record<string, unknown> => record !== null);
  return authorizeRecords(panel, action, session, records);
}

/** Filter records through the action's per-record `authorize` (default-allow). */
async function authorizeRecords(
  panel: AdminPanel,
  action: AdminAction,
  session: Session,
  records: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const authorize = action.authorize;
  if (authorize === undefined) return [...records];
  const allowed = await Promise.all(
    records.map(async (record) => {
      try {
        return (await authorize({ session, record })) === true;
      } catch (error) {
        // Deny on throw, exactly like every other default-deny gate.
        reportAdminError(panel, error, {
          surface: 'action',
          slug: action.name,
          operation: 'authorize',
        });
        return false;
      }
    }),
  );
  return records.filter((_record, index) => allowed[index] === true);
}

/** Run a resolved action and 303-redirect to the list with a success notice. */
async function runAction(run: ActionRun): Promise<Response> {
  const { panel, resource, action, session, records, parentId, body } = run;
  try {
    await action.run(
      { session, path: panel.path, ...(parentId === undefined ? {} : { parentId }) },
      records,
    );
  } catch (error) {
    reportAdminError(panel, error, { surface: 'action', slug: action.name, operation: 'run' });
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
