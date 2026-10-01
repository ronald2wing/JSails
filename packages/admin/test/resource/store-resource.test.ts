/**
 * Tests for `defineStoreResource`: the `list`/`get`/`save` callbacks it
 * synthesizes from a `ResourceStore` plus a `Serializer`, the store query it
 * builds from the admin list state, the serializer validation every save runs,
 * and its value-free definition errors.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineStoreResource, AdminDefinitionError } from '../../src/index.js';
import { ValidationError } from 'jsails/api';
import type { NormalizedQuery, ResourceStore, Serializer } from 'jsails/api';
import type { RequestContext, Session } from 'jsails';
import type {
  ResourceListContext,
  ResourceGetContext,
  ResourceSaveContext,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SESSION: Session = {
  id: 'test-session',
  csrfToken: 'csrf-token',
  data: {},
  expiresAt: 2_000_000_000_000,
};

function listContext(overrides: Partial<ResourceListContext> = {}): ResourceListContext {
  return {
    session: SESSION,
    page: 1,
    pageSize: 10,
    ...overrides,
  };
}

function getContext(id: string): ResourceGetContext {
  return { session: SESSION, id };
}

function saveContext(id: string | null, values: Record<string, unknown>): ResourceSaveContext {
  return { session: SESSION, id, values };
}

interface TestRecord {
  id: number;
  name: string;
  active: boolean;
}

interface SpyStore {
  countCalls: number;
  countQueries: NormalizedQuery[];
  listCalls: Array<{
    offset: number;
    limit: number;
    context: RequestContext;
    query: NormalizedQuery;
  }>;
  getCalls: Array<{ id: string; context: RequestContext }>;
  createCalls: Array<{ data: unknown; context: RequestContext }>;
  updateCalls: Array<{ id: string; data: unknown; context: RequestContext }>;
  rows: TestRecord[];
}

function makeStore(): { store: ResourceStore<TestRecord, any, any>; spy: SpyStore } {
  const spy: SpyStore = {
    countCalls: 0,
    countQueries: [],
    listCalls: [],
    getCalls: [],
    createCalls: [],
    updateCalls: [],
    rows: [],
  };

  const store: ResourceStore<TestRecord, any, any> = {
    async count(_context: RequestContext, query: NormalizedQuery): Promise<number> {
      spy.countCalls++;
      spy.countQueries.push(query);
      return spy.rows.length;
    },
    async list(
      offset: number,
      limit: number,
      context: RequestContext,
      query: NormalizedQuery,
    ): Promise<TestRecord[]> {
      spy.listCalls.push({ offset, limit, context, query });
      return spy.rows.slice(offset, offset + limit);
    },
    async get(id: string, context: RequestContext): Promise<TestRecord | null> {
      spy.getCalls.push({ id, context });
      const numId = Number(id);
      return spy.rows.find((r) => r.id === numId) ?? null;
    },
    async create(data: any, context: RequestContext): Promise<TestRecord> {
      spy.createCalls.push({ data, context });
      const record = { ...data, id: spy.rows.length + 1 };
      spy.rows.push(record);
      return record;
    },
    async update(id: string, data: any, context: RequestContext): Promise<TestRecord | null> {
      spy.updateCalls.push({ id, data, context });
      const idx = spy.rows.findIndex((r) => r.id === Number(id));
      if (idx === -1) return null;
      spy.rows[idx] = { ...spy.rows[idx]!, ...data };
      return spy.rows[idx]!;
    },
    async delete(_id: string, _context: RequestContext): Promise<void> {
      // noop
    },
  };

  return { store, spy };
}

function makeSerializer(): Serializer<any, any> {
  return {
    fields: {},
    validate(input: unknown): any {
      return input;
    },
    toRepresentation(data: unknown): any {
      return data;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('defineStoreResource', () => {
  it('synthesizes list that derives offset from page/pageSize', async () => {
    const { store, spy } = makeStore();
    spy.rows.push(
      { id: 1, name: 'Alice', active: true },
      { id: 2, name: 'Bob', active: false },
      { id: 3, name: 'Carol', active: true },
    );

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    const result = await resource.list(listContext({ page: 2, pageSize: 2 }));

    assert.equal(result.total, 3);
    assert.equal(result.rows.length, 1);
    assert.equal((result.rows[0] as any).name, 'Carol');
    assert.equal(spy.listCalls.length, 1);
    const listCall = spy.listCalls[0]!;
    assert.equal(listCall.offset, 2); // (page 2 - 1) * 2 = 2
    assert.equal(listCall.limit, 2);
    assert.equal(spy.countCalls, 1);
  });

  it('synthesizes list that defaults pageSize when zero', async () => {
    const { store, spy } = makeStore();
    spy.rows.push({ id: 1, name: 'Alice', active: true });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.list(listContext({ page: 1, pageSize: 0 }));

    assert.ok(spy.listCalls.length > 0);
    assert.equal(spy.listCalls[0]!.offset, 0);
    assert.equal(spy.listCalls[0]!.limit, 20);
  });

  it('list offset is zero-based from page 1', async () => {
    const { store, spy } = makeStore();
    spy.rows.push({ id: 1, name: 'Alice', active: true });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.list(listContext({ page: 1, pageSize: 10 }));

    assert.ok(spy.listCalls.length > 0);
    assert.equal(spy.listCalls[0]!.offset, 0);
    assert.equal(spy.listCalls[0]!.limit, 10);
  });

  it('synthesizes get that delegates to store.get', async () => {
    const { store, spy } = makeStore();
    spy.rows.push({ id: 42, name: 'Alice', active: true });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    const record = await resource.get!(getContext('42'));

    assert.notEqual(record, null);
    assert.equal(record!.name, 'Alice');
    assert.equal(spy.getCalls.length, 1);
    assert.equal(spy.getCalls[0]!.id, '42');
  });

  it('get returns null when store.get returns null', async () => {
    const { store } = makeStore();

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    const record = await resource.get!(getContext('99'));

    assert.equal(record, null);
  });

  it('synthesizes save that dispatches create when id is null', async () => {
    const { store, spy } = makeStore();

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.save!(saveContext(null, { name: 'Dave', active: true }));

    assert.equal(spy.createCalls.length, 1);
    assert.equal(spy.updateCalls.length, 0);
    assert.deepEqual(spy.createCalls[0]!.data, { name: 'Dave', active: true });
    assert.equal(spy.rows.length, 1);
    assert.equal(spy.rows[0]!.name, 'Dave');
  });

  it('synthesizes save that dispatches update when id is a string', async () => {
    const { store, spy } = makeStore();
    spy.rows.push({ id: 1, name: 'Alice', active: true });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.save!(saveContext('1', { name: 'Alicia' }));

    assert.equal(spy.createCalls.length, 0);
    assert.equal(spy.updateCalls.length, 1);
    assert.equal(spy.updateCalls[0]!.id, '1');
    assert.deepEqual(spy.updateCalls[0]!.data, { name: 'Alicia' });
  });

  it('synthesized save passes request context with session', async () => {
    const { store, spy } = makeStore();

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.save!(saveContext(null, { name: 'Eve' }));

    assert.ok(spy.createCalls.length > 0);
    assert.equal(spy.createCalls[0]!.context.session, SESSION);
  });

  it('synthesized list passes request context with session', async () => {
    const { store, spy } = makeStore();

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.list(listContext());

    assert.ok(spy.listCalls.length > 0);
    assert.equal(spy.listCalls[0]!.context.session, SESSION);
  });

  it('synthesized get passes request context with session', async () => {
    const { store, spy } = makeStore();
    spy.rows.push({ id: 1, name: 'Alice', active: true });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.get!(getContext('1'));

    assert.ok(spy.getCalls.length > 0);
    assert.equal(spy.getCalls[0]!.context.session, SESSION);
  });

  it('throws AdminDefinitionError for a missing store', () => {
    assert.throws(
      () =>
        defineStoreResource({
          slug: 'users',
          store: null as unknown as ResourceStore<any, any, any>,
          serializer: makeSerializer(),
        }),
      AdminDefinitionError,
    );
  });

  it('throws AdminDefinitionError for a store missing required methods', () => {
    assert.throws(
      () =>
        defineStoreResource({
          slug: 'users',
          store: { get: () => null } as unknown as ResourceStore<any, any, any>,
          serializer: makeSerializer(),
        }),
      AdminDefinitionError,
    );
  });

  it('throws AdminDefinitionError for a missing serializer', () => {
    const { store } = makeStore();
    assert.throws(
      () =>
        defineStoreResource({
          slug: 'users',
          store,
          serializer: null as unknown as Serializer<any, any>,
        }),
      AdminDefinitionError,
    );
  });

  it('throws AdminDefinitionError for a non-object spec', () => {
    assert.throws(() => defineStoreResource(null as unknown as any), AdminDefinitionError);
    assert.throws(
      () => defineStoreResource('not an object' as unknown as any),
      AdminDefinitionError,
    );
  });

  it('throws AdminDefinitionError for an empty slug', () => {
    const { store } = makeStore();
    assert.throws(
      () =>
        defineStoreResource({
          slug: '',
          store,
          serializer: makeSerializer(),
        }),
      AdminDefinitionError,
    );
    assert.throws(
      () =>
        defineStoreResource({
          slug: '   ',
          store,
          serializer: makeSerializer(),
        }),
      AdminDefinitionError,
    );
  });

  it('returns a frozen Resource', () => {
    const { store } = makeStore();
    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    assert.ok(Object.isFrozen(resource));
  });

  it('uses serializer toRepresentation for list rows', async () => {
    const { store } = makeStore();
    store.list = async () => [{ id: 1, name: 'Alice', active: true }];
    store.count = async () => 1;

    const wrapped = makeSerializer();
    const calls: unknown[] = [];
    wrapped.toRepresentation = (data: unknown) => {
      calls.push(data);
      return { name: (data as TestRecord).name.toUpperCase() };
    };

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: wrapped,
    });
    const result = await resource.list(listContext());

    assert.equal(calls.length, 1);
    assert.equal((result.rows[0] as any).name, 'ALICE');
  });

  it('uses serializer toRepresentation for get', async () => {
    const { store } = makeStore();
    store.get = async () => ({ id: 1, name: 'Alice', active: true });

    const wrapped = makeSerializer();
    wrapped.toRepresentation = (data: unknown) => ({
      name: (data as TestRecord).name.toUpperCase(),
    });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: wrapped,
    });
    const record = await resource.get!(getContext('1'));

    assert.notEqual(record, null);
    assert.equal(record!.name, 'ALICE');
  });

  it('hands list and count one query built from sort, search, and filters', async () => {
    const { store, spy } = makeStore();
    spy.rows.push({ id: 1, name: 'Alice', active: true });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.list(
      listContext({
        sort: 'name',
        direction: 'desc',
        search: 'Alice',
        filters: { status: 'active' },
      }),
    );

    const query = spy.listCalls[0]!.query;
    assert.equal(spy.countQueries[0], query);
    assert.deepEqual(query, {
      search: 'Alice',
      sorts: [{ field: 'name', direction: 'desc' }],
      filters: { status: 'active' },
      filterClauses: [{ field: 'status', operator: 'eq', value: 'active' }],
    });
    assert.ok(Object.isFrozen(query));
  });

  it('builds an empty query when the list context names no sort, search, or filter', async () => {
    const { store, spy } = makeStore();
    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.list(listContext({ search: '' }));

    assert.deepEqual(spy.listCalls[0]!.query, {
      search: null,
      sorts: [],
      filters: {},
      filterClauses: [],
    });
  });

  it('defaults a sort without a direction to ascending', async () => {
    const { store, spy } = makeStore();
    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.list(listContext({ sort: 'name' }));

    assert.deepEqual(spy.listCalls[0]!.query.sorts, [{ field: 'name', direction: 'asc' }]);
  });

  it('coerces select filters to their declared types when filter options are given', async () => {
    const { store, spy } = makeStore();
    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
      filters: {
        fields: { active: { type: 'boolean' }, id: { type: 'integer' }, name: {} },
      },
    });
    await resource.list(listContext({ filters: { active: 'true', id: '3', name: 'Ann' } }));

    const query = spy.listCalls[0]!.query;
    assert.deepEqual(query.filters, { active: true, id: 3, name: 'Ann' });
    assert.deepEqual(query.filterClauses, [
      { field: 'active', operator: 'eq', value: true },
      { field: 'id', operator: 'eq', value: 3 },
      { field: 'name', operator: 'eq', value: 'Ann' },
    ]);
  });

  it('rejects a select filter the filter options do not declare', async () => {
    const { store, spy } = makeStore();
    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
      filters: { fields: { active: { type: 'boolean' } } },
    });

    await assert.rejects(
      () => resource.list(listContext({ filters: { status: 'x' } })),
      ValidationError,
    );
    assert.equal(spy.listCalls.length, 0);
  });

  it('validates create values fully and update values partially before the store', async () => {
    const { store, spy } = makeStore();
    spy.rows.push({ id: 1, name: 'Alice', active: true });
    const calls: Array<{ input: unknown; partial: boolean }> = [];
    const serializer: Serializer<any, any> = {
      fields: {},
      validate(input: unknown, options?: { partial?: boolean }): any {
        calls.push({ input, partial: options?.partial === true });
        return { name: 'validated' };
      },
      toRepresentation: (data: unknown) => data,
    };
    const resource = defineStoreResource({ slug: 'users', store, serializer });

    await resource.save!(saveContext(null, { name: 'raw' }));
    await resource.save!(saveContext('1', { name: 'raw' }));

    assert.deepEqual(calls, [
      { input: { name: 'raw' }, partial: false },
      { input: { name: 'raw' }, partial: true },
    ]);
    assert.deepEqual(spy.createCalls[0]!.data, { name: 'validated' });
    assert.deepEqual(spy.updateCalls[0]!.data, { name: 'validated' });
  });

  it('never reaches the store when the serializer rejects the values', async () => {
    const { store, spy } = makeStore();
    const serializer: Serializer<any, any> = {
      fields: {},
      validate(): any {
        throw new ValidationError([
          { path: ['role'], code: 'unknown_field', message: 'Unknown field' },
        ]);
      },
      toRepresentation: (data: unknown) => data,
    };
    const resource = defineStoreResource({ slug: 'users', store, serializer });

    await assert.rejects(
      () => resource.save!(saveContext(null, { role: 'admin' })),
      ValidationError,
    );
    assert.equal(spy.createCalls.length, 0);
  });

  it('throws AdminDefinitionError for a serializer without validate', () => {
    const { store } = makeStore();
    assert.throws(
      () =>
        defineStoreResource({
          slug: 'users',
          store,
          serializer: { fields: {}, toRepresentation: (d: unknown) => d } as unknown as Serializer<
            any,
            any
          >,
        }),
      AdminDefinitionError,
    );
  });

  it('defaults label to slug when omitted', () => {
    const { store } = makeStore();
    const resource = defineStoreResource({
      slug: 'my-resource',
      store,
      serializer: makeSerializer(),
    });
    assert.equal(resource.label, 'my-resource');
  });

  it('uses explicit label when provided', () => {
    const { store } = makeStore();
    const resource = defineStoreResource({
      slug: 'my-resource',
      label: 'My Resource',
      store,
      serializer: makeSerializer(),
    });
    assert.equal(resource.label, 'My Resource');
  });

  it('uses explicit columns when provided', async () => {
    const { store } = makeStore();
    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
      columns: [{ name: 'name', label: 'Name' }],
    });
    assert.equal(resource.columns.length, 1);
    assert.equal(resource.columns[0]!.name, 'name');
  });

  it('defaults columns to a single id column when omitted', () => {
    const { store } = makeStore();
    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    assert.equal(resource.columns.length, 1);
    assert.equal(resource.columns[0]!.name, 'id');
    assert.equal(resource.columns[0]!.label, 'ID');
  });
});
