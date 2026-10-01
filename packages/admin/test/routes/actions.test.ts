/**
 * Tests for the action routes: header, row, and bulk actions driven through
 * the real admin plugin.
 *
 * A fixture resource exposes one action of each kind against an in-memory
 * record store. The list renders header action links, row action links, and
 * (for bulk actions) per-row checkboxes plus a submit button; the confirm page
 * (GET) is server-rendered, then the run (POST) is origin/CSRF-gated, invokes
 * `run` with the resolved, authorized records, and 303-redirects to the list
 * with a `?_notice=<code>` flash. An action's per-record `authorize` and the
 * resource `authorize` filter records before `run`, and the resource's
 * `action` gate decides whether the action may run at all; a row or bulk run
 * left with no record is a 403; an unknown action name or record id is 404; an
 * action that `requiresParent` is 400 without one, 403 when the parent
 * resource's `update` gate refuses the id (or no parent resource is known),
 * and receives the authorized parent id in its context otherwise.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { postForm } from 'jsails/testing';

import {
  defineAdminAction,
  defineAttachAction,
  defineRelationManager,
  defineResource,
  type AdminActionAuthorizeContext,
  type AdminActionContext,
  type AdminResourceAuthorizeContext,
  type RelationActionContext,
  type Resource,
} from '../../src/index.js';
import { createAdminTestApp, CSRF, SESSION } from '../fixtures.js';

type Article = {
  readonly id: string;
  readonly title: string;
  readonly published: boolean;
};

/** Records captured from action `run` calls: session, path, and resolved records. */
interface RunCall {
  readonly context: AdminActionContext;
  readonly records: readonly Record<string, unknown>[];
}

const RECORDS: Article[] = [
  { id: '1', title: 'First', published: false },
  { id: '2', title: 'Second', published: false },
  { id: '3', title: 'Third', published: false },
];

function defineActionResource(runs: RunCall[]): Resource {
  return defineResource({
    slug: 'articles',
    label: 'Articles',
    columns: [
      { name: 'id', label: 'ID' },
      { name: 'title', label: 'Title' },
      { name: 'published', label: 'Published', format: 'boolean' },
    ],
    fields: [{ name: 'title', label: 'Title', type: 'text' }],
    list: async () => ({ rows: RECORDS, total: RECORDS.length }),
    get: async ({ id }) => RECORDS.find((record) => record.id === id) ?? null,
    save: async () => {},
    actions: {
      header: [
        defineAdminAction({
          name: 'export-all',
          label: 'Export all',
          confirm: 'Export every article?',
          run: (context, records) => {
            runs.push({ context, records });
          },
        }),
      ],
      row: [
        defineAdminAction({
          name: 'publish',
          label: 'Publish',
          run: (context, records) => {
            runs.push({ context, records });
          },
        }),
      ],
      bulk: [
        defineAdminAction({
          name: 'archive',
          label: 'Archive',
          notice: 'articles-archived',
          run: (context, records) => {
            runs.push({ context, records });
          },
        }),
      ],
    },
  });
}

describe('admin header actions', () => {
  it('renders the header action link on the list and confirms then runs it', async () => {
    const runs: RunCall[] = [];
    const app = await createAdminTestApp({ resources: [defineActionResource(runs)] });

    const list = await app.request('/admin/articles');
    const listBody = await list.text();
    assert.match(listBody, /Export all/);
    assert.match(listBody, /actions\/export-all/);

    const confirm = await app.request('/admin/articles/actions/export-all');
    const confirmBody = await confirm.text();
    assert.equal(confirm.status, 200);
    assert.match(confirmBody, /Export every article\?/);
    assert.match(confirmBody, /Confirm/);

    const response = await postForm(app, '/admin/articles/actions/export-all', {
      _csrf: CSRF,
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /\/admin\/articles\?_notice=/);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0]!.records, []);
    assert.equal(runs[0]!.context.session.id, SESSION.id);
    assert.equal(runs[0]!.context.path, '/admin');

    await app.close();
  });
});

