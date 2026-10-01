/**
 * Tests for `defineAdminPlugin`: id and register validation plus the frozen
 * descriptor; and `withAdminAuthorize`, which grants a plugin's undeclared
 * contributions an explicit gate while keeping the ones they declare.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Session } from 'jsails';
import { postForm } from 'jsails/testing';

import {
  AdminDefinitionError,
  defineAdminAction,
  defineAdminPage,
  defineAdminPlugin,
  defineAttachAction,
  defineRelationManager,
  defineResource,
  withAdminAuthorize,
  type AdminPage,
  type Resource,
} from '../src/index.js';
import { createAdminTestApp, CSRF, SESSION } from './fixtures.js';

describe('defineAdminPlugin validation', () => {
  it('rejects a missing id', () => {
    assert.throws(() => defineAdminPlugin({ register: () => {} } as never), AdminDefinitionError);
  });

  it('rejects a missing register function', () => {
    assert.throws(() => defineAdminPlugin({ id: 'x' } as never), AdminDefinitionError);
  });

  it('returns a frozen descriptor', () => {
    const plugin = defineAdminPlugin({ id: 'x', register: () => {} });
    assert.equal(Object.isFrozen(plugin), true);
    assert.equal(plugin.id, 'x');
  });
});

describe('withAdminAuthorize', () => {
  const runs: string[] = [];
  /** A third-party plugin whose contributions declare no authorize, plus one that does. */
  const thirdParty = defineAdminPlugin({
    id: 'third-party',
    register(builder) {
      builder.addPage(defineAdminPage({ slug: 'reports', label: 'Reports', render: () => 'R' }));
      builder.addPage(
        defineAdminPage({
          slug: 'locked',
          label: 'Locked',
          render: () => 'L',
          authorize: () => false,
        }),
      );
      builder.addResource(
        defineResource({
          slug: 'notes',
          label: 'Notes',
          columns: [{ name: 'id', label: 'ID' }],
          fields: [{ name: 'title', label: 'Title', type: 'text' }],
          list: async () => ({ rows: [{ id: 'n1' }], total: 1 }),
          get: async ({ id }) => ({ id }),
          actions: {
            row: [
              defineAdminAction({
                name: 'pin',
                label: 'Pin',
                run: (_context, records) => {
                  runs.push(...records.map((record) => String(record['id'])));
                },
              }),
            ],
          },
        }),
      );
    },
  });

  it('leaves an ungated plugin default-deny', async () => {
    const app = await createAdminTestApp({ adminPlugins: [thirdParty] });
    assert.equal((await app.request('/admin/reports')).status, 403);
    assert.equal((await app.request('/admin/notes')).status, 403);
    await app.close();
  });

  it('grants the gate to undeclared contributions and keeps declared ones', async () => {
    const gate = (session: Session): boolean => session.id === SESSION.id;
    const app = await createAdminTestApp({ adminPlugins: [withAdminAuthorize(thirdParty, gate)] });
    assert.equal((await app.request('/admin/reports')).status, 200);
    assert.equal((await app.request('/admin/locked')).status, 403);
    assert.equal((await app.request('/admin/notes')).status, 200);
    const pinned = await postForm(app, '/admin/notes/n1/actions/pin', { _csrf: CSRF });
    assert.equal(pinned.status, 303);
    assert.deepEqual(runs, ['n1']);
    await app.close();
  });

  it('applies the gate it was given, not an allow-all', async () => {
    const app = await createAdminTestApp({
      adminPlugins: [withAdminAuthorize(thirdParty, () => false)],
    });
    assert.equal((await app.request('/admin/reports')).status, 403);
    assert.equal((await app.request('/admin/notes')).status, 403);
    await app.close();
  });

  it('refuses a missing gate', () => {
    assert.throws(
      () => withAdminAuthorize(thirdParty, undefined as never),
      (error: unknown) => error instanceof AdminDefinitionError,
    );
  });

  it('returns frozen descriptors carrying the gate', () => {
    const pages: AdminPage[] = [];
    const resources: Resource[] = [];
    withAdminAuthorize(thirdParty, () => true).register({
      addPage: (page) => pages.push(page),
      addResource: (resource) => resources.push(resource),
      addNavigationItem: () => {},
    });
    assert.ok(pages.every((page) => Object.isFrozen(page) && page.authorize !== undefined));
    assert.ok(resources.every((resource) => Object.isFrozen(resource)));
    assert.equal(typeof resources[0]?.actions?.row?.[0]?.authorize, 'function');
  });

  /**
   * A plugin whose resources refer to each other: posts manage comments, and
   * labels carry a relation column to posts and an attach action into posts.
   */
  function relatedPlugin(attached: string[]) {
    const comments = defineResource({
      slug: 'comments',
      label: 'Comments',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [{ name: 'text', label: 'Text', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const postComments = defineRelationManager({
      name: 'post-comments',
      label: 'Comments',
      related: comments,
      foreignKey: 'post_id',
      list: async () => ({ rows: [{ id: 'c1' }], total: 1 }),
    });
    const posts = defineResource({
      slug: 'posts',
      label: 'Posts',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows: [{ id: 'p1' }], total: 1 }),
      get: async ({ id }) => ({ id }),
      relationManagers: [postComments],
    });
    const labels = defineResource({
      slug: 'labels',
      label: 'Labels',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'post', label: 'Post', type: 'relation', related: posts, resolve: () => ['P'] },
      ],
      fields: [{ name: 'name', label: 'Name', type: 'text' }],
      list: async () => ({ rows: [{ id: 'l1' }], total: 1 }),
      get: async ({ id }) => ({ id }),
      actions: {
        bulk: [
          defineAttachAction({
            manager: postComments,
            parent: posts,
            attach: async ({ parentId, relatedIds }) => {
              attached.push(`${parentId}:${relatedIds.join(',')}`);
            },
          }),
        ],
      },
    });
    return defineAdminPlugin({
      id: 'related',
      register(builder) {
        // Labels first: a reference to a resource added later is rewritten too.
        builder.addResource(labels);
        builder.addResource(posts);
        builder.addResource(comments);
      },
    });
  }

  it("points references between the plugin's resources at their gated copies", () => {
    const resources: Resource[] = [];
    withAdminAuthorize(relatedPlugin([]), () => true).register({
      addPage: () => {},
      addResource: (resource) => resources.push(resource),
      addNavigationItem: () => {},
    });
    const [labels, posts, comments] = resources;
    assert.ok(labels !== undefined && posts !== undefined && comments !== undefined);
    const manager = posts.relationManagers?.[0];
    assert.equal(manager?.related, comments);
    assert.equal(labels.columns[1]?.related, posts);
    const attach = labels.actions?.bulk?.[0];
    assert.equal(attach?.parent, posts);
    assert.equal(attach?.relationManager, manager);
    assert.ok([labels, posts, comments, manager, attach].every((value) => Object.isFrozen(value)));
  });

  it('lets the gate reach related managers and parented actions of a wrapped plugin', async () => {
    const attached: string[] = [];
    const app = await createAdminTestApp({
      adminPlugins: [withAdminAuthorize(relatedPlugin(attached), () => true)],
    });
    const list = await app.request('/admin/posts/post-comments?parent=p1');
    assert.equal(list.status, 200);
    assert.match(await list.text(), /<td>c1<\/td>/);
    const labels = await app.request('/admin/labels');
    assert.equal(labels.status, 200);
    assert.match(await labels.text(), />Post</);
    const run = await postForm(app, '/admin/labels/actions/attach', {
      _csrf: CSRF,
      ids: 'l1',
      _parent: 'p1',
    });
    assert.equal(run.status, 303);
    assert.deepEqual(attached, ['p1:l1']);
    await app.close();
  });
});
