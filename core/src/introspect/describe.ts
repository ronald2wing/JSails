/**
 * Static app-definition introspection: the describe snapshot.
 *
 * `buildDescribeResult` composes a machine-readable snapshot of an app's static
 * definition — resolved dirs, the route manifest, plugin enablement, registered
 * components and commands, and the portable entity schema — without importing
 * page/API modules, running an extension `setup`, or opening a connection.
 *
 * This module is the neutral home for that logic. The `describe` CLI command
 * (`src/cli/describe-commands.ts`) and the MCP introspection server
 * (`src/mcp/tools.ts`) are both consumers, so neither depends on the other.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadAppConfig, type ResolvedAppConfig } from '../app/config/index.js';
import { resolvePluginEnablement } from '../plugins/enablement.js';
import { collectLiveOnlyPluginIds } from '../plugins/live-only.js';
import { discoverRoutes, type RouteManifestEntry } from '../routing/routes.js';
import type { JsailsDataSource } from '../database/data-source.js';
import type { SchemaState, TableDefinition } from '../migrations/schema-types.js';
import type { CommandContribution } from '../extensions/plugin-contract.js';

/** Serializable projection of a plugin-contributed command descriptor (no `load` function). */
interface DescribeCommand {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
  readonly audience: string;
  readonly config: string;
}

/** The top-level JSON shape emitted by `--json`. */
export interface DescribeResult {
  readonly app: DescribeApp;
  readonly routes: readonly DescribeRoute[];
  readonly plugins: DescribePlugins;
  readonly commands: readonly DescribeCommand[];
  readonly components: readonly DescribeComponent[];
  readonly schema: DescribeSchema;
}

interface DescribeApp {
  readonly rootDir: string;
  readonly pages: string;
  readonly api: string;
  readonly public: string;
  readonly out: string;
  readonly host: string;
  readonly port: number;
  readonly healthPath: string | null;
  readonly publicOrigin?: string;
}

interface DescribeRoute {
  readonly kind: string;
  readonly route: string;
  readonly dynamic: boolean;
  readonly catchAll: boolean;
  readonly params: readonly string[];
  /** Number of layout modules for this route (observability without leaking absolute paths). */
  readonly layoutCount: number;
}

interface DescribePlugins {
  readonly enabled: readonly string[];
  readonly conflicts: readonly string[];
  readonly disabledManaged: readonly string[];
  readonly sources: DescribePluginSources;
  /**
   * Plugin ids that declare `needsLive: true` via `describe()`.
   * These are the plugins that would be excluded under a `static` shape.
   * Only plugins present in the config's resolved extensions with a
   * `describe()` descriptor are checked; undeclared plugins fall through
   * to empty.
   */
  readonly liveOnly: readonly string[];
}

interface DescribePluginSources {
  readonly code: readonly string[];
  readonly managed?: readonly string[];
}

interface DescribeComponent {
  readonly name: string;
  readonly actions: readonly string[];
  readonly writableKeys: readonly string[];
}

interface DescribeTable {
  readonly name: string;
  readonly columns: DescribeTableColumn[];
  readonly indexes: DescribeTableIndex[];
  readonly uniques: DescribeTableUnique[];
  readonly foreignKeys: DescribeTableForeignKey[];
}

interface DescribeTableColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey?: boolean;
  default?: unknown;
  length?: number;
}

interface DescribeTableIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

interface DescribeTableUnique {
  name: string;
  columns: string[];
}

interface DescribeTableForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

interface DescribeSchema {
  readonly tables: DescribeTable[];
}

/** Options for {@link runDescribe}. */
interface DescribeOptions {
  readonly json?: boolean;
}

/** CLI input to the describe command. Exported so tests can inject fakes. */
export interface DescribeInput {
  readonly configPath: string;
  /** Path to the compiled migration/JsailsDataSource config module. */
  readonly dbConfigPath?: string;
  readonly options: DescribeOptions;
}