describe('admin row actions', () => {
  it('renders a per-row link, confirms, and runs against the single record', async () => {
    const runs: RunCall[] = [];
    const app = await createAdminTestApp({ resources: [defineActionResource(runs)] });

    const list = await app.request('/admin/articles');
    const listBody = await list.text();
    assert.match(listBody, /Publish/);
    assert.match(listBody, /\/1\/actions\/publish/);

    const confirm = await app.request('/admin/articles/1/actions/publish');
    assert.equal(confirm.status, 200);
    assert.match(await confirm.text(), /This will affect 1 record\./);

    const response = await postForm(app, '/admin/articles/1/actions/publish', {
      _csrf: CSRF,
    });
    assert.equal(response.status, 303);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.records.length, 1);
    assert.equal(runs[0]!.records[0]!['id'], '1');

    await app.close();
  });

  it('returns 404 for an unknown row id and an unknown action name', async () => {
    const runs: RunCall[] = [];
    const app = await createAdminTestApp({ resources: [defineActionResource(runs)] });

    assert.equal((await app.request('/admin/articles/999/actions/publish')).status, 404);
    assert.equal((await app.request('/admin/articles/1/actions/nope')).status, 404);

    await app.close();
  });
});

describe('admin bulk actions', () => {
  it('renders checkboxes, confirms the selection, and runs against the selected records', async () => {
    const runs: RunCall[] = [];
    const app = await createAdminTestApp({ resources: [defineActionResource(runs)] });

    const list = await app.request('/admin/articles');
    const listBody = await list.text();
    assert.match(listBody, /name="ids"/);
    assert.match(listBody, /actions\/archive/);

    const confirm = await app.request('/admin/articles/actions/archive?ids=1&ids=2');
    assert.equal(confirm.status, 200);
    assert.match(await confirm.text(), /This will affect 2 records\./);

    const response = await postForm(app, '/admin/articles/actions/archive', {
      _csrf: CSRF,
      ids: '1,2',
    });
    assert.equal(response.status, 303);
    assert.equal(runs.length, 1);
    assert.deepEqual(
      runs[0]!.records.map((record) => record['id']),
      ['1', '2'],
    );
    // The custom notice code is reflected in the redirect.
    assert.match(response.headers.get('location') ?? '', /_notice=articles-archived/);

    await app.close();
  });

  it('drops unknown ids when resolving the selection', async () => {
    const runs: RunCall[] = [];
    const app = await createAdminTestApp({ resources: [defineActionResource(runs)] });

    const response = await postForm(app, '/admin/articles/actions/archive', {
      _csrf: CSRF,
      ids: '1,999',
    });
    assert.equal(response.status, 303);
    assert.deepEqual(
      runs[0]!.records.map((record) => record['id']),
      ['1'],
    );

    await app.close();
  });
});

describe('admin action per-record authorization', () => {
  function makeGatedResource(runs: RunCall[]): Resource {
    // Only records 2 and 3 are published, so the per-record authorize allows them.
    const rows: Article[] = [
      { id: '1', title: 'First', published: false },
      { id: '2', title: 'Second', published: true },
      { id: '3', title: 'Third', published: true },
    ];
    const authorize = (context: AdminActionAuthorizeContext) =>
      context.record['published'] === true;
    return defineResource({
      slug: 'articles',
      label: 'Articles',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
        { name: 'published', label: 'Published', format: 'boolean' },
      ],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows, total: rows.length }),
      get: async ({ id }) => rows.find((record) => record.id === id) ?? null,
      save: async () => {},
      actions: {
        bulk: [
          defineAdminAction({
            name: 'archive',
            label: 'Archive',
            authorize,
            run: (context, records) => {
              runs.push({ context, records });
            },
          }),
        ],
      },
    });
  }

  it('runs only against records the per-record authorize allows', async () => {
    const runs: RunCall[] = [];
    const app = await createAdminTestApp({ resources: [makeGatedResource(runs)] });

    // Only records 2 and 3 are `published`, so the selection is filtered to them.
    const response = await postForm(app, '/admin/articles/actions/archive', {
      _csrf: CSRF,
      ids: '1,2,3',
    });
    assert.equal(response.status, 303);
    assert.equal(runs.length, 1);
    assert.deepEqual(
      runs[0]!.records.map((record) => record['id']),
      ['2', '3'],
    );

    await app.close();
  });
});

