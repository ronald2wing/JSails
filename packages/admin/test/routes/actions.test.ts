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
 * resource `authorize` filter records before `run`; an unknown action name or
 * record id is 404; an action that `requiresParent` is 400 without one and
 * receives the parent id in its context otherwise.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { postForm } from 'jsails/testing';

import {
  defineAdminAction,
  defineResource,
  type AdminActionAuthorizeContext,
  type AdminActionContext,
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
  function defineParentedResource(runs: RunCall[]): Resource {
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
    const app = await createAdminTestApp({ resources: [defineParentedResource(runs)] });

    assert.equal((await app.request('/admin/articles/actions/attach?ids=1')).status, 400);
    const run = await postForm(app, '/admin/articles/actions/attach', { _csrf: CSRF, ids: '1' });
    assert.equal(run.status, 400);
    assert.equal(runs.length, 0);

    await app.close();
  });

  it('carries the parent id from the confirm form into the run context', async () => {
    const runs: RunCall[] = [];
    const app = await createAdminTestApp({ resources: [defineParentedResource(runs)] });

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
});
