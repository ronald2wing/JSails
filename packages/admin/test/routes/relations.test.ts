/**
 * Tests for the relation manager routes: the parent-scoped related list
 * (escaped), create and delete posts carrying the session, CSRF token, and
 * parent id to the manager callbacks, the 403 for an unauthorized session, the
 * 403 without a CSRF token, the 400 without a parent id, and the absence of
 * create/delete forms when the callbacks are absent. Create validates through
 * the related schema (422 on unknown or invalid fields; the foreign key is
 * always the parent id); delete requires the related record to belong to the
 * posted parent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Session } from 'jsails';
import { postForm, type TestApplication } from 'jsails/testing';

import {
  defineRelationManager,
  defineResource,
  type RelationManagerCreateContext,
  type RelationManagerDeleteContext,
  type RelationManagerListContext,
  type Resource,
} from '../../src/index.js';
import {
  createAdminTestApp,
  createArticleStore,
  CSRF,
  defineArticleResource,
} from '../fixtures.js';

describe('relation manager routes', () => {
  interface RMStore {
    rows: { readonly id: string; readonly text: string; readonly post_id?: string }[];
    creates: Array<{ parentId: string; values: Record<string, unknown> }>;
    deletes: Array<{ parentId: string; relatedId: string }>;
    listCalls: Array<{ parentId: string; page: number; pageSize: number }>;
  }

  function makeRMStore(
    rows: { readonly id: string; readonly text: string; readonly post_id?: string }[] = [],
  ): RMStore {
    return { rows: [...rows], creates: [], deletes: [], listCalls: [] };
  }

  function makeCommentRM(
    store: RMStore,
    overrides?: {
      create?: (ctx: RelationManagerCreateContext) => Promise<void>;
      delete?: (ctx: RelationManagerDeleteContext) => Promise<void>;
    },
  ) {
    const related = defineResource({
      slug: 'comments',
      label: 'Comments',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'text', label: 'Text' },
      ],
      fields: [
        { name: 'text', label: 'Text', type: 'text' },
        { name: 'post_id', label: 'Post', type: 'text' },
      ],
      list: async () => ({ rows: [], total: 0 }),
      get: async ({ id }) => store.rows.find((row) => row.id === id) ?? null,
    });
    return defineRelationManager({
      name: 'post-comments',
      label: 'Comments',
      related,
      foreignKey: 'post_id',
      list: async ({ parentId, page, pageSize }: RelationManagerListContext) => {
        store.listCalls.push({ parentId, page, pageSize });
        return { rows: store.rows, total: store.rows.length };
      },
      create:
        overrides?.create ??
        (async ({ parentId, values }) => {
          store.creates.push({ parentId, values });
        }),
      delete:
        overrides?.delete ??
        (async ({ parentId, relatedId }) => {
          store.deletes.push({ parentId, relatedId });
        }),
    });
  }

  function createRelationApp(
    resource: Resource,
    overrides?: { authorize?: (session: Session | null) => boolean },
  ): Promise<TestApplication> {
    return createAdminTestApp({ resources: [resource], ...overrides });
  }

  it('GET lists related rows (escaped) for a parent', async () => {
    const store = makeRMStore([{ id: '1', text: '<script>alert(1)</script>' }]);
    const rm = makeCommentRM(store);
    const resource = defineArticleResource(createArticleStore(), { relationManagers: [rm] });
    const app = await createRelationApp(resource);

    const response = await app.request('/admin/articles/post-comments?parent=p1');
    assert.equal(response.status, 200);
    const body = await response.text();

    assert.match(body, /Comments/);
    assert.match(body, /Text/);
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /&lt;script/);

    assert.equal(store.listCalls.length, 1);
    assert.equal(store.listCalls[0]!.parentId, 'p1');
    assert.equal(store.listCalls[0]!.page, 1);
    assert.equal(store.listCalls[0]!.pageSize, 20);

    await app.close();
  });

  it('POST create calls manager.create with session, CSRF, and parent', async () => {
    const store = makeRMStore();
    const rm = makeCommentRM(store);
    const resource = defineArticleResource(createArticleStore(), { relationManagers: [rm] });
    const app = await createRelationApp(resource);

    const response = await postForm(app, '/admin/articles/post-comments', {
      _csrf: CSRF,
      _parent: 'p1',
      text: 'Nice',
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /parent=p1/);

    assert.equal(store.creates.length, 1);
    assert.equal(store.creates[0]!.parentId, 'p1');
    assert.deepEqual(store.creates[0]!.values, { text: 'Nice', post_id: 'p1' });

    await app.close();
  });

  it('renders the related fields (except the foreign key) in the create form', async () => {
    const store = makeRMStore();
    const rm = makeCommentRM(store);
    const resource = defineArticleResource(createArticleStore(), { relationManagers: [rm] });
    const app = await createRelationApp(resource);

    const body = await (await app.request('/admin/articles/post-comments?parent=p1')).text();
    assert.match(body, /name="text"/);
    assert.doesNotMatch(body, /name="post_id"/);

    await app.close();
  });

  it('POST create rejects unknown and invalid fields and forces the foreign key', async () => {
    const store = makeRMStore();
    const rm = makeCommentRM(store);
    const resource = defineArticleResource(createArticleStore(), { relationManagers: [rm] });
    const app = await createRelationApp(resource);

    const unknown = await postForm(app, '/admin/articles/post-comments', {
      _csrf: CSRF,
      _parent: 'p1',
      text: 'Hi',
      role: 'admin',
    });
    assert.equal(unknown.status, 422);
    const missing = await postForm(app, '/admin/articles/post-comments', {
      _csrf: CSRF,
      _parent: 'p1',
    });
    assert.equal(missing.status, 422);
    assert.equal(store.creates.length, 0);

    // A submitted foreign key is ignored: the parent id always wins.
    const forged = await postForm(app, '/admin/articles/post-comments', {
      _csrf: CSRF,
      _parent: 'p1',
      text: 'Hi',
      post_id: 'p2',
    });
    assert.equal(forged.status, 303);
    assert.equal(store.creates[0]!.values['post_id'], 'p1');

    await app.close();
  });

  it('POST create handles repeater buttons and ignores fields the form leaves out', async () => {
    const creates: Record<string, unknown>[] = [];
    const related = defineResource({
      slug: 'attachments',
      label: 'Attachments',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [
        { name: 'title', label: 'Title', type: 'text' },
        // Required, but the relation create form has no upload path: it must
        // not fail every create.
        { name: 'scan', label: 'Scan', type: 'file' },
        {
          name: 'tags',
          label: 'Tags',
          type: 'repeater',
          required: false,
          repeater: { fields: [{ name: 'name', label: 'Name', type: 'text' }] },
        },
      ],
      list: async () => ({ rows: [], total: 0 }),
    });
    const rm = defineRelationManager({
      name: 'post-attachments',
      label: 'Attachments',
      related,
      foreignKey: 'post_id',
      list: async () => ({ rows: [], total: 0 }),
      create: async ({ values }) => {
        creates.push(values);
      },
    });
    const resource = defineArticleResource(createArticleStore(), { relationManagers: [rm] });
    const app = await createRelationApp(resource);

    const added = await postForm(app, '/admin/articles/post-attachments', {
      _csrf: CSRF,
      _parent: 'p1',
      title: 'Doc',
      'tags[0].name': 'a',
      _repeater_add: 'tags',
    });
    assert.equal(added.status, 200);
    const addedBody = await added.text();
    assert.match(addedBody, /name="tags\[1\]\.name"/);
    assert.match(addedBody, /value="a"/);

    const removed = await postForm(app, '/admin/articles/post-attachments', {
      _csrf: CSRF,
      _parent: 'p1',
      title: 'Doc',
      'tags[0].name': 'a',
      'tags[1].name': 'b',
      _repeater_remove: 'tags.0',
    });
    assert.equal(removed.status, 200);
    assert.doesNotMatch(await removed.text(), /name="tags\[1\]\.name"/);
    assert.equal(creates.length, 0);

    const created = await postForm(app, '/admin/articles/post-attachments', {
      _csrf: CSRF,
      _parent: 'p1',
      title: 'Doc',
      'tags[0].name': 'a',
    });
    assert.equal(created.status, 303);
    assert.deepEqual(creates, [{ title: 'Doc', tags: [{ name: 'a' }] }]);

    await app.close();
  });

  it('POST delete calls manager.delete with session, CSRF, parent, and relatedId', async () => {
    const store = makeRMStore([{ id: '42', text: 'x', post_id: 'p1' }]);
    const rm = makeCommentRM(store);
    const resource = defineArticleResource(createArticleStore(), { relationManagers: [rm] });
    const app = await createRelationApp(resource);

    const response = await postForm(app, '/admin/articles/post-comments/42/delete', {
      _csrf: CSRF,
      _parent: 'p1',
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /parent=p1/);

    assert.equal(store.deletes.length, 1);
    assert.equal(store.deletes[0]!.parentId, 'p1');
    assert.equal(store.deletes[0]!.relatedId, '42');

    await app.close();
  });

  it('POST delete refuses a related record of another parent, or an unknown one', async () => {
    const store = makeRMStore([{ id: '42', text: 'x', post_id: 'p2' }]);
    const rm = makeCommentRM(store);
    const resource = defineArticleResource(createArticleStore(), { relationManagers: [rm] });
    const app = await createRelationApp(resource);

    const foreign = await postForm(app, '/admin/articles/post-comments/42/delete', {
      _csrf: CSRF,
      _parent: 'p1',
    });
    assert.equal(foreign.status, 403);
    const unknown = await postForm(app, '/admin/articles/post-comments/99/delete', {
      _csrf: CSRF,
      _parent: 'p1',
    });
    assert.equal(unknown.status, 404);
    assert.equal(store.deletes.length, 0);

    await app.close();
  });

  it('POST delete is refused when the related resource cannot prove membership', async () => {
    const deletes: string[] = [];
    const related = defineResource({
      slug: 'notes',
      label: 'Notes',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [{ name: 'text', label: 'Text', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const rm = defineRelationManager({
      name: 'post-notes',
      label: 'Notes',
      related,
      foreignKey: 'post_id',
      list: async () => ({ rows: [], total: 0 }),
      delete: async ({ relatedId }) => {
        deletes.push(relatedId);
      },
    });
    const resource = defineArticleResource(createArticleStore(), { relationManagers: [rm] });
    const app = await createRelationApp(resource);

    const response = await postForm(app, '/admin/articles/post-notes/1/delete', {
      _csrf: CSRF,
      _parent: 'p1',
    });
    assert.equal(response.status, 403);
    assert.deepEqual(deletes, []);

    await app.close();
  });

  it('rejects anon GET and POST with 403', async () => {
    const store = makeRMStore();
    const rm = makeCommentRM(store);
    const resource = defineArticleResource(createArticleStore(), { relationManagers: [rm] });
    const app = await createRelationApp(resource, { authorize: () => false });

    const listResponse = await app.request('/admin/articles/post-comments?parent=p1');
    assert.equal(listResponse.status, 403);

    const createResponse = await postForm(app, '/admin/articles/post-comments', {
      _csrf: CSRF,
      _parent: 'p1',
    });
    assert.equal(createResponse.status, 403);

    const deleteResponse = await postForm(app, '/admin/articles/post-comments/1/delete', {
      _csrf: CSRF,
      _parent: 'p1',
    });
    assert.equal(deleteResponse.status, 403);

    assert.equal(store.creates.length, 0);
    assert.equal(store.deletes.length, 0);

    await app.close();
  });

  it('rejects create/delete POST without CSRF token', async () => {
    const store = makeRMStore();
    const rm = makeCommentRM(store);
    const resource = defineArticleResource(createArticleStore(), { relationManagers: [rm] });
    const app = await createRelationApp(resource);

    const noCsrf = await postForm(app, '/admin/articles/post-comments', {
      _parent: 'p1',
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(store.creates.length, 0);

    const wrongCsrf = await postForm(app, '/admin/articles/post-comments', {
      _csrf: 'wrong',
      _parent: 'p1',
    });
    assert.equal(wrongCsrf.status, 403);
    assert.equal(store.creates.length, 0);

    await app.close();
  });

  it('rejects a missing parent id with 400', async () => {
    const store = makeRMStore();
    const rm = makeCommentRM(store);
    const resource = defineArticleResource(createArticleStore(), { relationManagers: [rm] });
    const app = await createRelationApp(resource);

    const listResponse = await app.request('/admin/articles/post-comments');
    assert.equal(listResponse.status, 400);

    const createResponse = await postForm(app, '/admin/articles/post-comments', {
      _csrf: CSRF,
    });
    assert.equal(createResponse.status, 400);

    await app.close();
  });

  it('renders no create/delete forms when callbacks are absent', async () => {
    const store = makeRMStore();
    // Build a manager with no create/delete in the spec so the descriptor
    // carries undefined for both. The rendered forms must not appear.
    const related = defineResource({
      slug: 'plain-comments',
      label: 'Comments',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'text', label: 'Text' },
      ],
      fields: [{ name: 'text', label: 'Text', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const rm = defineRelationManager({
      name: 'plain-comments',
      label: 'Comments',
      related,
      foreignKey: 'post_id',
      list: async ({ parentId, page, pageSize }: RelationManagerListContext) => {
        store.listCalls.push({ parentId, page, pageSize });
        return { rows: store.rows, total: store.rows.length };
      },
    });
    const resource = defineArticleResource(createArticleStore(), { relationManagers: [rm] });
    const app = await createRelationApp(resource);

    const listResponse = await app.request('/admin/articles/plain-comments?parent=p1');
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.text();
    assert.doesNotMatch(listBody, /admin-relation-create/);
    assert.doesNotMatch(listBody, /admin-relation-delete/);

    await app.close();
  });
});
