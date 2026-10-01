/**
 * Static app-definition introspection: the describe snapshot.
 *
 * `buildDescribeResult` composes a machine-readable snapshot of an app's static
 * definition — resolved dirs, the route manifest, the plugin graph, registered
 * components and commands, and the portable entity schema — without importing
 * page/API modules, running an extension `setup`, or opening a connection. An
 * app's generated component registry is imported (which loads its component
 * modules) so its components are listed, but no component callback runs.
 *
 * The plugins are the kernel's plugin graph (`resolvePlugins`) in safe mode:
 * the plugins the config declares, in setup order, and the graph's live-only
 * set, the plugins a static export leaves out. The
 * components and commands are read from the graph's entries, so a
 * `plugins.use` plugin is described as well as a legacy `extensions` one.
 *
 * This module is the neutral home for that logic. The `describe` CLI command
 * (`src/cli/commands/describe.ts`) and the MCP introspection server
 * (`src/mcp/builtin-tools.ts`) are both consumers, so neither depends on the other.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ResolvedAppConfig } from '../app/config/index.js';
import type { ExtensionEntry } from '../extensions/extension.js';
import { asLoadedApp, loadApp, type LoadedApp } from '../kernel/load-app.js';
import type { PluginGraphOrigin } from '../kernel/resolve-plugins.js';
import { discoverRoutes, type RouteManifestEntry } from '../routing/routes.js';
import { fromIndexOrScan } from '../mcp/index-source.js';
import type { JsailsDataSource } from '../database/data-source.js';
import type { SchemaState, TableDefinition } from '../migrations/schema-types.js';
import { listAppCommands } from '../cli/command-lookup.js';
import { readDependencyCommands } from '../cli/command-sources.js';
import type { PluginDescription } from '../extensions/plugin-contract.js';
import { importFile } from '../support/project-paths.server.js';
import { loadComponentEntries } from '../server-components/bootstrap.js';
import {
  createComponentRegistry,
  describeComponentRegistry,
} from '../server-components/registry.js';

/**
 * A command the project adds to the built-in ones: a direct dependency's
 * (`jsails.commands`, with its package) or an app command under
 * `dist/commands/` (with its summary when the summary cache has it).
 */
interface DescribeCommand {
  readonly name: string;
  readonly summary: string | null;
  readonly source: 'dependency' | 'app';
  /** The declaring package, for a dependency's command. */
  readonly package?: string;
  /** For an app command: whether only its source exists, not yet built. */
  readonly unbuilt?: boolean;
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
  readonly origin?: string;
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
  /**
   * The plugin graph in safe mode: the plugins the config declares, in setup
   * order, each with where it came from.
   */
  readonly graph: readonly DescribePluginNode[];
  /**
   * Names of the declared plugins (framework, `plugins.use` and extensions)
   * that only work in a live process, in declared order: the plugins a
   * `static` shape excludes from the graph (`PluginGraph.liveOnly`).
   */
  readonly liveOnly: readonly string[];
}

