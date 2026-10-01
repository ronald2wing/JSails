/**
 * `defineSchemaConfig({ database, models })`: the database config module of
 * an app on this data layer. Its default export tells `jsails db:push` and
 * `jsails db:diff` which database to reconcile and which models declare it,
 * and carries the two command modules, so the CLI reaches them through the
 * config it already loads and core never imports this package.
 *
 * The object is branded with `Symbol.for('jsails.database.schema-config')`,
 * whose value is the command table core dispatches to. `db:push` and
 * `db:diff` stay built-in commands rather than ones the `database()` plugin
 * declares, because the old data stack still needs core's `db:push` until
 * DAT-15b retires it.
 */

import type { DatabaseOptions } from '../engine/config.js';
import type { ModelTarget } from '../model/index.js';
import { SchemaErrors } from '../schema/schema-errors.js';
import { checkOwner } from '../schema/schema-source.js';
import { runDbDiff, runDbPush, type SchemaCommandTable } from './schema-commands.js';

/** The brand of a schema config; its value is the config's command table. */
export const SCHEMA_CONFIG: unique symbol = Symbol.for('jsails.database.schema-config') as never;

/** What {@link defineSchemaConfig} takes. */
export interface SchemaConfigOptions {
  /** The `database()` options: where the database is (secrets come from the environment). */
  readonly database?: DatabaseOptions;
  /** The models whose tables the commands reconcile. */
  readonly models: readonly ModelTarget[];
  /** The owner of these tables in the schema ledger. Default `app`. */
  readonly owner?: string;
}

/** A schema config: the database options, the models and the owner, with the CLI's commands. */
export interface SchemaConfig {
  readonly database: DatabaseOptions;
  readonly models: readonly ModelTarget[];
  readonly owner: string;
  readonly [SCHEMA_CONFIG]: SchemaCommandTable;
}

/** Declare the database and models `db:push` and `db:diff` reconcile. */
export function defineSchemaConfig(options: SchemaConfigOptions): SchemaConfig {
  if (options === null || typeof options !== 'object') {
    throw new SchemaErrors.Error('invalid_config_module', { field: 'options' });
  }
  if (!Array.isArray(options.models)) {
    throw new SchemaErrors.Error('invalid_config_module', { field: 'models' });
  }
  if (
    options.database !== undefined &&
    (options.database === null || typeof options.database !== 'object')
  ) {
    throw new SchemaErrors.Error('invalid_config_module', { field: 'database' });
  }
  const config = {
    database: Object.freeze({ ...options.database }),
    models: Object.freeze([...options.models]),
    owner: checkOwner(options.owner),
  };
  const commands: SchemaCommandTable = {
    'db:push': (commandOptions, io) => runDbPush(config, commandOptions, io),
    'db:diff': (commandOptions, io) => runDbDiff(config, commandOptions, io),
  };
  Object.defineProperty(config, SCHEMA_CONFIG, {
    value: Object.freeze(commands),
    enumerable: false,
  });
  return Object.freeze(config) as SchemaConfig;
}
