/**
 * Shared fixtures for the model resource tests: a fresh `Note` entity per
 * suite, an on-disk sqljs data source per test, and request helpers that call
 * the resource handlers the way an `api/` route would.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import type { RequestContext, Session } from 'jsails';
import type { ResourceHandler } from 'jsails/api';
import type { JsailsDataSource } from 'jsails/database';
import { createEmptyDataSource } from 'jsails/testing';

const tmpRoot = mkdtempSync(join(tmpdir(), 'jsails-resources-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));
let locationSeq = 0;

/**
 * The note row, declared ambiently so {@link defineNoteEntity} can name its
 * return type: an exported anonymous class type cannot carry `BaseEntity`'s
 * private statics through declaration emit.
 */
export declare class NoteRecord extends BaseEntity {
  id: number;
  title: string;
  body: string;
  rank: number;
  ownerId: number | null;
  secret: string;
  meta: unknown;
}

/** The `Note` entity class a fixture returns. */
export type NoteEntity = typeof NoteRecord;

/** A fresh entity class over its own table, so suites never share metadata. */
export function defineNoteEntity(table: string): NoteEntity {
  @Entity(table)
  class Note extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 200 })
    title!: string;

    @Column({ type: 'text', default: '' })
    body!: string;

    @Column({ type: 'integer', default: 0 })
    rank!: number;

    @Column({ type: 'integer', nullable: true })
    ownerId!: number | null;

    @Column({ type: 'varchar', length: 200, default: '' })
    secret!: string;

    @Column({ type: 'json', nullable: true })
    meta!: unknown;
  }
  return Note;
}

/** An isolated, migrated data source over `entity`. */
export function createNoteDataSource(entity: Function): Promise<JsailsDataSource> {
  return createEmptyDataSource([entity], {
    location: join(tmpRoot, `db-${locationSeq++}.sqlite`),
  });
}

/** A signed-in session for `userId`. */
export function sessionFor(userId: number): Session {
  return {
    id: `sess_${userId}`,
    csrfToken: 'csrf',
    data: { userId },
    expiresAt: 4_000_000_000_000,
  };
}

/** The owner id a session carries, or `null` when signed out. */
export function ownerOf(context: RequestContext): number | null {
  const userId = context.session?.data['userId'];
  return typeof userId === 'number' ? userId : null;
}

/** Call a handler as an `api/` route would, returning status and parsed body. */
export async function call(
  handler: ResourceHandler,
  method: string,
  path: string,
  options: { session?: Session | null; params?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const request = new Request(`http://localhost${path}`, {
    method,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body), headers: { 'content-type': 'application/json' } }),
  });
  const context: RequestContext = {
    request,
    url: new URL(request.url),
    params: options.params ?? {},
    session: options.session ?? null,
  };
  const response = await handler(request, context);
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}
