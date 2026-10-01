/**
 * Driver-specific SQL preview for a schema plan.
 *
 * TypeORM's schema editor already knows how to render each operation for a
 * driver. We instantiate a driver-specific query runner without connecting,
 * replace `query` with a recorder, and run the same operation executor used by
 * `db:push`. Nothing is sent to a database.
 *
 * Some operations (notably table rebuilds on SQLite) need to introspect the
 * live table first. Those cannot be previewed without a connection; the entry
 * carries a note instead of failing the whole plan.
 */

import { DataSource, type DataSourceOptions } from 'typeorm';

import {
  executeSchemaOperation,
  preflightSchemaOperations,
  type SchemaEditorDriver,
} from '../database/schema-editor.js';
import type { Operation } from './operations.js';

/** One operation and the SQL it would run (or a note when preview is impossible). */
export interface SqlPreviewEntry {
  readonly operation: Operation;
  readonly statements: readonly string[];
  readonly note?: string;
}

function previewDataSource(driver: SchemaEditorDriver): DataSource {
  const options: DataSourceOptions =
    driver === 'sqlite'
      ? { type: 'sqljs', entities: [], synchronize: false }
      : {
          type: driver,
          host: '127.0.0.1',
          port: driver === 'postgres' ? 5432 : 3306,
          username: 'preview',
          password: 'preview',
          database: 'preview',
          entities: [],
          synchronize: false,
        };
  return new DataSource(options);
}

/**
 * Render the SQL for `operations` without opening a connection. The returned
 * statements are TypeORM's own driver SQL; the caller owns presentation.
 */
export async function previewSchemaOperations(
  operations: readonly Operation[],
  driver: SchemaEditorDriver,
): Promise<readonly SqlPreviewEntry[]> {
  const validated = preflightSchemaOperations([...operations], driver);
  if (validated.length === 0) return [];

  const dataSource = previewDataSource(driver);
  const queryRunner = dataSource.createQueryRunner();
  const capturable = queryRunner as unknown as {
    query: (sql: string) => Promise<unknown>;
  };
  const originalQuery = capturable.query.bind(queryRunner);
  const entries: SqlPreviewEntry[] = [];

  try {
    for (const operation of validated) {
      const statements: string[] = [];
      capturable.query = async (sql: string) => {
        statements.push(sql);
        return [];
      };
      try {
        await executeSchemaOperation(queryRunner, operation, driver);
        entries.push({ operation, statements });
      } catch {
        entries.push({
          operation,
          statements: [],
          note: 'preview unavailable for this operation (driver introspection required)',
        });
      }
    }
  } finally {
    capturable.query = originalQuery;
    await queryRunner.release().catch(() => {
      // A preview runner was never connected; release failure is irrelevant.
    });
  }
  return entries;
}