/** Dependency seam for the describe command. */
export interface DescribeDeps {
  /** Load and resolve the app config. */
  loadConfig(configPath: string): Promise<ResolvedAppConfig>;
  /**
   * Build schema from entity metadata without opening a connection.
   * Optional; when absent or returning `undefined`, the schema is empty.
   */
  loadSchema?(dbConfigPath: string): Promise<SchemaState | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
}

/**
 * Load a JsailsDataSource from a compiled config module, build entity metadata
 * without connecting, and return the portable schema. Returns `undefined` when
 * the file does not exist or cannot be loaded, so the describe command degrades
 * gracefully to empty tables rather than failing.
 */
async function loadSchemaFromConfig(dbConfigPath: string): Promise<SchemaState | undefined> {
  const absolute = resolve(dbConfigPath);
  if (!existsSync(absolute)) return undefined;
  let module: unknown;
  try {
    module = await import(pathToFileURL(absolute).href);
  } catch {
    return undefined;
  }
  const dataSource: unknown = (module as { default?: unknown }).default;
  if (
    dataSource === undefined ||
    dataSource === null ||
    typeof dataSource !== 'object' ||
    typeof (dataSource as { getModelSchema?: unknown }).getModelSchema !== 'function'
  ) {
    return undefined;
  }
  try {
    return await (dataSource as JsailsDataSource).getModelSchema();
  } catch {
    return undefined;
  }
}

