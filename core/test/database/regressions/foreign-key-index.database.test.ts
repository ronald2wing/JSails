/**
 * Audit finding "defineModel creates foreign keys without an index on the join
 * column (Postgres and SQLite)", on every driver. A many-to-one relation lowers
 * to `ManyToOne + JoinColumn` with no index, so deleting or loading by the
 * parent scans the child table. MariaDB passes only because InnoDB creates an
 * index for every foreign key itself. DAT-03's `physicalTable` declares the
 * same explicit index on every dialect.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { BaseEntity } from 'typeorm';

import type { JsailsDataSource } from '../../../src/database/data-source.js';
import { defineModel } from '../../../src/models/define-model.js';
import { clearModelRegistry } from '../../../src/models/model-registry.js';
import { matrixDriver, openMatrixDataSource } from './matrix-database.js';

class Author extends BaseEntity {
  declare id: number;
  declare name: string;
}

class Book extends BaseEntity {
  declare id: number;
  declare title: string;
  declare author: Author;
}

defineModel(Author, {
  table: 'regression_authors',
  primaryKey: { name: 'id', kind: 'integer' },
  columns: [{ name: 'name', type: 'varchar', length: 100, nullable: false }],
  relations: [],
});
defineModel(Book, {
  table: 'regression_books',
  primaryKey: { name: 'id', kind: 'integer' },
  columns: [{ name: 'title', type: 'varchar', length: 100, nullable: false }],
  relations: [{ kind: 'many-to-one', name: 'author', target: Author, joinColumn: 'author_id' }],
});
// defineModel registers into a process-wide registry that every later data
// source harvests; this file owns these models, so it clears them at the end.
after(() => clearModelRegistry());

/** Whether `table` has an index whose leading column is `column`, from the live catalog. */
async function hasLeadingIndex(
  dataSource: JsailsDataSource,
  table: string,
  column: string,
): Promise<boolean> {
  const driver = matrixDriver();
  const rows: unknown[] =
    driver === 'sqlite'
      ? await dataSource.query(
          `SELECT 1 FROM pragma_index_list(?) AS list
             JOIN pragma_index_info(list.name) AS info
            WHERE info.seqno = 0 AND info.name = ?`,
          [table, column],
        )
      : driver === 'postgres'
        ? await dataSource.query(
            `SELECT 1 FROM pg_index i
               JOIN pg_class c ON c.oid = i.indrelid
               JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
              WHERE c.relname = $1 AND a.attname = $2`,
            [table, column],
          )
        : await dataSource.query(
            `SELECT 1 FROM information_schema.statistics
              WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
                AND seq_in_index = 1`,
            [table, column],
          );
  return rows.length > 0;
}

describe('foreign key columns are indexed', () => {
  it('a many-to-one join column has an index after the schema push', async (t) => {
    const dataSource = await openMatrixDataSource(t, { entities: [Author, Book] });

    assert.equal(
      await hasLeadingIndex(dataSource, 'regression_books', 'author_id'),
      true,
      'regression_books.author_id has no index',
    );
  });
});
