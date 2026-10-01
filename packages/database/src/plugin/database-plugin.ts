/**
 * The `database()` plugin: the application's data source, a substrate
 * resource under `databaseToken` whose lifetime the kernel owns.
 *
 * ```ts
 * database({ file: 'data/app.sqlite', models: () => [Post, Comment] })
 * ```
 *
 * Its options are the connection options of `resolveDatabaseConfig` (a URL
 * without a password, a SQLite file, or server fields; TLS, pool and
 * timeouts) and `models`, a function returning every model and link table
 * the application reads. Its environment is three secret variables, all
 * optional: `DATABASE_URL` (wins over the options), `DATABASE_PASSWORD` and
 * `DATABASE_MIGRATION_URL`.
 *
 * The substrate declaration resolves the configuration from the validated
 * variables and the application root, so a malformed connection fails before
 * any plugin's setup runs. The kernel registers the resource's handle before
 * the first setup, so whatever runs before setup and every plugin that
 * requires `databaseToken` reaches it, and opens it on the first
 * `handle.get()`: opening constructs the data source, which
 * binds the models and connects nothing (its engine opens on the first
 * statement). Models are therefore bound while the resource is open, from its
 * first `get()` until the kernel closes it after the last cleanup, which
 * closes the data source and unbinds them; a binding never outlives the
 * resource that owns it. Setup wires nothing. This module loads no database
 * driver and no TypeORM: listing the plugin in a config costs its option
 * schema only.
 */

import {
  createServiceToken,
  definePlugin,
  envVar,
  fn,
  type PluginFactory,
  type ServiceTokenFamily,
  type SubstrateHandle,
} from 'jsails/kernel';
import { z } from 'zod';

import { DATABASE_ENV, resolveDatabaseConfig, type DatabaseOptions } from '../engine/config.js';
import type { ModelTarget } from '../model/model-spec.js';
import { JsailsDataSource } from '../record/data-source.js';

/**
 * The application's data source, as the kernel's substrate handle:
 * `await services.get(databaseToken).get()` opens it on first use.
 */
export const databaseToken: ServiceTokenFamily<SubstrateHandle<JsailsDataSource>> =
  createServiceToken<SubstrateHandle<JsailsDataSource>>('database');

const timeout = z.number().int().min(0);

const sslMode = z.enum(['require', 'verify']);

/** The options of {@link database}: the connection options and the models. */
export interface DatabasePluginOptions extends DatabaseOptions {
  /** Every model and link table the application reads or writes; each is bound to the data source. */
  readonly models: () => readonly ModelTarget[];
}

const options: z.ZodType<DatabasePluginOptions> = z
  .object({
    url: z.string().min(1).optional(),
    dialect: z.enum(['postgres', 'mariadb', 'sqlite']).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    user: z.string().min(1).optional(),
    database: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    ssl: z
      .union([
        z.literal(false),
        sslMode,
        z.object({ mode: sslMode, ca: z.string().min(1).optional() }).strict(),
      ])
      .optional(),
    pool: z
      .object({ max: z.number().int().min(1).max(1000).optional() })
      .strict()
      .optional(),
    acquireTimeoutMs: timeout.optional(),
    statementTimeoutMs: timeout.optional(),
    connectTimeoutMs: z.number().int().min(1).optional(),
    busyTimeoutMs: timeout.optional(),
    models: fn<() => readonly ModelTarget[]>(),
  })
  .strict();

/** The `database()` plugin. */
export const database: PluginFactory<DatabasePluginOptions> = definePlugin({
  name: 'database',
  options,
  env: {
    [DATABASE_ENV.url]: envVar.secret().optional(),
    [DATABASE_ENV.password]: envVar.secret().optional(),
    [DATABASE_ENV.migrationUrl]: envVar.secret().optional(),
  },
  substrate({ options: parsed, env, rootDir }) {
    const { models, ...connection } = parsed;
    const config = resolveDatabaseConfig(connection, { env, root: rootDir });
    return [
      {
        token: databaseToken,
        create: () => new JsailsDataSource({ config, models: models() }),
        close: (dataSource: JsailsDataSource) => dataSource.close(),
      },
    ];
  },
  setup() {},
});