interface DescribePluginNode {
  readonly name: string;
  readonly origin: PluginGraphOrigin;
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

/** The portable entity schema section of the describe snapshot. */
export interface DescribeSchema {
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
  /**
   * Load the app config. A bare resolved config is described as a locked
   * app, as `resolvePlugins` takes it.
   */
  loadConfig(configPath: string): Promise<LoadedApp | ResolvedAppConfig>;
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
async function loadSchemaFromConfig(
  dbConfigPath: string,
  version?: number,
): Promise<SchemaState | undefined> {
  const absolute = resolve(dbConfigPath);
  if (!existsSync(absolute)) return undefined;
  // A version gives the module a new ESM cache key, so a rebuilt config is
  // evaluated again instead of answering from the first import.
  let module: unknown;
  try {
    module = await importFile(absolute, version === undefined ? {} : { version });
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

interface SchemaCacheEntry {
  readonly mtimeMs: number;
  readonly schema: Promise<DescribeSchema>;
}

/** Per-process schema cache, keyed by absolute db config path. */
const schemaCache = new Map<string, SchemaCacheEntry>();

function emptySchema(): DescribeSchema {
  return { tables: [] };
}

/**
 * The declared entity schema alone: load the database config module, build
 * entity metadata without connecting, and convert it to the describe shape.
 * Unlike {@link buildDescribeResult} it loads no app config and scans no
 * routes, so a long-lived consumer (the MCP server) answers schema questions
 * cheaply.
 *
 * Results are memoized per process, keyed on the config file's mtime: an
 * unchanged file is a cache hit, and a rebuilt one is evaluated again. Model
 * modules the config imports stay in the ESM cache, so a model edit is seen
 * once the config is rebuilt with it (the normal build) or the process
 * restarts. A missing or unloadable config yields empty tables and is not
 * cached, so the next call retries. Each call returns its own copy.
 */
export async function buildDescribeSchema(dbConfigPath: string): Promise<DescribeSchema> {
  const absolute = resolve(dbConfigPath);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(absolute).mtimeMs;
  } catch {
    schemaCache.delete(absolute);
    return emptySchema();
  }
  const cached = schemaCache.get(absolute);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) {
    return structuredClone(await cached.schema);
  }
  const schema = loadSchemaFromConfig(absolute, mtimeMs).then((state) => {
    if (state === undefined) {
      if (schemaCache.get(absolute)?.schema === schema) schemaCache.delete(absolute);
      return emptySchema();
    }
    return convertSchemaState(state);
  });
  schemaCache.set(absolute, { mtimeMs, schema });
  return structuredClone(await schema);
}

export const defaultDescribeDeps: DescribeDeps = Object.freeze<DescribeDeps>({
  loadConfig: (configPath) => loadApp({ configPath }),
  loadSchema: (dbConfigPath) => loadSchemaFromConfig(dbConfigPath),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
});

/**
 * Build the static-definition snapshot (DescribeResult) from the resolved app
 * config and optional schema, without rendering to stdout. Exported for direct
 * consumption by the MCP introspection server.
 */
export async function buildDescribeResult(
  input: DescribeInput,
  deps: DescribeDeps = defaultDescribeDeps,
): Promise<DescribeResult> {
  const app = asLoadedApp(await deps.loadConfig(input.configPath));
  const config = app.config;
  const { resolvePlugins } = await import('../kernel/resolve-plugins.js');
  const graph = await resolvePlugins(app, { safeMode: true });

  const rootDir = config.rootDir;

  // Routes: the build-time index when it exists, else a lexical scan. A stale
  // index throws rather than falling back — a stale answer is worse than none.
  const routes = await fromIndexOrScan(
    rootDir,
    (index) =>
      index.routes.map((route) => ({
        kind: route.kind,
        route: route.route,
        dynamic: route.dynamic,
        catchAll: route.catchAll,
        params: route.params,
        layoutCount: route.layoutCount,
      })),
    () => {
      const manifest = discoverRoutes(rootDir, {
        pagesDir: config.pagesDir,
        apiDir: config.apiDir,
      });
      return describeRoutes(manifest.entries);
    },
  );

  const plugins: DescribePlugins = {
    graph: graph.nodes.map(({ name, origin }) => ({ name, origin })),
    liveOnly: graph.liveOnly.map(({ name }) => name),
  };

  // Components: collected from server-components extensions without invoking
  // setup or creating a runtime.
  const components = await collectComponents(graph.entries, config.rootDir);

  // Commands: the same sources `jsails --help` lists, read from files; no
  // command module is imported.
  const commands = describeCommands(rootDir);

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
    routes: routes.data,
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
    ...(config.server.origin === undefined ? {} : { origin: config.server.origin }),
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
 * Collect component metadata from the graph's entries without invoking setup
 * or creating a runtime. Each plugin that exposes a `describe()` descriptor
 * announces its components declaratively; `describe` is pure and never
 * invokes callbacks, signs snapshots, or performs I/O. A plugin that serves
 * the compiler-generated entries learns the app root only at setup, so its
 * descriptor says `generatedComponents` instead, and the entries are read
 * here from the app root through the loader the plugin's setup uses, then
 * checked by the same registry, so a registry that would fail assembly fails
 * describe too.
 */
async function collectComponents(
  entries: readonly ExtensionEntry[],
  rootDir: string,
): Promise<DescribeComponent[]> {
  const results: DescribeComponent[] = [];
  let generated: readonly DescribeComponent[] | undefined;
  for (const extension of entries) {
    const describe = (extension as { describe?: () => PluginDescription | undefined }).describe;
    if (typeof describe !== 'function') continue;
    const description = describe();
    let components = description?.components;
    if (components === undefined && description?.generatedComponents === true) {
      generated ??= await describeGeneratedComponents(rootDir);
      components = generated;
    }
    for (const component of components ?? []) {
      results.push({
        name: component.name,
        actions: component.actions ?? [],
        writableKeys: component.writableKeys ?? [],
      });
    }
  }
  return results;
}

/** The app's generated component entries under `rootDir`, described by id. */
async function describeGeneratedComponents(rootDir: string): Promise<readonly DescribeComponent[]> {
  return describeComponentRegistry(
    createComponentRegistry(await loadComponentEntries({ rootDir })),
  );
}

/** The dependency and app commands of the project at `rootDir`, as help lists them. */
function describeCommands(rootDir: string): DescribeCommand[] {
  return [
    ...readDependencyCommands(rootDir).commands.map((command) => ({
      name: command.name,
      summary: command.summary,
      source: 'dependency' as const,
      package: command.packageName,
    })),
    ...listAppCommands(rootDir).commands.map((command) => ({
      name: command.name,
      summary: command.summary ?? null,
      source: 'app' as const,
      ...(command.unbuilt ? { unbuilt: true } : {}),
    })),
  ];
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