describe('admin action resource gate', () => {
  function makeOwnedResource(runs: RunCall[]): Resource {
    const rows: Article[] = [
      { id: '1', title: 'Locked', published: true },
      { id: '2', title: 'Open', published: true },
    ];
    return defineResource({
      slug: 'articles',
      label: 'Articles',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows, total: rows.length }),
      get: async ({ id }) => rows.find((record) => record.id === id) ?? null,
      save: async () => {},
      // Record 1 may be read but never updated by this session.
      authorize: ({ action, recordId }) => action !== 'update' || recordId !== '1',
      actions: {
        row: [
          defineAdminAction({
            name: 'archive-one',
            label: 'Archive',
            run: (context, records) => {
              runs.push({ context, records });
            },
          }),
        ],
        bulk: [
          defineAdminAction({
            name: 'archive',
            label: 'Archive',
            run: (context, records) => {
              runs.push({ context, records });
            },
          }),
        ],
      },
    });
  }

  it('refuses a row action on a record the resource authorize does not allow updating', async () => {
    const runs: RunCall[] = [];
    const app = await createAdminTestApp({ resources: [makeOwnedResource(runs)] });

    const confirm = await app.request('/admin/articles/1/actions/archive-one');
    assert.equal(confirm.status, 403);
    const locked = await postForm(app, '/admin/articles/1/actions/archive-one', { _csrf: CSRF });
    assert.equal(locked.status, 403);
    assert.equal(runs.length, 0);

    const open = await postForm(app, '/admin/articles/2/actions/archive-one', { _csrf: CSRF });
    assert.equal(open.status, 303);
    assert.equal(runs.length, 1);

    await app.close();
  });

  it('refuses a bulk run when no selected record may be updated', async () => {
    const runs: RunCall[] = [];
    const app = await createAdminTestApp({ resources: [makeOwnedResource(runs)] });

    const response = await postForm(app, '/admin/articles/actions/archive', {
      _csrf: CSRF,
      ids: '1',
    });
    assert.equal(response.status, 403);
    assert.equal(runs.length, 0);

    await app.close();
  });

  it('drops bulk ids the resource authorize does not allow updating', async () => {
    const runs: RunCall[] = [];
    const app = await createAdminTestApp({ resources: [makeOwnedResource(runs)] });

    const response = await postForm(app, '/admin/articles/actions/archive', {
      _csrf: CSRF,
      ids: '1,2',
    });
    assert.equal(response.status, 303);
    assert.equal(runs.length, 1);
    assert.deepEqual(
      runs[0]!.records.map((record) => record['id']),
      ['2'],
    );

    await app.close();
  });
});

