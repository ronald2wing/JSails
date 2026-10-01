/**
 * Tests for `createEmptyDataSource`: the default location is unique per call
 * and removed on destroy, so parallel test files never share a database file.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { EntitySchema } from 'typeorm';

import { createEmptyDataSource } from '../../src/testing/test-database.js';

const Note = new EntitySchema<{ id: number; body: string }>({
  name: 'TestDatabaseNote',
  tableName: 'test_database_notes',
  columns: {
    id: { type: 'integer', primary: true, generated: true },
    body: { type: 'text' },
  },
});

function locationOf(dataSource: { options: unknown }): string {
  return (dataSource.options as { location: string }).location;
}

/** A table whose default is not valid SQL, so the create plan fails to execute. */
const Broken = new EntitySchema<{ id: number; body: string }>({
  name: 'TestDatabaseBroken',
  tableName: 'test_database_broken',
  columns: {
    id: { type: 'integer', primary: true, generated: true },
    body: { type: 'text', default: () => 'not valid sql (' },
  },
});

function ownedTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('jsails-empty-db-'));
}

describe('createEmptyDataSource', () => {
  it('removes its temporary directory when the migrate step fails', async () => {
    const before = new Set(ownedTempDirs());
    await assert.rejects(createEmptyDataSource([Broken]));
    const leaked = ownedTempDirs().filter((name) => !before.has(name));
    assert.deepEqual(leaked, []);
  });

  it('gives each call its own file outside the working directory', async () => {
    const first = await createEmptyDataSource([Note]);
    const second = await createEmptyDataSource([Note]);
    try {
      assert.notEqual(locationOf(first), locationOf(second));
      assert.ok(!locationOf(first).startsWith(process.cwd()));
      assert.equal(existsSync(join(process.cwd(), 'empty-test.db')), false);

      // Both start empty and migrate independently: no shared state.
      await first.getRepository(Note).save({ body: 'a' });
      assert.equal(await second.getRepository(Note).count(), 0);
    } finally {
      await first.destroy();
      await second.destroy();
    }
  });

  it('removes its temporary directory on destroy', async () => {
    const dataSource = await createEmptyDataSource([Note]);
    const dir = dirname(locationOf(dataSource));
    await dataSource.getRepository(Note).save({ body: 'persisted' });
    assert.equal(existsSync(dir), true);

    await dataSource.destroy();
    assert.equal(existsSync(dir), false);
  });

  it('destroys through a lifecycle hook', async () => {
    const callbacks: Array<() => unknown> = [];
    const dataSource = await createEmptyDataSource([Note], {
      lifecycle: { after: (callback) => void callbacks.push(callback) },
    });
    const dir = dirname(locationOf(dataSource));
    assert.equal(callbacks.length, 1);

    for (const callback of callbacks) await callback();
    assert.equal(dataSource.isInitialized, false);
    assert.equal(existsSync(dir), false);
  });

  it('never deletes an explicit location', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsails-explicit-db-'));
    try {
      const location = join(dir, 'mine.db');
      const dataSource = await createEmptyDataSource([Note], { location });
      await dataSource.getRepository(Note).save({ body: 'kept' });
      await dataSource.destroy();
      assert.equal(existsSync(location), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
