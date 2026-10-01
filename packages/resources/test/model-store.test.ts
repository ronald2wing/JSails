/**
 * End-to-end tests for a model resource: requests go through the generated
 * handlers into the row-scoped store and an on-disk SQLite database.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { integer, string, type ResourceAuthorize } from 'jsails/api';
import { qEq, type JsailsDataSource } from 'jsails/database';

import { defineModelResource, scopedBy, unscoped } from '../src/index.js';
import {
  call,
  createNoteDataSource,
  defineNoteEntity,
  ownerOf,
  sessionFor,
  type NoteRecord,
} from './fixtures.js';

const Note = defineNoteEntity('store_note');
const allow: ResourceAuthorize<NoteRecord> = () => true;
const ALICE = sessionFor(1);
const BOB = sessionFor(2);

const notes = defineModelResource(Note, {
  name: 'notes',
  fields: {
    id: { schema: integer(), access: 'read', sort: true },
    title: { schema: string({ min: 1, max: 200 }), access: 'readWrite', sort: true, search: true },
    body: { schema: string({ optional: true }), access: 'readWrite', search: true },
    rank: {
      schema: integer({ optional: true }),
      access: 'readWrite',
      sort: true,
      filter: { type: 'integer', operators: ['eq', 'gte', 'lt', 'in'] },
    },
    ownerId: { schema: integer(), access: 'read' },
    secret: { schema: string({ optional: true }), access: 'write' },
  },
  scope: scopedBy((context) => {
    const owner = ownerOf(context);
    return owner === null ? null : qEq('ownerId', owner);
  }),
  stamp: { ownerId: (context) => ownerOf(context) },
  defaultSort: [{ field: 'rank', direction: 'desc' }],
  authorize: allow,
});

const { collection, detail } = notes.handlers;

type Page = { results: Record<string, unknown>[]; count: number };

async function list(path: string, session = ALICE): Promise<Page> {
  const response = await call(collection.GET, 'GET', path, { session });
  assert.equal(response.status, 200);
  return response.body as Page;
}

async function seed(ownerId: number, title: string, rank: number, body = ''): Promise<number> {
  const row = Note.create({ title, rank, body, ownerId, secret: `hash-${title}` });
  await row.save();
  return row.id;
}

describe('model resource over SQLite', () => {
  let dataSource: JsailsDataSource;
  let aliceFirst: number;
  let bobOnly: number;

  beforeEach(async () => {
    dataSource = await createNoteDataSource(Note);
    aliceFirst = await seed(1, 'Alpha', 3, 'first body');
    await seed(1, 'Beta 100%', 1);
    await seed(1, 'Gamma_x', 2);
    bobOnly = await seed(2, 'Bob note', 9);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('lists only rows in scope, in the default order, without write-only fields', async () => {
    const page = await list('/api/notes');
    assert.equal(page.count, 3);
    assert.deepEqual(
      page.results.map((row) => row['title']),
      ['Alpha', 'Gamma_x', 'Beta 100%'],
    );
    for (const row of page.results) {
      assert.deepEqual(Object.keys(row).sort(), ['body', 'id', 'ownerId', 'rank', 'title']);
    }
  });

  it('treats a null scope as no rows', async () => {
    const response = await call(collection.GET, 'GET', '/api/notes', { session: null });
    assert.equal(response.status, 200);
    assert.equal((response.body as Page).count, 0);
    const missing = await call(detail.GET, 'GET', `/api/notes/${aliceFirst}`, {
      params: { id: String(aliceFirst) },
    });
    assert.equal(missing.status, 404);
  });

  it('applies declared sorts and filters, and the count matches them', async () => {
    const sorted = await list('/api/notes?sort=title');
    assert.deepEqual(
      sorted.results.map((row) => row['title']),
      ['Alpha', 'Beta 100%', 'Gamma_x'],
    );
    const ranged = await list('/api/notes?filter[rank][gte]=2&sort=-rank');
    assert.equal(ranged.count, 2);
    assert.deepEqual(
      ranged.results.map((row) => row['rank']),
      [3, 2],
    );
    const either = await list('/api/notes?filter[rank][in]=1&filter[rank][in]=3');
    assert.equal(either.count, 2);
  });

  it('rejects sorting or filtering an undeclared or write-only field', async () => {
    for (const query of [
      'sort=secret',
      'sort=body',
      'filter[secret][gte]=a',
      'filter[ownerId]=2',
      'filter[rank][neq]=1',
    ]) {
      const response = await call(collection.GET, 'GET', `/api/notes?${query}`, { session: ALICE });
      assert.equal(response.status, 400, query);
    }
  });

  it('searches declared text fields literally', async () => {
    assert.equal((await list('/api/notes?search=100%25')).count, 1);
    assert.equal((await list('/api/notes?search=a_x')).count, 1);
    assert.equal((await list('/api/notes?search=_')).count, 1);
    assert.equal((await list('/api/notes?search=first')).count, 1);
    assert.equal((await list('/api/notes?search=Bob')).count, 0);
  });

  it('answers 404 for a row outside the scope or a malformed id', async () => {
    for (const id of [String(bobOnly), '0', '01', '1e3', '-1', 'abc', '99999999999999999999']) {
      for (const handler of [detail.GET, detail.PATCH, detail.DELETE]) {
        const response = await call(handler, handler === detail.GET ? 'GET' : 'PATCH', '/x', {
          session: ALICE,
          params: { id },
          body: handler === detail.PATCH ? { title: 'stolen' } : undefined,
        });
        assert.equal(response.status, 404, id);
      }
    }
    const untouched = await Note.findOneByOrFail({ id: bobOnly });
    assert.equal(untouched.title, 'Bob note');
  });

  it('creates with the stamped owner and refuses a client-sent owner', async () => {
    const forged = await call(collection.POST, 'POST', '/api/notes', {
      session: ALICE,
      body: { title: 'Forged', ownerId: 2 },
    });
    assert.equal(forged.status, 400);
    assert.equal(await Note.countBy({ title: 'Forged' }), 0);

    const created = await call(collection.POST, 'POST', '/api/notes', {
      session: ALICE,
      body: { title: 'New', secret: 'pw' },
    });
    assert.equal(created.status, 201);
    const body = created.body as Record<string, unknown>;
    assert.equal(body['ownerId'], 1);
    assert.equal('secret' in body, false);
    const stored = await Note.findOneByOrFail({ id: body['id'] as number });
    assert.equal(stored.ownerId, 1);
    assert.equal(stored.secret, 'pw');
  });

  it('refuses a body field that is not declared', async () => {
    const response = await call(collection.POST, 'POST', '/api/notes', {
      session: ALICE,
      body: { title: 'New', meta: { admin: true } },
    });
    assert.equal(response.status, 400);
    assert.equal(await Note.countBy({ title: 'New' }), 0);
  });

  it('updates writable fields of an in-scope row and refuses read-only ones', async () => {
    for (const body of [{ ownerId: 2 }, { id: 77 }]) {
      const refused = await call(detail.PATCH, 'PATCH', '/x', {
        session: ALICE,
        params: { id: String(aliceFirst) },
        body,
      });
      assert.equal(refused.status, 400);
    }
    const response = await call(detail.PATCH, 'PATCH', '/x', {
      session: ALICE,
      params: { id: String(aliceFirst) },
      body: { title: 'Renamed' },
    });
    assert.equal(response.status, 200);
    const stored = await Note.findOneByOrFail({ id: aliceFirst });
    assert.equal(stored.title, 'Renamed');
    assert.equal(stored.ownerId, 1);
  });

  it('deletes only an in-scope row', async () => {
    const theirs = await call(detail.DELETE, 'DELETE', '/x', {
      session: ALICE,
      params: { id: String(bobOnly) },
    });
    assert.equal(theirs.status, 404);
    const mine = await call(detail.DELETE, 'DELETE', '/x', {
      session: BOB,
      params: { id: String(bobOnly) },
    });
    assert.equal(mine.status, 204);
    assert.equal(await Note.countBy({ id: bobOnly }), 0);
  });

  it('serves every row through an explicit unscoped resource', async () => {
    const catalogue = defineModelResource(Note, {
      name: 'catalogue',
      fields: {
        id: { schema: integer(), access: 'read' },
        title: { schema: string(), access: 'read' },
      },
      scope: unscoped('public catalogue'),
      authorize: allow,
    });
    const response = await call(catalogue.handlers.collection.GET, 'GET', '/api/catalogue');
    assert.equal((response.body as Page).count, 4);
  });

  it('rejects a search on a resource without searchable fields', async () => {
    const plain = defineModelResource(Note, {
      name: 'plain',
      fields: { id: { schema: integer(), access: 'read' } },
      scope: unscoped('test fixture'),
      authorize: allow,
    });
    const response = await call(plain.handlers.collection.GET, 'GET', '/api/plain?search=x');
    assert.equal(response.status, 400);
  });

  it('refuses a create on a read-only resource without touching the table', async () => {
    const catalogue = defineModelResource(Note, {
      name: 'catalogue',
      fields: {
        id: { schema: integer(), access: 'read' },
        title: { schema: string(), access: 'read' },
      },
      scope: unscoped('public catalogue'),
      actions: ['list', 'retrieve'],
      authorize: allow,
    });
    const response = await call(catalogue.handlers.collection.POST, 'POST', '/api/catalogue', {
      session: ALICE,
      body: {},
    });
    assert.equal(response.status, 405);
    assert.equal(await Note.count(), 4);
  });
});
