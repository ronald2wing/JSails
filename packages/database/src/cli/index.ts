/**
 * The schema commands' side of the CLI: `defineSchemaConfig`, the database
 * config module an app on this data layer default-exports, and the
 * `db:push`/`db:diff` command modules it carries to core's built-in commands.
 */

export {
  defineSchemaConfig,
  SCHEMA_CONFIG,
  type SchemaConfig,
  type SchemaConfigOptions,
} from './schema-config.js';
export {
  DEFERRED_EXIT_CODE,
  runDbDiff,
  runDbPush,
  type DbDiffCommandOptions,
  type DbPushCommandOptions,
  type SchemaCommandConfig,
  type SchemaCommandIo,
  type SchemaCommandTable,
} from './schema-commands.js';
