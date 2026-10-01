/**
 * Built-in JSails MCP tools.
 *
 * Each tool wraps an existing read-only introspection function — never
 * reimplements discovery or schema extraction.  Results are serialized as
 * JSON text content.
 *
 * The config modules a tool loads are fixed when the tool set is built
 * ({@link createJsailsMcpTools}), never chosen by the caller: loading a config
 * module executes it, so a model-supplied path would be arbitrary module
 * execution in the server process. Tool arguments carry only the question
 * (for example the request path to explain).
 *
 * Server-only: imports the app config loader, route discovery, schema
 * extraction, explain matching, and plugin enablement.
 */

import { defineMcpTool, McpToolError, type McpTool } from './tool.js';
import { buildDescribeResult } from '../introspect/describe.js';
import { buildExplainResult } from '../introspect/explain.js';
import { discoverRoutes } from '../routing/routes.js';
import { DEFAULT_APP_CONFIG_PATH, loadAppConfig } from '../app/config/index.js';
import { fromIndexOrScan } from './index-source.js';
import { DEFAULT_DATABASE_CONFIG_PATH } from '../config-modules.js';

/** The config modules a built-in tool set introspects. */
export interface JsailsMcpToolsOptions {
  /** Compiled app config module (default: `jsails.app.js`). */
  readonly configPath?: string;
  /** Database config module (default: `jsails.database.js` for the schema tool). */
  readonly dbConfigPath?: string;
}

const NO_ARGUMENTS = Object.freeze({ type: 'object' as const, properties: {} });

/**
 * Build the built-in JSails MCP tools bound to fixed config paths. Arguments a
 * caller passes beyond each tool's declared input schema are ignored.
 */
export function createJsailsMcpTools(options: JsailsMcpToolsOptions = {}): readonly McpTool[] {
  const configPath =
    options.configPath !== undefined && options.configPath.length > 0
      ? options.configPath
      : DEFAULT_APP_CONFIG_PATH;
  const dbConfigPath =
    options.dbConfigPath !== undefined && options.dbConfigPath.length > 0
      ? options.dbConfigPath
      : undefined;

  const describeTool = defineMcpTool({
    name: 'jsails_describe',
    description:
      'Compose a machine-readable snapshot of the JSails app definition: routes, plugins, commands, server components, and the declared entity schema.',
    inputSchema: NO_ARGUMENTS,
    async handler() {
      return buildDescribeResult({ configPath, dbConfigPath, options: { json: true } });
    },
  });

  const inspectRoutesTool = defineMcpTool({
    name: 'jsails_inspect_routes',
    description:
      'List every filesystem route (page / API) discovered from the compiled pages/ and api/ directories.',
    inputSchema: NO_ARGUMENTS,
    async handler() {
      const config = await loadAppConfig(configPath);

      return fromIndexOrScan(
        config.rootDir,
        (index) =>
          index.routes.map((route) => ({
            kind: route.kind,
            route: route.route,
            dynamic: route.dynamic,
            catchAll: route.catchAll,
            optionalCatchAll: route.optionalCatchAll,
            params: route.params,
            layoutCount: route.layoutCount,
          })),
        () => {
          const manifest = discoverRoutes(config.rootDir, {
            pagesDir: config.pagesDir,
            apiDir: config.apiDir,
          });
          return manifest.entries.map((entry) => ({
            kind: entry.kind,
            route: entry.route,
            dynamic: entry.dynamic,
            catchAll: entry.catchAll,
            optionalCatchAll: entry.optionalCatchAll === true,
            params: entry.params,
            layoutCount: entry.layouts?.length ?? 0,
          }));
        },
      );
    },
  });

  const explainRouteTool = defineMcpTool({
    name: 'jsails_explain_route',
    description:
      'Resolve which route handles a request path and show the matched route, any extracted parameter values, and the fixed pipeline stages for that request.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description: 'The request path to resolve (e.g. /blog/hello)',
        },
      },
      required: ['path'] as const,
    },
    async handler(args: Record<string, unknown>) {
      const path = args.path;
      if (typeof path !== 'string' || path.length === 0) {
        throw new McpToolError('invalid_argument', 'path must be a non-empty string');
      }

      const { exitCode, result } = await buildExplainResult({ configPath, path });
      if (result === undefined || exitCode !== 0) {
        throw new McpToolError('not_found', 'failed to resolve the request path');
      }
      return result;
    },
  });

  const schemaTool = defineMcpTool({
    name: 'jsails_schema',
    description:
      'Extract the declared entity schema (tables, columns, indexes, foreign keys) from application model metadata without connecting to a database. Returns an empty tables array when no database config exists.',
    inputSchema: NO_ARGUMENTS,
    async handler() {
      const result = await buildDescribeResult({
        configPath,
        dbConfigPath: dbConfigPath ?? DEFAULT_DATABASE_CONFIG_PATH,
        options: { json: true },
      });
      return result.schema;
    },
  });

  return Object.freeze([describeTool, inspectRoutesTool, explainRouteTool, schemaTool]);
}

// ---------------------------------------------------------------------------
// Default tool set (jsails.app.js / jsails.database.js in the working directory)
// ---------------------------------------------------------------------------

/** The built-in JSails MCP tools, bound to the default config paths. */
export const jsailsMcpTools: readonly McpTool[] = createJsailsMcpTools();

const [jsailsDescribeTool, jsailsInspectRoutesTool, jsailsExplainRouteTool, jsailsSchemaTool] =
  jsailsMcpTools as readonly [McpTool, McpTool, McpTool, McpTool];

export { jsailsDescribeTool, jsailsInspectRoutesTool, jsailsExplainRouteTool, jsailsSchemaTool };
