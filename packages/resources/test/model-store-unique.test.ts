/**
 * Tests for the unique validators of a model resource: a write that would
 * duplicate a unique constraint the resource fills is a `400` on the field, or
 * on the body for a multi-column constraint, instead of a database error.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { string, integer, type ResourceAuthorize } from 'jsails/api';
import type { JsailsDataSource } from 'jsails/database';

import { defineModelResource, unscoped } from '../src/index.js';
import { call, createNoteDataSource, ownerOf, sessionFor } from './fixtures.js';

@Entity('unique_member')
@Unique(['orgId', 'handle'])
class Member extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  orgId!: number;

  @Column({ type: 'varchar', length: 80 })
  handle!: string;

  @Column({ type: 'varchar', length: 120, unique: true })
  email!: string;

  @Column({ type: 'varchar', length: 80, nullable: true, unique: true })
  nickname!: string | null;
}

const allow: ResourceAuthorize<unknown> = () => true;

const members = defineModelResource(Member, {
  name: 'members',
  fields: {
    id: { schema: integer(), access: 'read' },
    orgId: { schema: integer(), access: 'read' },
    handle: { schema: string(), access: 'readWrite' },
    email: { schema: string(), access: 'readWrite' },
    nickname: { schema: string({ optional: true, nullable: true }), access: 'readWrite' },
  },
  scope: unscoped('test fixture'),
  stamp: { orgId: (context) => ownerOf(context) },
  authorize: allow,
});

const { collection, detail } = members.handlers;

type Issues = { error: { issues: { path: string[]; code: string }[] } };

function create(org: number, body: Record<string, unknown>) {
  return call(collection.POST, 'POST', '/api/members', { session: sessionFor(org), body });
}

describe('model resource unique validators', () => {
  let dataSource: JsailsDataSource;

  beforeEach(async () => {
    dataSource = await createNoteDataSource(Member);
    assert.equal((await create(1, { handle: 'ada', email: 'ada@example.test' })).status, 201);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('refuses a duplicate unique column as a field error', async () => {
    const response = await create(2, { handle: 'other', email: 'ada@example.test' });
    assert.equal(response.status, 400);
    assert.deepEqual(
      (response.body as Issues).error.issues.map((issue) => [issue.path, issue.code]),
      [[['email'], 'unique']],
    );
    assert.equal(await Member.count(), 1);
  });

  it('refuses a duplicate multi-column set, including a stamped column', async () => {
    assert.equal((await create(2, { handle: 'ada', email: 'b@example.test' })).status, 201);
    const response = await create(1, { handle: 'ada', email: 'c@example.test' });
    assert.equal(response.status, 400);
    assert.deepEqual(
      (response.body as Issues).error.issues.map((issue) => [issue.path, issue.code]),
      [[[], 'unique']],
    );
  });

  it('treats nulls as distinct', async () => {
    const first = await create(1, { handle: 'b', email: 'b@example.test', nickname: null });
    const second = await create(1, { handle: 'c', email: 'c@example.test', nickname: null });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
  });

  it('excludes the row itself on update and refuses taking another row value', async () => {
    const other = await create(1, { handle: 'bea', email: 'bea@example.test' });
    const id = String((other.body as { id: number }).id);
    const same = await call(detail.PATCH, 'PATCH', `/api/members/${id}`, {
      session: sessionFor(1),
      params: { id },
      body: { email: 'bea@example.test' },
    });
    assert.equal(same.status, 200);
    const taken = await call(detail.PATCH, 'PATCH', `/api/members/${id}`, {
      session: sessionFor(1),
      params: { id },
      body: { email: 'ada@example.test' },
    });
    assert.equal(taken.status, 400);
    assert.equal((await Member.findOneByOrFail({ id: Number(id) })).email, 'bea@example.test');
  });

  it('answers a concurrent duplicate that slips past the check with the same 400', async () => {
    // The racing writer commits between the check and this request's insert.
    const original = Member.prototype.save;
    Member.prototype.save = async function (this: Member, ...args) {
      Member.prototype.save = original;
      await Member.insert({ orgId: 9, handle: 'racer', email: this.email });
      return original.apply(this, args);
    };
    try {
      const response = await create(2, { handle: 'late', email: 'race@example.test' });
      assert.equal(response.status, 400);
      assert.deepEqual(
        (response.body as Issues).error.issues.map((issue) => [issue.path, issue.code]),
        [[['email'], 'unique']],
      );
    } finally {
      Member.prototype.save = original;
    }
    assert.equal(await Member.countBy({ email: 'race@example.test' }), 1);
  });
});
