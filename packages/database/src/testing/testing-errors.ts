/**
 * The error codes of the testing surface, `testing.*`: malformed test
 * database options and names, fixtures, factories, seeders and store
 * contracts, an unknown seeder, and a seeder that failed. Every message is
 * fixed text; the context holds only option names, seeder names (chosen in
 * code) and model names, never a value a test wrote.
 */

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

const TESTING_ERRORS = {
  invalid_options: {
    kind: 'internal',
    message: 'test data source option {field} is invalid',
    context: { field: 'identifier' },
  },
  invalid_database_name: {
    kind: 'internal',
    message: 'the test database {part} is invalid',
    context: { part: ['base name', 'worker id', 'name'] },
    suggestion:
      'use a base name of letters, digits and underscores and a worker id of up to 16 letters or digits, 63 characters in all',
  },
  invalid_fixture: {
    kind: 'internal',
    message: 'fixture field {field} is invalid',
    context: { field: 'identifier' },
  },
  unknown_fixture_model: {
    kind: 'internal',
    message: 'a fixture names model {model}, which the data source does not hold',
    context: { model: 'identifier' },
  },
  invalid_factory: {
    kind: 'internal',
    message: 'factory field {field} is invalid',
    context: { field: 'identifier' },
  },
  invalid_seeder: {
    kind: 'internal',
    message: 'seeder field {field} is invalid',
    context: { field: 'identifier' },
  },
  duplicate_seeder: {
    kind: 'internal',
    message: 'two seeders are named {seeder}',
    context: { seeder: 'identifier' },
  },
  unknown_seeder: {
    kind: 'internal',
    message: 'a requested seeder is not among the seeders given',
  },
  seeder_failed: {
    kind: 'internal',
    message: 'seeder {seeder} failed, and its writes were rolled back',
    context: { seeder: 'identifier' },
  },
  invalid_contract: {
    kind: 'internal',
    message: 'store contract field {field} is invalid',
    context: { field: 'identifier' },
  },
} as const;

/**
 * Testing codes: malformed options, test database names, fixtures,
 * factories, seeders and store contracts; a fixture for a model the data
 * source does not hold; duplicate and unknown seeders; and a failed seeder,
 * whose cause is the original failure.
 */
export const TestingErrors: ErrorRegistry<'testing', typeof TESTING_ERRORS> = defineErrors(
  'testing',
  TESTING_ERRORS,
);
