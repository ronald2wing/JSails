/**
 * The schema core's error codes, `schema.*`. Every message is fixed per code;
 * the context holds only identifiers (table, column and index names, digests,
 * environment names) and counts, never SQL, values, connection details or the
 * name of the database the server reported.
 */

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

const SCHEMA_ERRORS = {
  invalid_options: {
    kind: 'invalid',
    message: 'schema option {field} is invalid',
    context: { field: 'identifier' },
  },
  invalid_source: {
    kind: 'invalid',
    message: 'the schema source is invalid at {field}',
    context: { field: 'identifier' },
    suggestion: 'pass { config, models } with a resolved DatabaseConfig and defined models',
  },
  unsupported_operation: {
    kind: 'internal',
    message: 'schema operation {operation} has no {dialect} form',
    context: { operation: 'identifier', dialect: ['postgres', 'mariadb', 'sqlite'] },
  },
  memory_database: {
    kind: 'invalid',
    message: 'an in-memory SQLite database has no schema to push',
    suggestion: 'point the database at a file; a second connection to :memory: is a new database',
  },
  duplicate_table: {
    kind: 'invalid',
    message: 'two declared models lower to table {table}',
    context: { table: 'identifier' },
  },
  reserved_table: {
    kind: 'invalid',
    message: 'table {table} is reserved for the schema ledger',
    context: { table: 'identifier' },
  },
  owned_by_another: {
    kind: 'conflict',
    message: 'table {table} is owned by {owner}, not by this push',
    context: { table: 'identifier', owner: 'identifier' },
    suggestion: 'declare the table in the schema of the owner that created it',
  },
  stale_approval: {
    kind: 'conflict',
    message: 'approval {digest} matches no operation of the current plan',
    context: { digest: 'identifier' },
    suggestion: 'run db:diff again and approve the digests it prints now',
  },
  approve_all_refused: {
    kind: 'forbidden',
    message: 'approving every operation is refused in environment {environment}',
    context: { environment: 'identifier' },
    suggestion: 'approve each blocking or destructive operation by its digest',
  },
  lock_timeout: {
    kind: 'timeout',
    message: 'another schema push held the schema lock for longer than the wait',
    suggestion: 'retry once the other push finishes, or pass a longer --wait-lock',
  },
  pooled_connection: {
    kind: 'unavailable',
    message: 'the schema session lost its lock between statements',
    suggestion:
      'point DATABASE_MIGRATION_URL at a direct or session-mode connection, not a transaction pooler',
  },
  unknown_database: {
    kind: 'internal',
    message: 'the server did not report which database the connection uses',
  },
  non_test_database: {
    kind: 'forbidden',
    message: 'the connected database is not a test database',
    suggestion:
      'connect to a database whose name ends in _test (a SQLite file such as storage/app_test.sqlite)',
  },
  unmarked_test_database: {
    kind: 'forbidden',
    message: 'the connected test database carries no test marker',
    suggestion: 'create the test database through the test harness, which marks it',
  },
  foreign_key_check: {
    kind: 'conflict',
    message: 'rebuilding table {table} left rows whose foreign keys point nowhere',
    context: { table: 'identifier' },
  },
  schema_out_of_date: {
    kind: 'unavailable',
    message: 'the database schema of {owner} is not the schema this code declares',
    context: { owner: 'identifier' },
    suggestion: 'run jsails db:push against this database before starting the app',
  },
  invalid_config_module: {
    kind: 'invalid',
    message: 'the schema config is invalid at {field}',
    context: { field: 'identifier' },
    suggestion: 'default-export defineSchemaConfig({ database, models })',
  },
} as const;

/**
 * The schema core's codes, `schema.*`: invalid input, ownership and approval
 * refusals, the lock, the test guard and the boot check.
 */
export const SchemaErrors: ErrorRegistry<'schema', typeof SCHEMA_ERRORS> = defineErrors(
  'schema',
  SCHEMA_ERRORS,
);
