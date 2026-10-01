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
 * - mutations are refused cross-site (the request's `Origin`; no token);
 * - an upload larger than the app's 1 MiB default reaches the handler's own
 *   per-field limit, the route's form cap being sized from the file fields;
 * - the resource `authorize` and the panel auth gate are default-deny;
 * - a read-only resource (no `save`) rejects mutations with a 405;
 * - unknown ids are 404.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ValidationError } from 'jsails/api';
import { DiskErrors, meterByteSource, resolveDiskRange, type Disk } from 'jsails/filesystem';
import { createTestApp, postForm } from 'jsails/testing';

import {
  adminPlugin,
  defineAdminPanel,
  defineResource,
  type AdminResourceAction,
  type Resource,
  type ResourceField,
} from '../../../src/index.js';
import { resourceFormBytes } from '../../../src/routes/resources/index.js';
import {
  allowAll,
  article,
  createAdminTestApp,
  createArticleStore,
  defineArticleResource,
  SESSION,
} from '../../fixtures.js';

/** A stored file in the {@link memoryDisk} fake. */
interface FakeFile {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
}

/**
 * A Map-backed `Disk` fake recording each stored content type; `keys()` and
 * `bytes(key)` read the map directly for assertions.
 */
function memoryDisk(): Disk & {
  readonly contentTypes: Map<string, string | undefined>;
  keys(): string[];
  bytes(key: string): Uint8Array | undefined;
} {
  const files = new Map<string, FakeFile>();
  const contentTypes = new Map<string, string | undefined>();
  const keys = (prefix: string) =>
    [...files.keys()].filter((key) => prefix === '' || key.startsWith(`${prefix}/`)).sort();
  return {
    contentTypes,
    keys: () => keys(''),
    bytes: (key) => files.get(key)?.bytes,
    async write(key, source, options) {
      const metered = meterByteSource(source, options);
      const chunks: Uint8Array[] = [];
      for await (const chunk of metered.chunks) chunks.push(chunk);
      files.set(key, {
        bytes: new Uint8Array(Buffer.concat(chunks)),
        contentType: options.contentType,
      });
      contentTypes.set(key, options.contentType);
      return metered.result();
    },
    async read(key, options = {}) {
      const file = files.get(key);
      if (file === undefined) throw new DiskErrors.Error('not_found');
      const { start, end } = resolveDiskRange(options.range, file.bytes.byteLength);
      return {
        stream: new Blob([file.bytes.slice(start, end + 1)]).stream(),
        size: file.bytes.byteLength,
        start,
        end,
      };
    },
    async stat(key) {
      const file = files.get(key);
      return file === undefined ? null : { size: file.bytes.byteLength, modifiedAt: new Date(0) };
    },
    async delete(key) {
      files.delete(key);
    },
    async deletePrefix(prefix) {
      for (const key of keys(prefix)) files.delete(key);
    },
    async list(prefix, options) {
      return { keys: keys(prefix).slice(0, options.limit) };
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
    assert.doesNotMatch(body, /name="_csrf"/);
    assert.match(body, /form/);

    await app.close();
  });

  it('rejects a required-missing field with 422 and repopulates submitted values', async () => {
    const store = createArticleStore();
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    // `priority` (required number) is omitted.
    const response = await postForm(app, '/admin/articles', {
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

  it('re-renders a 422 when save rejects the values with a ValidationError', async () => {
    const store = createArticleStore();
    const resource = defineArticleResource(store, {
      save: async () => {
        throw new ValidationError([
          { path: ['title'], code: 'taken', message: 'Title is already in use' },
          { path: [], code: 'conflict', message: 'The record changed meanwhile' },
        ]);
      },
    });
    const app = await createAdminTestApp({ resources: [resource] });

    const response = await postForm(app, '/admin/articles', {
      title: 'Hello',
      status: 'draft',
      priority: '7',
    });
    assert.equal(response.status, 422);
    const body = await response.text();
    assert.match(body, /Title is already in use/);
    assert.match(body, /The record changed meanwhile/);
    assert.match(body, /value="Hello"/);

    await app.close();
  });

  it('maps any other save failure to a 500', async () => {
    const resource = defineArticleResource(createArticleStore(), {
      save: async () => {
        throw new Error('database unavailable');
      },
    });
    const app = await createAdminTestApp({ resources: [resource] });

    const response = await postForm(app, '/admin/articles', {
      title: 'Hello',
      status: 'draft',
      priority: '7',
    });
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /database unavailable/);

    await app.close();
  });

  it('saves coerced, typed values and 303-redirects to the list', async () => {
    const store = createArticleStore();
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    const response = await postForm(app, '/admin/articles', {
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
      { title: 'x', status: 'draft', priority: '1' },
      { origin: 'https://evil.example' },
    );
    assert.equal(response.status, 403);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('rejects a cross-site post, named by Origin or by Sec-Fetch-Site', async () => {
    const store = createArticleStore();
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });
    const fields = { title: 'x', status: 'draft', priority: '1' };

    const foreign = await postForm(app, '/admin/articles', fields, {
      origin: 'https://evil.example',
    });
    assert.equal(foreign.status, 403);

    const fetchSite = await app.request('/admin/articles', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'cross-site',
      },
      body: new URLSearchParams(fields).toString(),
    });
    assert.equal(fetchSite.status, 403);
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
      title: 'x',
      status: 'draft',
      priority: '1',
    });
    assert.equal(create.status, 405);
    assert.match(await create.text(), /read-only/);

    const update = await postForm(app, '/admin/articles/1', {
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
      authorize: allowAll,
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
      title: 'x',
      eventDate: 'not-a-date',
      priority: 'low',
    });
    assert.equal(badDate.status, 422);
    assert.match(await badDate.text(), /Invalid value/);

    const badRadio = await postForm(app, '/admin/events', {
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

  /** A stored key: `<field>/<uuid>/<basename>`. */
  const KEY = /^attachment\/[0-9a-f-]{36}\/report\.txt$/;

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  function fileFields(overrides: Partial<ResourceField> = {}): readonly ResourceField[] {
    return [
      { name: 'title', label: 'Title', type: 'text' },
      {
        name: 'attachment',
        label: 'Attachment',
        type: 'file',
        accept: 'image/*,.txt',
        ...overrides,
      },
    ];
  }

  function makeFileResource(
    store: FileStore,
    resolveFileDisk?: Resource['resolveFileDisk'],
    options: {
      fields?: readonly ResourceField[];
      record?: Record<string, unknown>;
      save?: Resource['save'];
    } = {},
  ): Resource {
    return defineResource({
      authorize: allowAll,
      slug: 'files',
      label: 'Files',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ],
      fields: options.fields ?? fileFields(),
      list: async () => ({ rows: [], total: 0 }),
      get: async ({ id }) => (id === '1' ? (options.record ?? null) : null),
      save:
        options.save ??
        (async ({ id, values }) => {
          store.saves.push({ id, values });
        }),
      ...(resolveFileDisk === undefined ? {} : { resolveFileDisk }),
    });
  }

  function fileForm(
    fields: Record<string, string>,
    file?: { name: string; type: string; bytes: Buffer },
    fieldName = 'attachment',
  ): FormData {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    if (file !== undefined) {
      form.append(
        fieldName,
        new File([new Uint8Array(file.bytes)], file.name, { type: file.type }),
      );
    }
    return form;
  }

  function postFiles(
    app: { origin: string; request: (path: string, init?: RequestInit) => Promise<Response> },
    path: string,
    body: FormData,
  ) {
    return app.request(path, { method: 'POST', headers: { origin: app.origin }, body });
  }

  const report = { name: 'report.txt', type: 'text/plain', bytes: Buffer.from('hello world') };

  it('renders a multipart form with the file input and its accept hint', async () => {
    const app = await createAdminTestApp({ resources: [makeFileResource({ saves: [] })] });

    const body = await (await app.request('/admin/files/new')).text();
    assert.match(body, /enctype="multipart\/form-data"/);
    assert.match(body, /type="file"/);
    assert.match(body, /name="attachment"/);
    assert.match(body, /accept="image\/\*,.txt"/);

    await app.close();
  });

  it('writes the upload through the disk seam under a collision-free key', async () => {
    const disk = memoryDisk();
    const store: FileStore = { saves: [] };
    const app = await createAdminTestApp({
      resources: [makeFileResource(store, () => disk)],
    });

    const first = await postFiles(app, '/admin/files', fileForm({ title: 'A' }, report));
    const second = await postFiles(app, '/admin/files', fileForm({ title: 'B' }, report));
    assert.equal(first.status, 303);
    assert.equal(second.status, 303);

    const keys = store.saves.map((save) => save.values['attachment'] as string);
    assert.match(keys[0]!, KEY);
    assert.match(keys[1]!, KEY);
    // The same filename never maps two records onto one stored object.
    assert.notEqual(keys[0], keys[1]);
    assert.deepEqual(disk.keys(), [...keys].sort());
    assert.deepEqual(disk.bytes(keys[0]!), new Uint8Array(Buffer.from('hello world')));
    assert.equal(disk.contentTypes.get(keys[0]!), 'text/plain');

    await app.close();
  });

  it('stores the sniffed content type, never the declared one', async () => {
    const disk = memoryDisk();
    const store: FileStore = { saves: [] };
    const app = await createAdminTestApp({ resources: [makeFileResource(store, () => disk)] });

    const response = await postFiles(
      app,
      '/admin/files',
      fileForm({ title: 'Logo' }, { name: 'logo.png', type: 'application/x-evil', bytes: PNG }),
    );
    assert.equal(response.status, 303);
    const key = store.saves[0]!.values['attachment'] as string;
    assert.equal(disk.contentTypes.get(key), 'image/png');

    await app.close();
  });

  it('refuses active content and types outside accept without writing', async () => {
    const disk = memoryDisk();
    const store: FileStore = { saves: [] };
    const app = await createAdminTestApp({
      resources: [
        makeFileResource(store, () => disk, { fields: fileFields({ accept: undefined }) }),
      ],
    });

    for (const file of [
      { name: 'page.html', type: 'text/html', bytes: Buffer.from('<p>hi</p>') },
      { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('  <script>alert(1)</script>') },
      { name: 'icon.svg', type: 'image/png', bytes: Buffer.from('x') },
      { name: 'data.bin', type: 'image/svg+xml', bytes: Buffer.from('x') },
    ]) {
      const response = await postFiles(app, '/admin/files', fileForm({ title: 'X' }, file));
      assert.equal(response.status, 422);
      assert.match(await response.text(), /File type is not allowed/);
    }
    await app.close();

    const strict = await createAdminTestApp({
      resources: [
        makeFileResource(store, () => disk, { fields: fileFields({ accept: 'image/*' }) }),
      ],
    });
    const wrongType = await postFiles(strict, '/admin/files', fileForm({ title: 'X' }, report));
    assert.equal(wrongType.status, 422);
    assert.deepEqual(disk.keys(), []);
    assert.equal(store.saves.length, 0);

    await strict.close();
  });

  it('takes an upload above 1 MiB up to the field maxBytes, and its handler limit past that', async () => {
    const MiB = 1024 * 1024;
    const disk = memoryDisk();
    const store: FileStore = { saves: [] };
    const fields = fileFields({ maxBytes: 4 * MiB });
    const app = await createAdminTestApp({
      resources: [makeFileResource(store, () => disk, { fields })],
    });
    const upload = (bytes: number) =>
      fileForm(
        { title: 'Big' },
        { name: 'report.txt', type: 'text/plain', bytes: Buffer.alloc(bytes, 0x61) },
      );

    // Past the app's 1 MiB default: the route's declared form cap admits it.
    const accepted = await postFiles(app, '/admin/files', upload(3 * MiB));
    assert.equal(accepted.status, 303);
    const key = store.saves[0]!.values['attachment'] as string;
    assert.equal(disk.bytes(key)?.byteLength, 3 * MiB);

    // Past the field's own limit but inside the form cap: the handler refuses it.
    const tooLarge = await postFiles(app, '/admin/files', upload(4 * MiB + 1024));
    assert.equal(tooLarge.status, 422);
    assert.match(await tooLarge.text(), /File is too large/);

    // Past the form cap (the file fields' bytes plus framing): 413 before the handler.
    const pastCap = await postFiles(app, '/admin/files', upload(5 * MiB));
    assert.equal(pastCap.status, 413);
    assert.equal(store.saves.length, 1);

    await app.close();
  });

  it('refuses an upload over the field maxBytes', async () => {
    const disk = memoryDisk();
    const store: FileStore = { saves: [] };
    const app = await createAdminTestApp({
      resources: [makeFileResource(store, () => disk, { fields: fileFields({ maxBytes: 4 }) })],
    });

    const response = await postFiles(app, '/admin/files', fileForm({ title: 'X' }, report));
    assert.equal(response.status, 422);
    assert.match(await response.text(), /File is too large/);
    assert.deepEqual(disk.keys(), []);

    await app.close();
  });

  it('writes nothing when the other values fail validation', async () => {
    const disk = memoryDisk();
    const store: FileStore = { saves: [] };
    const app = await createAdminTestApp({ resources: [makeFileResource(store, () => disk)] });

    // `title` is required and missing: the upload must not be written.
    const response = await postFiles(app, '/admin/files', fileForm({}, report));
    assert.equal(response.status, 422);
    assert.deepEqual(disk.keys(), []);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('removes the written upload when save fails', async () => {
    const disk = memoryDisk();
    const store: FileStore = { saves: [] };
    const app = await createAdminTestApp({
      resources: [
        makeFileResource(store, () => disk, {
          save: async () => {
            throw new Error('database down');
          },
        }),
      ],
      onError: () => {},
    });

    const response = await postFiles(app, '/admin/files', fileForm({ title: 'X' }, report));
    assert.equal(response.status, 500);
    assert.deepEqual(disk.keys(), []);

    await app.close();
  });

  it('keeps the stored key when an edit does not re-select the file', async () => {
    const disk = memoryDisk();
    const store: FileStore = { saves: [] };
    const record = { id: '1', title: 'Old', attachment: 'attachment/stored/report.txt' };
    const app = await createAdminTestApp({
      resources: [makeFileResource(store, () => disk, { record })],
    });

    const edit = await (await app.request('/admin/files/1')).text();
    assert.match(edit, /type="hidden" name="attachment" value="attachment\/stored\/report.txt"/);

    // A browser submits the untouched file input as an empty, unnamed part.
    const untouched = fileForm({ title: 'New' });
    untouched.append('attachment', new File([], ''));
    assert.equal((await postFiles(app, '/admin/files/1', untouched)).status, 303);
    // The form's hidden current key alone also keeps it.
    const withHidden = fileForm({
      title: 'Newer',
      attachment: 'attachment/stored/report.txt',
    });
    assert.equal((await postFiles(app, '/admin/files/1', withHidden)).status, 303);

    assert.deepEqual(
      store.saves.map((save) => save.values['attachment']),
      ['attachment/stored/report.txt', 'attachment/stored/report.txt'],
    );
    assert.deepEqual(disk.keys(), []);

    await app.close();
  });

  it('never accepts a client-chosen key in place of an upload', async () => {
    const disk = memoryDisk();
    const store: FileStore = { saves: [] };
    const record = { id: '1', title: 'Old', attachment: 'attachment/stored/report.txt' };
    const app = await createAdminTestApp({
      resources: [makeFileResource(store, () => disk, { record })],
    });

    // On create there is no stored key, so a submitted string is dropped and
    // the required file is missing.
    const create = await postFiles(
      app,
      '/admin/files',
      fileForm({ title: 'X', attachment: 'attachment/other/secret.pdf' }),
    );
    assert.equal(create.status, 422);
    assert.match(await create.text(), /This field is required/);

    // On update a foreign key falls back to the record's own key.
    const update = await postFiles(
      app,
      '/admin/files/1',
      fileForm({ title: 'X', attachment: 'attachment/other/secret.pdf' }),
    );
    assert.equal(update.status, 303);
    assert.equal(store.saves[0]!.values['attachment'], 'attachment/stored/report.txt');

    await app.close();
  });

  it('writes a formset row upload and keeps a row key on edit', async () => {
    const disk = memoryDisk();
    const store: FileStore = { saves: [] };
    const fields: readonly ResourceField[] = [
      {
        name: 'docs',
        label: 'Docs',
        type: 'repeater',
        formset: { fields: [{ name: 'file', label: 'File', type: 'file' }], maxItems: 3 },
      },
    ];
    const record = { id: '1', docs: [{ file: 'docs/stored/a.txt' }] };
    const app = await createAdminTestApp({
      resources: [makeFileResource(store, () => disk, { fields, record })],
    });

    const edit = await (await app.request('/admin/files/1')).text();
    assert.match(edit, /enctype="multipart\/form-data"/);
    assert.match(edit, /type="hidden" name="docs\[0\].file" value="docs\/stored\/a.txt"/);

    const form = fileForm({ 'docs[0].file': 'docs/stored/a.txt' }, report, 'docs[1].file');
    const response = await postFiles(app, '/admin/files/1', form);
    assert.equal(response.status, 303);
    const docs = store.saves[0]!.values['docs'] as Array<{ file: string }>;
    assert.equal(docs[0]!.file, 'docs/stored/a.txt');
    assert.match(docs[1]!.file, /^docs_1_.file\/[0-9a-f-]{36}\/report\.txt$/);
    assert.deepEqual(disk.keys(), [docs[1]!.file]);

    await app.close();
  });

  it('stores the sanitized basename when no disk is wired', async () => {
    const store: FileStore = { saves: [] };
    const app = await createAdminTestApp({ resources: [makeFileResource(store)] });

    const response = await postFiles(
      app,
      '/admin/files',
      fileForm(
        { title: 'Report' },
        { name: '../../etc/report.txt', type: 'text/plain', bytes: Buffer.from('x') },
      ),
    );
    assert.equal(response.status, 303);
    // The basename is kept (path separators are stripped), never a traversal path.
    assert.equal(store.saves[0]!.values['attachment'], 'report.txt');

    await app.close();
  });
});

describe('admin mutations behind a TLS-terminating proxy', () => {
  it('accepts a post whose Origin matches the configured server.origin', async () => {
    const store = createArticleStore();
    const panel = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
      resources: [defineArticleResource(store)],
    });
    // The app sees plain http:// while the browser posts from https://.
    const app = await createTestApp({
      origin: 'http://admin.example',
      config: {
        port: 0,
        server: { origin: 'https://admin.example' },
        extensions: [adminPlugin(panel)],
      },
    });
    const body = new URLSearchParams({ title: 'T', status: 'draft', priority: '1' });
    const response = await app.request('/admin/articles', {
      method: 'POST',
      headers: {
        origin: 'https://admin.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    assert.equal(response.status, 303);
    assert.equal(store.saves.length, 1);

    await app.close();
  });
});

describe('resource form cap', () => {
  const MiB = 1024 * 1024;
  const resource = (fields: readonly ResourceField[]) =>
    defineResource({
      authorize: allowAll,
      slug: 'r',
      label: 'R',
      columns: [{ name: 'id', label: 'ID' }],
      fields,
      list: async () => ({ rows: [], total: 0 }),
    });

  it('sums the file fields, a formset once per row, plus framing, within 1 to 100 MiB', () => {
    const text: ResourceField = { name: 'title', label: 'Title', type: 'text' };
    assert.equal(resourceFormBytes(resource([text])), MiB);
    assert.equal(
      resourceFormBytes(resource([{ name: 'a', label: 'A', type: 'file', maxBytes: 1024 }])),
      MiB,
    );
    assert.equal(
      resourceFormBytes(resource([{ name: 'a', label: 'A', type: 'file' }])),
      10 * MiB + 64 * 1024,
    );
    assert.equal(
      resourceFormBytes(
        resource([
          { name: 'a', label: 'A', type: 'file', maxBytes: 2 * MiB },
          {
            name: 'docs',
            label: 'Docs',
            type: 'repeater',
            formset: {
              fields: [{ name: 'file', label: 'File', type: 'file', maxBytes: MiB }],
              maxItems: 3,
            },
          },
        ]),
      ),
      5 * MiB + 64 * 1024,
    );
    const many = Array.from({ length: 20 }, (_, index): ResourceField => ({
      name: `f${index}`,
      label: `F${index}`,
      type: 'file',
    }));
    assert.equal(resourceFormBytes(resource(many)), 100 * MiB);
  });
});
