/**
 * Tests for the resource create/update routes driven through the real admin
 * plugin over the in-memory article resource:
 *
 * - create rejects required-missing and unknown fields with a 422 that
 *   repopulates submitted values, and a valid create saves the coerced, typed
 *   values then 303-redirects to the list;
 * - update loads the existing record into the form and saves the new values;
 * - date, datetime, checkbox, radio, and file fields coerce through the same
 *   path, and an upload is written through the `resolveFileDisk` seam;
 * - mutations enforce same-origin `Origin` and a constant-time `_csrf` check;
 * - the resource `authorize` and the panel auth gate are default-deny;
 * - a read-only resource (no `save`) rejects mutations with a 405;
 * - unknown ids are 404.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Disk } from 'jsails/filesystem';
import { postForm } from 'jsails/testing';

import {
  defineResource,
  type AdminResourceAction,
  type Resource,
  type ResourceField,
} from '../../../src/index.js';
import {
  article,
  createAdminTestApp,
  createArticleStore,
  CSRF,
  defineArticleResource,
} from '../../fixtures.js';

/** A Map-backed `Disk` fake: enough of the contract for the upload seam. */
function memoryDisk(): Disk {
  const files = new Map<string, Uint8Array>();
  return {
    async put(key, data) {
      files.set(
        key,
        typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data),
      );
    },
    async get(key) {
      const bytes = files.get(key);
      if (bytes === undefined) throw new Error('not found');
      return bytes;
    },
    async exists(key) {
      return files.has(key);
    },
    async delete(key) {
      files.delete(key);
    },
    async list(prefix = '') {
      return [...files.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
    async size(key) {
      return files.get(key)?.byteLength ?? 0;
    },
  };
}

describe('admin resource create', () => {
  it('renders the empty create form', async () => {
    const app = await createAdminTestApp({
      resources: [defineArticleResource(createArticleStore())],
    });

    const response = await app.request('/admin/articles/new');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /New Articles/);
    assert.match(body, /name="_csrf"/);
    assert.match(body, /form/);

    await app.close();
  });

  it('rejects a required-missing field with 422 and repopulates submitted values', async () => {
    const store = createArticleStore();
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    // `priority` (required number) is omitted.
    const response = await postForm(app, '/admin/articles', {
      _csrf: CSRF,
      title: 'Hello',
      status: 'draft',
    });
    assert.equal(response.status, 422);
    const body = await response.text();
    assert.match(body, /This field is required/);
    // The submitted title is repopulated into the form.
    assert.match(body, /value="Hello"/);
    // Save must not have run.
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('rejects an unknown field with 422 and never echoes it', async () => {
    const store = createArticleStore();
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    const response = await postForm(app, '/admin/articles', {
      _csrf: CSRF,
      title: 'Hello',
      status: 'draft',
      priority: '7',
      hacker: 'injected',
    });
    assert.equal(response.status, 422);
    const body = await response.text();
    // The strict schema rejects the unknown key, the known values are
    // repopulated, and the unknown value is never echoed back.
    assert.match(body, /value="Hello"/);
    assert.match(body, /value="7"/);
    assert.doesNotMatch(body, /injected/);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('saves coerced, typed values and 303-redirects to the list', async () => {
    const store = createArticleStore();
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    const response = await postForm(app, '/admin/articles', {
      _csrf: CSRF,
      title: 'Hello World',
      status: 'published',
      priority: '7',
      active: 'on',
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/admin/articles');

    assert.equal(store.saves.length, 1);
    const saved = store.saves[0]!;
    assert.equal(saved.id, null);
    assert.equal(saved.values['title'], 'Hello World');
    // The numeric string is coerced to a real number.
    assert.equal(saved.values['priority'], 7);
    assert.equal(typeof saved.values['priority'], 'number');
    assert.equal(saved.values['status'], 'published');
    // The toggle submission coerces to a boolean true.
    assert.equal(saved.values['active'], true);
    // The omitted optional field parses to undefined.
    assert.equal(saved.values['description'], undefined);
    // The record was appended to the in-memory store.
    assert.equal(store.rows.length, 1);

    await app.close();
  });

  it('coerces an absent toggle to false', async () => {
    const store = createArticleStore();
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    const response = await postForm(app, '/admin/articles', {
      _csrf: CSRF,
      title: 'No Toggle',
      status: 'draft',
      priority: '1',
    });
    assert.equal(response.status, 303);
    assert.equal(store.saves[0]!.values['active'], false);

    await app.close();
  });
});

describe('admin resource update', () => {
  it('loads the existing record into the edit form and saves new values', async () => {
    const store = createArticleStore([
      article('1', { title: 'First', status: 'draft', priority: 1, active: false }),
    ]);
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    const edit = await app.request('/admin/articles/1');
    assert.equal(edit.status, 200);
    const editBody = await edit.text();
    assert.match(editBody, /Edit Articles/);
    // The existing values are loaded into the form inputs.
    assert.match(editBody, /value="First"/);
    assert.match(editBody, /value="1"/);
    assert.deepEqual(store.getCalls, [{ id: '1' }]);

    const update = await postForm(app, '/admin/articles/1', {
      _csrf: CSRF,
      title: 'First Updated',
      status: 'published',
      priority: '9',
      active: 'on',
    });
    assert.equal(update.status, 303);
    assert.equal(update.headers.get('location'), '/admin/articles');

    assert.equal(store.saves.length, 1);
    const saved = store.saves[0]!;
    assert.equal(saved.id, '1');
    assert.equal(saved.values['title'], 'First Updated');
    assert.equal(saved.values['priority'], 9);
    assert.equal(saved.values['status'], 'published');
    assert.equal(saved.values['active'], true);

    await app.close();
  });
});

describe('admin resource mutation guards', () => {
  it('rejects a POST without an Origin header', async () => {
    const store = createArticleStore();
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    const response = await app.request('/admin/articles', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf: CSRF,
        title: 'x',
        status: 'draft',
        priority: '1',
      }).toString(),
    });
    assert.equal(response.status, 403);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('rejects a cross-origin POST', async () => {
    const store = createArticleStore();
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    const response = await postForm(
      app,
      '/admin/articles',
      { _csrf: CSRF, title: 'x', status: 'draft', priority: '1' },
      { origin: 'https://evil.example' },
    );
    assert.equal(response.status, 403);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('rejects a missing or invalid CSRF token', async () => {
    const store = createArticleStore();
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    const missing = await postForm(app, '/admin/articles', {
      title: 'x',
      status: 'draft',
      priority: '1',
    });
    assert.equal(missing.status, 403);

    const invalid = await postForm(app, '/admin/articles', {
      _csrf: 'wrong-token',
      title: 'x',
      status: 'draft',
      priority: '1',
    });
    assert.equal(invalid.status, 403);
    assert.equal(store.saves.length, 0);

    await app.close();
  });
});

describe('admin resource authorization', () => {
  it('denies each action independently when the resource authorize rejects it', async () => {
    const cases: ReadonlyArray<{
      action: AdminResourceAction;
      method: 'GET' | 'POST';
      path: string;
    }> = [
      { action: 'list', method: 'GET', path: '/admin/articles' },
      { action: 'create', method: 'POST', path: '/admin/articles' },
      { action: 'view', method: 'GET', path: '/admin/articles/1' },
      { action: 'update', method: 'POST', path: '/admin/articles/1' },
    ];

    for (const c of cases) {
      const store = createArticleStore([article('1', { title: 'First' })]);
      const resource = defineArticleResource(store, {
        authorize: (ctx) => ctx.action !== c.action,
      });
      const app = await createAdminTestApp({ resources: [resource] });

      const response =
        c.method === 'GET'
          ? await app.request(c.path)
          : await postForm(app, c.path, {
              _csrf: CSRF,
              title: 'x',
              status: 'draft',
              priority: '1',
            });
      assert.equal(response.status, 403, `action ${c.action} must be denied`);
      assert.equal(store.saves.length, 0);

      await app.close();
    }
  });

  it('default-allows when no resource authorize is declared', async () => {
    const store = createArticleStore([article('1', { title: 'First' })]);
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    assert.equal((await app.request('/admin/articles')).status, 200);

    await app.close();
  });

  it('denies when the resource authorize callback throws', async () => {
    const store = createArticleStore([article('1', { title: 'First' })]);
    const resource = defineArticleResource(store, {
      authorize: () => {
        throw new Error('boom');
      },
    });
    const app = await createAdminTestApp({ resources: [resource] });

    assert.equal((await app.request('/admin/articles')).status, 403);

    await app.close();
  });

  it('denies a resource route for a non-admin session', async () => {
    const store = createArticleStore([article('1', { title: 'First' })]);
    const app = await createAdminTestApp({
      resources: [defineArticleResource(store)],
      authorize: () => false,
    });

    assert.equal((await app.request('/admin/articles')).status, 403);

    await app.close();
  });
});

describe('admin resource read-only', () => {
  it('rejects create and update posts with 405 when save is absent', async () => {
    const store = createArticleStore([article('1', { title: 'First' })]);
    const resource = defineArticleResource(store, { save: undefined });
    const app = await createAdminTestApp({ resources: [resource] });

    const create = await postForm(app, '/admin/articles', {
      _csrf: CSRF,
      title: 'x',
      status: 'draft',
      priority: '1',
    });
    assert.equal(create.status, 405);
    assert.match(await create.text(), /read-only/);

    const update = await postForm(app, '/admin/articles/1', {
      _csrf: CSRF,
      title: 'x',
      status: 'draft',
      priority: '1',
    });
    assert.equal(update.status, 405);

    // The list still renders (read-only lists are allowed).
    assert.equal((await app.request('/admin/articles')).status, 200);
    assert.equal(store.saves.length, 0);

    await app.close();
  });
});

describe('admin resource unknown id', () => {
  it('returns 404 for an unknown edit id and an unknown update id', async () => {
    const store = createArticleStore([article('1', { title: 'First' })]);
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    const edit = await app.request('/admin/articles/999');
    assert.equal(edit.status, 404);

    const update = await app.request('/admin/articles/999', {
      method: 'POST',
      headers: { origin: app.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: 'x', status: 'draft', priority: '1' }).toString(),
    });
    assert.equal(update.status, 404);
    assert.equal(store.saves.length, 0);

    await app.close();
  });
});

describe('admin resource field types', () => {
  const EVENT_FIELDS: readonly ResourceField[] = [
    { name: 'title', label: 'Title', type: 'text' },
    { name: 'eventDate', label: 'Event date', type: 'date' },
    { name: 'startsAt', label: 'Starts at', type: 'datetime', required: false },
    { name: 'approved', label: 'Approved', type: 'checkbox' },
    {
      name: 'priority',
      label: 'Priority',
      type: 'radio',
      options: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' },
      ],
    },
  ];

  function makeEventResource(saves: Record<string, unknown>[]): Resource {
    return defineResource({
      slug: 'events',
      label: 'Events',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ],
      fields: EVENT_FIELDS,
      list: async () => ({ rows: [], total: 0 }),
      save: async ({ values }) => {
        saves.push(values);
      },
    });
  }

  it('renders the date, datetime, checkbox, and radio input kinds', async () => {
    const app = await createAdminTestApp({ resources: [makeEventResource([])] });
    const response = await app.request('/admin/events/new');
    const body = await response.text();
    assert.match(body, /type="date"/);
    assert.match(body, /type="datetime-local"/);
    assert.match(body, /type="checkbox"/);
    assert.match(body, /type="radio"/);
    assert.match(body, /value="high"/);
    await app.close();
  });

  it('coerces date, datetime, checkbox, and radio submissions into typed values', async () => {
    const saves: Record<string, unknown>[] = [];
    const app = await createAdminTestApp({ resources: [makeEventResource(saves)] });

    const response = await postForm(app, '/admin/events', {
      _csrf: CSRF,
      title: 'Launch',
      eventDate: '2024-01-15',
      startsAt: '2024-01-15T13:45',
      approved: '1',
      priority: 'high',
    });
    assert.equal(response.status, 303);
    assert.deepEqual(saves[0], {
      title: 'Launch',
      eventDate: '2024-01-15',
      startsAt: '2024-01-15T13:45',
      approved: true,
      priority: 'high',
    });

    await app.close();
  });

  it('coerces an absent checkbox to false and a blank optional datetime to undefined', async () => {
    const saves: Record<string, unknown>[] = [];
    const app = await createAdminTestApp({ resources: [makeEventResource(saves)] });

    const response = await postForm(app, '/admin/events', {
      _csrf: CSRF,
      title: 'No approval',
      eventDate: '2024-01-15',
      priority: 'low',
    });
    assert.equal(response.status, 303);
    assert.equal(saves[0]!['approved'], false);
    assert.equal(saves[0]!['startsAt'], undefined);

    await app.close();
  });

  it('rejects an invalid date and an invalid radio option with 422', async () => {
    const saves: Record<string, unknown>[] = [];
    const app = await createAdminTestApp({ resources: [makeEventResource(saves)] });

    const badDate = await postForm(app, '/admin/events', {
      _csrf: CSRF,
      title: 'x',
      eventDate: 'not-a-date',
      priority: 'low',
    });
    assert.equal(badDate.status, 422);
    assert.match(await badDate.text(), /Invalid value/);

    const badRadio = await postForm(app, '/admin/events', {
      _csrf: CSRF,
      title: 'x',
      eventDate: '2024-01-15',
      priority: 'urgent',
    });
    assert.equal(badRadio.status, 422);
    assert.equal(saves.length, 0);

    await app.close();
  });
});

describe('admin file fields', () => {
  interface FileStore {
    saves: Array<{ id: string | null; values: Record<string, unknown> }>;
  }

  const FILE_FIELDS: readonly ResourceField[] = [
    { name: 'title', label: 'Title', type: 'text' },
    { name: 'attachment', label: 'Attachment', type: 'file', accept: 'image/*' },
  ];

  function makeFileResource(
    store: FileStore,
    resolveFileDisk?: Resource['resolveFileDisk'],
  ): Resource {
    return defineResource({
      slug: 'files',
      label: 'Files',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ],
      fields: FILE_FIELDS,
      list: async () => ({ rows: [], total: 0 }),
      save: async ({ id, values }) => {
        store.saves.push({ id, values });
      },
      ...(resolveFileDisk === undefined ? {} : { resolveFileDisk }),
    });
  }

  function fileForm(
    fields: Record<string, string>,
    file?: { name: string; type: string; bytes: Buffer },
  ): FormData {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.set(key, value);
    }
    if (file !== undefined) {
      form.set(
        'attachment',
        new File([new Uint8Array(file.bytes)], file.name, { type: file.type }),
      );
    }
    return form;
  }

  it('renders a file input with its accept hint', async () => {
    const app = await createAdminTestApp({ resources: [makeFileResource({ saves: [] })] });

    const body = await (await app.request('/admin/files/new')).text();
    assert.match(body, /type="file"/);
    assert.match(body, /name="attachment"/);
    assert.match(body, /accept="image\/\*"/);

    await app.close();
  });

  it('writes the upload through the disk seam and stores the resulting key', async () => {
    const disk = memoryDisk();
    const store: FileStore = { saves: [] };
    const app = await createAdminTestApp({
      resources: [makeFileResource(store, () => disk)],
    });

    const response = await app.request('/admin/files', {
      method: 'POST',
      headers: { origin: app.origin },
      body: fileForm(
        { _csrf: CSRF, title: 'Report' },
        { name: 'report.txt', type: 'text/plain', bytes: Buffer.from('hello world') },
      ),
    });
    assert.equal(response.status, 303);

    assert.equal(store.saves.length, 1);
    assert.equal(store.saves[0]!.values['attachment'], 'attachment/report.txt');
    assert.deepEqual(await disk.list(), ['attachment/report.txt']);
    assert.deepEqual(
      await disk.get('attachment/report.txt'),
      new Uint8Array(Buffer.from('hello world')),
    );

    await app.close();
  });

  it('stores the sanitized basename when no disk is wired', async () => {
    const store: FileStore = { saves: [] };
    const app = await createAdminTestApp({ resources: [makeFileResource(store)] });

    const response = await app.request('/admin/files', {
      method: 'POST',
      headers: { origin: app.origin },
      body: fileForm(
        { _csrf: CSRF, title: 'Report' },
        { name: '../../etc/report.txt', type: 'text/plain', bytes: Buffer.from('x') },
      ),
    });
    assert.equal(response.status, 303);
    // The basename is kept (path separators are stripped), never a traversal path.
    assert.equal(store.saves[0]!.values['attachment'], 'report.txt');

    await app.close();
  });
});