describe('admin action permission gate', () => {
  /** The action resource with an `authorize` that allows `list` but no action. */
  function listOnly(runs: RunCall[], calls: AdminResourceAuthorizeContext[]): Resource {
    const base = defineActionResource(runs);
    return defineResource({
      slug: base.slug,
      label: base.label,
      columns: base.columns,
      fields: base.fields,
      list: base.list,
      ...(base.get === undefined ? {} : { get: base.get }),
      ...(base.actions === undefined ? {} : { actions: base.actions }),
      authorize: (context) => {
        calls.push(context);
        return context.action !== 'action';
      },
    });
  }

  it('refuses header, row, and bulk actions the action gate denies', async () => {
    const runs: RunCall[] = [];
    const calls: AdminResourceAuthorizeContext[] = [];
    const app = await createAdminTestApp({ resources: [listOnly(runs, calls)] });

    assert.equal((await app.request('/admin/articles/actions/export-all')).status, 403);
    const header = await postForm(app, '/admin/articles/actions/export-all', { _csrf: CSRF });
    assert.equal(header.status, 403);
    const bulk = await postForm(app, '/admin/articles/actions/archive', { _csrf: CSRF, ids: '1' });
    assert.equal(bulk.status, 403);
    const row = await postForm(app, '/admin/articles/1/actions/publish', { _csrf: CSRF });
    assert.equal(row.status, 403);
    assert.equal(runs.length, 0);

    // The gate names the action, and the record for a row action.
    assert.ok(calls.some((c) => c.action === 'action' && c.actionName === 'export-all'));
    assert.ok(
      calls.some((c) => c.action === 'action' && c.actionName === 'publish' && c.recordId === '1'),
    );

    await app.close();
  });

  it('refuses a row run the per-record action authorize filters out', async () => {
    const runs: RunCall[] = [];
    const resource = defineResource({
      slug: 'articles',
      label: 'Articles',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows: RECORDS, total: RECORDS.length }),
      get: async ({ id }) => RECORDS.find((record) => record.id === id) ?? null,
      actions: {
        row: [
          defineAdminAction({
            name: 'publish',
            label: 'Publish',
            authorize: () => false,
            run: (context, records) => {
              runs.push({ context, records });
            },
          }),
        ],
      },
    });
    const app = await createAdminTestApp({ resources: [resource] });

    const response = await postForm(app, '/admin/articles/1/actions/publish', { _csrf: CSRF });
    assert.equal(response.status, 403);
    assert.equal(runs.length, 0);

    await app.close();
  });
});

describe('admin action mutation security', () => {
  it('rejects a POST without a same-origin Origin or a matching CSRF token', async () => {
    const runs: RunCall[] = [];
    const app = await createAdminTestApp({ resources: [defineActionResource(runs)] });

    const noOrigin = await postForm(
      app,
      '/admin/articles/actions/export-all',
      { _csrf: CSRF },
      {
        origin: 'https://evil.example',
      },
    );
    assert.equal(noOrigin.status, 403);

    const badCsrf = await postForm(app, '/admin/articles/actions/export-all', {
      _csrf: 'wrong-token',
    });
    assert.equal(badCsrf.status, 403);

    assert.equal(runs.length, 0);

    await app.close();
  });
});

