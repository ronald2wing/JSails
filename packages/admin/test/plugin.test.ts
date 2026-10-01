/**
 * Tests for `adminPlugin`: the default-deny auth gate, the session-service
 * resolver, and plugin-contributed pages, resources, and navigation.
 *
 * The gate is proven default-deny per request (null session, throwing or
 * rejecting resolver, truthy non-boolean or throwing authorize all yield a
 * value-free 403). The admin package does not depend on `@jsails/auth`: any
 * extension providing an {@link AdminSessionService} under a token works, so a
 * local fake plugin provides one. A plugin's `register` receives a builder, its
 * contributions are mounted under the panel path exactly like panel-declared
 * pages and resources, and a page/resource slug collision is rejected at
 * assembly time with a value-free `AdminDefinitionError`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Session } from 'jsails';
import { createServiceToken, definePlugin, type JsailsPlugin } from 'jsails/extensions';
import { createTestApp } from 'jsails/testing';

import {
  AdminDefinitionError,
  adminPlugin,
  DEFAULT_ADMIN_PATH,
  defineAdminPage,
  defineAdminPanel,
  defineAdminPlugin,
  defineResource,
  type AdminSessionService,
  type Resource,
} from '../src/index.js';
import { createAdminTestApp, SESSION } from './fixtures.js';

describe('admin auth gate', () => {
  it('denies when the session resolver returns null', async () => {
    const app = await createAdminTestApp({
      resolveSession: () => null,
      authorize: (session) => session !== null,
    });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    assert.equal(response.status, 403);
    await app.close();
  });

  it('denies when the session resolver throws (fail closed)', async () => {
    const app = await createAdminTestApp({
      resolveSession: () => {
        throw new Error('boom');
      },
      authorize: () => true,
    });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    assert.equal(response.status, 403);
    await app.close();
  });

  it('denies a truthy non-boolean authorize result', async () => {
    const app = await createAdminTestApp({
      // Cast a deliberately wrong return type through `unknown` so the gate's
      // runtime "exact true only" check is exercised against a truthy non-boolean.
      authorize: (() => 'yes') as unknown as (session: Session | null) => boolean,
    });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    assert.equal(response.status, 403);
    await app.close();
  });

  it('denies when authorize throws', async () => {
    const app = await createAdminTestApp({
      authorize: () => {
        throw new Error('nope');
      },
    });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    assert.equal(response.status, 403);
    await app.close();
  });

  it('denies a non-admin (authorize resolves false)', async () => {
    const app = await createAdminTestApp({ authorize: () => false });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    assert.equal(response.status, 403);
    await app.close();
  });

  it('does not leak a distinguishing 404 for an unauthorized nested probe', async () => {
    const app = await createAdminTestApp({
      authorize: () => false,
      pages: [defineAdminPage({ slug: 'settings', label: 'Settings', render: () => 'x' })],
    });
    const response = await app.request(`${DEFAULT_ADMIN_PATH}/settings`);
    assert.equal(response.status, 403);
    await app.close();
  });

  it('does not leak a session id in the forbidden body', async () => {
    const app = await createAdminTestApp({ authorize: () => false });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    const body = await response.text();
    assert.equal(body.includes(SESSION.id), false);
    await app.close();
  });
});

const sessionToken = createServiceToken<AdminSessionService>('test.session');

/** A provider plugin standing in for `@jsails/auth`'s `authPlugin`. */
function sessionProvider(session: Session | null): JsailsPlugin {
  return definePlugin({
    name: 'test-session',
    setup({ services }) {
      services.provide(sessionToken, { resolveSession: async () => session });
    },
  });
}

describe('admin panel built from a session service', () => {
  it('derives its resolver from the service and admits an authorized session', async () => {
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [
          sessionProvider(SESSION),
          adminPlugin(
            defineAdminPanel({ auth: sessionToken, authorize: (session) => session !== null }),
          ),
        ],
      },
    });
    assert.equal((await app.request('/admin')).status, 200);
    await app.close();
  });

  it('denies the admin surface when the service yields no session', async () => {
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [
          sessionProvider(null),
          adminPlugin(
            defineAdminPanel({ auth: sessionToken, authorize: (session) => session !== null }),
          ),
        ],
      },
    });
    assert.equal((await app.request('/admin')).status, 403);
    await app.close();
  });

  it('fails assembly when no extension provides the session service', async () => {
    await assert.rejects(
      createTestApp({
        config: {
          port: 0,
          extensions: [
            adminPlugin(defineAdminPanel({ auth: sessionToken, authorize: () => true })),
          ],
        },
      }),
      /requires service/,
    );
  });
});

const notesResource: Resource = defineResource({
  slug: 'notes',
  label: 'Notes',
  columns: [{ name: 'id', label: 'ID' }],
  fields: [{ name: 'id', label: 'ID', type: 'text' }],
  list: async () => ({ rows: [{ id: '1' }], total: 1 }),
});

const reportsPage = defineAdminPage({
  slug: 'reports',
  label: 'Reports',
  render: () => '<h1>Reports</h1>',
});

const extras = defineAdminPlugin({
  id: 'extras',
  register(builder) {
    builder.addPage(reportsPage);
    builder.addNavigationItem({ label: 'Docs', href: 'https://example.com/docs', group: 'Help' });
    builder.addResource(notesResource);
  },
});

describe('admin plugin contributions', () => {
  it('mounts a contributed page, resource, and navigation item', async () => {
    const app = await createAdminTestApp({ adminPlugins: [extras] });

    const reports = await app.request('/admin/reports');
    assert.equal(reports.status, 200);
    assert.match(await reports.text(), /Reports/);

    const notes = await app.request('/admin/notes');
    assert.equal(notes.status, 200);
    assert.match(await notes.text(), /Notes/);

    const dashboard = await app.request('/admin');
    const body = await dashboard.text();
    assert.match(body, /Reports/);
    assert.match(body, /Notes/);
    assert.match(body, /Docs/);
    assert.match(body, /<h2>Help<\/h2>/);

    await app.close();
  });

  it('rejects a page/resource slug collision at assembly time', async () => {
    const colliding = defineAdminPlugin({
      id: 'colliding',
      register(builder) {
        builder.addPage(defineAdminPage({ slug: 'shared', label: 'Shared', render: () => 'x' }));
        builder.addResource(
          defineResource({
            slug: 'shared',
            label: 'Shared',
            columns: [{ name: 'id', label: 'ID' }],
            fields: [{ name: 'id', label: 'ID', type: 'text' }],
            list: async () => ({ rows: [], total: 0 }),
          }),
        );
      },
    });

    await assert.rejects(
      createAdminTestApp({ adminPlugins: [colliding] }),
      (error: unknown) => error instanceof AdminDefinitionError && error.code === 'duplicate_name',
    );
  });
});