export const defaultDescribeDeps: DescribeDeps = {
  loadConfig: (configPath) => loadAppConfig(configPath),
  loadSchema: (dbConfigPath) => loadSchemaFromConfig(dbConfigPath),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

/**
 * Build the static-definition snapshot (DescribeResult) from the resolved app
 * config and optional schema, without rendering to stdout. Exported for direct
 * consumption by the MCP introspection server.
 */
export async function buildDescribeResult(
  input: DescribeInput,
  deps: DescribeDeps = defaultDescribeDeps,
): Promise<DescribeResult> {
  const config = await deps.loadConfig(input.configPath);

  const rootDir = config.rootDir;

  // Routes: discovered lexically, never imports page/API modules.
  const manifest = discoverRoutes(rootDir, {
    pagesDir: config.pagesDir,
    apiDir: config.apiDir,
  });

  // Plugins: pure enablement from the app config's plugins field.
  const pluginEnablement = resolvePluginEnablement({
    codeEnabled: config.plugins?.enabled,
  });
  // Managed state ids are only available when the config's plugins carry state;
  // the describe command reads only the code list, so managed sources are empty.
  // Live-only plugins: collected from extensions with `describe().needsLive`.
  const liveOnlyIds = collectLiveOnlyPluginIds(config);

  const plugins: DescribePlugins = {
    enabled: freezeCopy(pluginEnablement.enabled),
    conflicts: freezeCopy(pluginEnablement.conflicts),
    disabledManaged: freezeCopy(pluginEnablement.disabledManaged),
    sources: {
      code: freezeCopy(pluginEnablement.enabled),
    },
    liveOnly: freezeCopy(liveOnlyIds.filter((id) => pluginEnablement.enabled.includes(id))),
  };

  // Components: collected from server-components extensions without invoking
  // setup or creating a runtime.
  const components = collectComponents(config);

  // Commands: collected from plugin descriptors without invoking setup or
  // calling any `load()` thunk — the descriptor is pure metadata.
  const commands = collectPluginCommands(config);

  // Schema: extracted from entity metadata without opening a connection.
  let schema: DescribeSchema = { tables: [] };
  if (deps.loadSchema && input.dbConfigPath) {
    try {
      const schemaState = await deps.loadSchema(input.dbConfigPath);
      if (schemaState) {
        schema = convertSchemaState(schemaState);
      }
    } catch {
      // Schema extraction is best-effort: a missing or invalid db config
      // yields empty tables, not a fatal error.
    }
  }

  const result: DescribeResult = {
    app: describeApp(config),
    routes: describeRoutes(manifest.entries),
    plugins,
    commands,
    components,
    schema,
  };

  return result;
}

/** Build the app section from the resolved config. */
function describeApp(config: ResolvedAppConfig): DescribeApp {
  return {
    rootDir: config.rootDir,
    pages: config.pagesDir,
    api: config.apiDir,
    public: config.publicDir,
    out: config.outDir,
    host: config.host,
    port: config.port,
    healthPath: config.healthPath ?? null,
    ...(config.publicOrigin === undefined ? {} : { publicOrigin: config.publicOrigin }),
  };
}

/**
 * Convert route manifest entries to the describe shape, omitting file paths
 * and layout paths. `layoutCount` exposes the number of layout modules for
 * observability without leaking absolute paths.
 */
function describeRoutes(entries: readonly RouteManifestEntry[]): DescribeRoute[] {
  return entries.map((entry) => ({
    kind: entry.kind,
    route: entry.route,
    dynamic: entry.dynamic,
    catchAll: entry.catchAll,
    params: entry.params,
    layoutCount: entry.layouts?.length ?? 0,
  }));
}

/**
 * Collect component metadata from resolved extensions without invoking setup
 * or creating a runtime. Each plugin that exposes a `describe()` descriptor
 * announces its components declaratively; `describe` is pure and never
 * invokes callbacks, signs snapshots, or performs I/O.
 */
function collectComponents(config: ResolvedAppConfig): DescribeComponent[] {
  const results: DescribeComponent[] = [];
  for (const extension of config.extensions) {
    const describe = (
      extension as { describe?: () => { components?: readonly DescribeComponent[] } }
    ).describe;
    if (typeof describe !== 'function') continue;
    const description = describe();
    if (description?.components !== undefined) {
      for (const component of description.components) {
        results.push({
          name: component.name,
          actions: component.actions ?? [],
          writableKeys: component.writableKeys ?? [],
        });
      }
    }
  }
  return results;
}

/**
 * Collect declarative command descriptors from resolved extensions without
 * invoking setup or resolving any `load()` thunk. Each plugin that exposes a
 * `describe()` descriptor announces its commands declaratively; `describe` is
 * pure and never imports plugin code.
 */
function collectPluginCommands(config: ResolvedAppConfig): DescribeCommand[] {
  const results: DescribeCommand[] = [];
  for (const extension of config.extensions) {
    const describe = (
      extension as { describe?: () => { commands?: readonly CommandContribution[] } }
    ).describe;
    if (typeof describe !== 'function') continue;
    const description = describe();
    if (description?.commands !== undefined) {
      for (const cmd of description.commands) {
        results.push({
          name: cmd.name,
          summary: cmd.summary,
          ...(cmd.usage === undefined ? {} : { usage: cmd.usage }),
          audience: cmd.audience,
          config: cmd.config,
        });
      }
    }
  }
  return results;
}

/** Convert a portable SchemaState into the describe shape. */
function convertSchemaState(state: SchemaState): DescribeSchema {
  const tables: DescribeTable[] = [];
  for (const table of state.tables) {
    tables.push(convertTable(table));
  }
  return { tables };
}

function convertTable(table: TableDefinition): DescribeTable {
  return {
    name: table.name,
    columns: table.columns.map((col) => {
      const c: DescribeTableColumn = {
        name: col.name,
        type: col.type,
        nullable: col.nullable,
      };
      if (col.primaryKey) c.primaryKey = true;
      if (col.default !== undefined) c.default = col.default;
      if (col.length !== undefined) c.length = col.length;
      return c;
    }),
    indexes: (table.indexes ?? []).map((idx) => ({
      name: idx.name,
      columns: idx.columns,
      unique: idx.unique,
    })),
    uniques: (table.uniques ?? []).map((uq) => ({
      name: uq.name,
      columns: uq.columns,
    })),
    foreignKeys: (table.foreignKeys ?? []).map((fk) => {
      const f: DescribeTableForeignKey = {
        name: fk.name,
        columns: fk.columns,
        referencedTable: fk.referencedTable,
        referencedColumns: fk.referencedColumns,
      };
      if (fk.onDelete) f.onDelete = fk.onDelete;
      if (fk.onUpdate) f.onUpdate = fk.onUpdate;
      return f;
    }),
  };
}

/** Create a frozen copy of a sorted string list. */
function freezeCopy(list: readonly string[]): readonly string[] {
  return Object.freeze([...list]);
}