describe('admin actions requiring a parent', () => {
  /** A parent resource storing `p1`/`p2` whose `update` gate allows `p1` and `p3`. */
  function defineParentResource(): Resource {
    return defineResource({
      slug: 'posts',
      label: 'Posts',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
      get: async ({ id }) => (id === 'p1' || id === 'p2' ? { id } : null),
      authorize: ({ action, recordId }) =>
        action !== 'update' || recordId === 'p1' || recordId === 'p3',
    });
  }

  function defineParentedResource(runs: RunCall[], parent?: Resource): Resource {
    return defineResource({
      slug: 'articles',
      label: 'Articles',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows: RECORDS, total: RECORDS.length }),
      get: async ({ id }) => RECORDS.find((record) => record.id === id) ?? null,
      actions: {
        bulk: [
          defineAdminAction({
            name: 'attach',
            label: 'Attach',
            requiresParent: true,
            ...(parent === undefined ? {} : { parent }),
            run: (context, records) => {
              runs.push({ context, records });
            },
          }),
        ],
      },
    });
  }

  it('rejects the confirm page and the run without a parent id', async () => {
    const runs: RunCall[] = [];
    const parent = defineParentResource();
    const app = await createAdminTestApp({
      resources: [defineParentedResource(runs, parent), parent],
    });

    assert.equal((await app.request('/admin/articles/actions/attach?ids=1')).status, 400);
    const run = await postForm(app, '/admin/articles/actions/attach', { _csrf: CSRF, ids: '1' });
    assert.equal(run.status, 400);
    assert.equal(runs.length, 0);

    await app.close();
  });

  it('carries the authorized parent id from the confirm form into the run context', async () => {
    const runs: RunCall[] = [];
    const parent = defineParentResource();
    const app = await createAdminTestApp({
      resources: [defineParentedResource(runs, parent), parent],
    });

    const confirm = await app.request('/admin/articles/actions/attach?ids=1&parent=p1');
    assert.equal(confirm.status, 200);
    assert.match(await confirm.text(), /name="_parent" value="p1"/);

    const run = await postForm(app, '/admin/articles/actions/attach', {
      _csrf: CSRF,
      ids: '1,2',
      _parent: 'p1',
    });
    assert.equal(run.status, 303);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.context.parentId, 'p1');
    assert.deepEqual(
      runs[0]!.records.map((record) => record['id']),
      ['1', '2'],
    );

    await app.close();
  });

  it('refuses a parent id the parent resource does not allow updating, or that does not exist', async () => {
    const runs: RunCall[] = [];
    const parent = defineParentResource();
    const app = await createAdminTestApp({
      resources: [defineParentedResource(runs, parent), parent],
    });

    assert.equal((await app.request('/admin/articles/actions/attach?ids=1&parent=p2')).status, 403);
    const denied = await postForm(app, '/admin/articles/actions/attach', {
      _csrf: CSRF,
      ids: '1',
      _parent: 'p2',
    });
    assert.equal(denied.status, 403);
    const missing = await postForm(app, '/admin/articles/actions/attach', {
      _csrf: CSRF,
      ids: '1',
      _parent: 'p3',
    });
    assert.equal(missing.status, 404);
    assert.equal(runs.length, 0);

    await app.close();
  });

  it('refuses a requiresParent action whose parent resource is unknown', async () => {
    const runs: RunCall[] = [];
    const app = await createAdminTestApp({ resources: [defineParentedResource(runs)] });

    const run = await postForm(app, '/admin/articles/actions/attach', {
      _csrf: CSRF,
      ids: '1',
      _parent: 'p1',
    });
    assert.equal(run.status, 403);
    assert.equal(runs.length, 0);

    await app.close();
  });

  it('authorizes an attach action against the resource declaring its relation manager', async () => {
    const attached: RelationActionContext[] = [];
    const tags = defineResource({
      slug: 'tags',
      label: 'Tags',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows: RECORDS, total: RECORDS.length }),
      get: async ({ id }) => RECORDS.find((record) => record.id === id) ?? null,
    });
    const manager = defineRelationManager({
      name: 'post-tags',
      label: 'Tags',
      related: tags,
      foreignKey: 'post_id',
      list: async () => ({ rows: [], total: 0 }),
    });
    const attach = defineAttachAction({
      manager,
      attach: async (context) => {
        attached.push(context);
      },
    });
    const taggable = defineResource({
      slug: tags.slug,
      label: tags.label,
      columns: tags.columns,
      fields: tags.fields,
      list: tags.list,
      ...(tags.get === undefined ? {} : { get: tags.get }),
      actions: { bulk: [attach] },
    });
    const parentBase = defineParentResource();
    const posts = defineResource({
      slug: parentBase.slug,
      label: parentBase.label,
      columns: parentBase.columns,
      fields: parentBase.fields,
      list: parentBase.list,
      ...(parentBase.get === undefined ? {} : { get: parentBase.get }),
      ...(parentBase.authorize === undefined ? {} : { authorize: parentBase.authorize }),
      relationManagers: [manager],
    });
    const app = await createAdminTestApp({ resources: [taggable, posts] });

    const denied = await postForm(app, '/admin/tags/actions/attach', {
      _csrf: CSRF,
      ids: '1',
      _parent: 'p2',
    });
    assert.equal(denied.status, 403);
    const allowed = await postForm(app, '/admin/tags/actions/attach', {
      _csrf: CSRF,
      ids: '1',
      _parent: 'p1',
    });
    assert.equal(allowed.status, 303);
    assert.deepEqual(
      attached.map((context) => [context.parentId, context.relatedIds]),
      [['p1', ['1']]],
    );

    await app.close();
  });
});
