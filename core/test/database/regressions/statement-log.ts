/**
 * Records every SQL statement a data source sends, through TypeORM's `logger`
 * seam, so a regression test can count statements and read their text. A test
 * passes `statementLog.logger` as the data source's `logger` and calls
 * `reset()` before the work it measures.
 */

import type { Logger } from 'typeorm';

/** One statement as the driver received it. */
export interface LoggedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** A statement recorder and the logger that feeds it. */
export interface StatementLog {
  readonly logger: Logger;
  /** Every statement since the last {@link reset}, in order. */
  readonly statements: readonly LoggedStatement[];
  /** The statements since the last reset that are SELECTs. */
  selects(): readonly LoggedStatement[];
  reset(): void;
}

const TRANSACTION_CONTROL = /^\s*(?:BEGIN|START TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** A new, empty statement log. */
export function createStatementLog(): StatementLog {
  const statements: LoggedStatement[] = [];
  const ignore = () => undefined;
  return {
    logger: {
      logQuery(sql: string, parameters?: unknown[]) {
        statements.push({ sql, parameters: parameters ?? [] });
      },
      logQueryError: ignore,
      logQuerySlow: ignore,
      logSchemaBuild: ignore,
      logMigration: ignore,
      log: ignore,
    },
    statements,
    selects: () =>
      statements.filter(
        (statement) =>
          !TRANSACTION_CONTROL.test(statement.sql) && /^\s*SELECT\b/i.test(statement.sql),
      ),
    reset: () => {
      statements.length = 0;
    },
  };
}
