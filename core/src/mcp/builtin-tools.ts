/**
 * The developer server's tools: read-only introspection of one JSails app.
 *
 * Each tool wraps an existing introspection function (describe, route
 * discovery, explain, schema extraction) and never reimplements it. Every tool
 * is annotated read-only, idempotent, and closed-world, so a client can run it
 * without asking the developer first, and every input schema is closed
 * (`additionalProperties: false`): an argument a tool does not declare is a
 * rejected call, not a silently ignored one.
 *
 * The config modules a tool loads are fixed when the tool set is built
 * ({@link createJsailsMcpTools}), never chosen by the caller: loading a config
 * module executes it, so a model-supplied path would be arbitrary module
 * execution in the server process. Arguments carry only the question (the
 * request path to explain).
 *
 * Failures are framework errors with stable codes. A config module that does
 * not load is `config_unavailable`, distinct from an explain answer of
 * `{ matched: false }`, which is a successful result.
 *
 * Server-only. Building the tool set loads only Zod, for the advertised input
 * schemas: the app config loader, route discovery, schema extraction, and
 * explain matching are imported by the first call that needs them, so a
 * client's handshake and `tools/list` never execute the app's config module
 * or load the framework's runtime.
 */

import { z } from 'zod';

import { DEFAULT_APP_CONFIG_PATH } from '../app/config/defaults.js';
import type { ResolvedAppConfig } from '../app/config/index.js';
import { DEFAULT_DATABASE_CONFIG_PATH } from '../config-modules.js';
import { JsailsError, type JsailsErrorContextValue } from '../errors/jsails-error.js';

/** The config modules a tool set introspects. */
export interface JsailsMcpToolsOptions {
  /** Compiled app config module (default: `jsails.app.js`). */
  readonly configPath?: string;
  /** Database config module (default: `jsails.database.js`). */
  readonly dbConfigPath?: string;
}

const jsailsMcpToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;
/** The hints every developer tool carries: it reads, repeats, and stays local. */
export const JSAILS_MCP_TOOL_ANNOTATIONS: typeof jsailsMcpToolAnnotations =
  Object.freeze(jsailsMcpToolAnnotations);

/** One developer tool, ready for the server to register. */
export interface JsailsMcpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The JSON Schema 2020-12 document advertised in `tools/list`. Frozen. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: typeof JSAILS_MCP_TOOL_ANNOTATIONS;
  /** Validate the arguments, then answer. Throws {@link JsailsMcpToolError}. */
  call(args: unknown): Promise<unknown>;
}

/** Stable codes carried by {@link JsailsMcpToolError}. */
export type JsailsMcpToolErrorCode =
  'invalid_arguments' | 'config_unavailable' | 'routes_unavailable';

/** A developer tool's value-free failure, reported to the client as a tool error. */
export class JsailsMcpToolError extends JsailsError {
  constructor(
    readonly code: JsailsMcpToolErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly context?: Readonly<Record<string, JsailsErrorContextValue>>;
      readonly suggestion?: string;
    },
  ) {
    super(message, options);
  }
}

function defineTool<Schema extends z.ZodType>(spec: {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: Schema;
  readonly run: (args: z.output<Schema>) => Promise<unknown>;
}): JsailsMcpTool {
  const inputSchema = deepFreeze(
    z.toJSONSchema(spec.input, { target: 'draft-2020-12', io: 'input' }),
  ) as Readonly<Record<string, unknown>>;
  return Object.freeze({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema,
    annotations: JSAILS_MCP_TOOL_ANNOTATIONS,
    async call(args: unknown): Promise<unknown> {
      const parsed = spec.input.safeParse(args ?? {});
      if (!parsed.success) {
        // The issues name caller-supplied keys and values; only their count leaves.
        throw new JsailsMcpToolError(
          'invalid_arguments',
          'the arguments do not match the tool input schema',
          {
            context: { issues: parsed.error.issues.length },
            suggestion: 'Send only the arguments the tool declares in tools/list.',
          },
        );
      }
      return spec.run(parsed.data);
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

async function loadConfigForTool(configPath: string): Promise<ResolvedAppConfig> {
  try {
    const { loadAppConfig } = await import('../app/config/load.js');
    return await loadAppConfig(configPath);
  } catch (cause) {
    throw new JsailsMcpToolError(
      'config_unavailable',
      'the app config module could not be loaded',
      {
        cause,
        ...(cause instanceof JsailsError ? { context: { reason: cause.code } } : {}),
        suggestion: 'Run "jsails describe" in the project to see why the config does not load.',
      },
    );
  }
}

/**
 * Build the developer tools bound to fixed config paths. The order is the
 * order `tools/list` reports.
 */
export function createJsailsMcpTools(
  options: JsailsMcpToolsOptions = {},
): readonly JsailsMcpTool[] {
  const configPath =
    options.configPath !== undefined && options.configPath.length > 0
      ? options.configPath
      : DEFAULT_APP_CONFIG_PATH;
  const dbConfigPath =
    options.dbConfigPath !== undefined && options.dbConfigPath.length > 0
      ? options.dbConfigPath
      : undefined;
  const noArguments = z.strictObject({});

  const describeTool = defineTool({
    name: 'jsails_describe',
    title: 'Describe the app',
    description:
      'A machine-readable snapshot of the JSails app definition: routes, plugins, commands, server components, and the declared entity schema.',
    input: noArguments,
    async run() {
      const config = await loadConfigForTool(configPath);
      const { buildDescribeResult, defaultDescribeDeps } =
        await import('../introspect/describe.js');
      return buildDescribeResult(
        { configPath, dbConfigPath, options: { json: true } },
        { ...defaultDescribeDeps, loadConfig: () => Promise.resolve(config) },
      );
    },
  });

  const inspectRoutesTool = defineTool({
    name: 'jsails_inspect_routes',
    title: 'List routes',
    description:
      'Every filesystem route (page and API) with its parameters, from the build-time code index when it is current, otherwise from a scan of the compiled pages/ and api/ directories.',
    input: noArguments,
    async run() {
      const config = await loadConfigForTool(configPath);
      const [{ fromIndexOrScan }, { discoverRoutes }] = await Promise.all([
        import('./index-source.js'),
        import('../routing/routes.js'),
      ]);
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

  const explainRouteTool = defineTool({
    name: 'jsails_explain_route',
    title: 'Explain a request path',
    description:
      'Which route handles a request path: the matched route, its parameter values, and the pipeline stages. A path no route handles is a successful answer with matched: false.',
    input: z.strictObject({
      path: z.string().min(1).describe('The request path to resolve, such as /blog/hello'),
    }),
    async run({ path }) {
      const config = await loadConfigForTool(configPath);
      const { buildExplainResult } = await import('../introspect/explain.js');
      const { exitCode, result } = await buildExplainResult(
        { configPath, path },
        {
          loadConfig: () => Promise.resolve(config),
          stdout: () => undefined,
          stderr: () => undefined,
        },
      );
      // The config is already loaded, so the only failure left is discovery.
      if (result === undefined || exitCode !== 0) {
        throw new JsailsMcpToolError(
          'routes_unavailable',
          'the routes could not be discovered from the compiled pages and api directories',
          { suggestion: 'Build the app, then run "jsails inspect routes" to see the error.' },
        );
      }
      return result;
    },
  });

  const schemaTool = defineTool({
    name: 'jsails_schema',
    title: 'Entity schema',
    description:
      'The declared entity schema (tables, columns, indexes, foreign keys) from model metadata, without connecting to a database. Reads only the database config; an empty tables array when there is none.',
    input: noArguments,
    async run() {
      const { buildDescribeSchema } = await import('../introspect/describe.js');
      return buildDescribeSchema(dbConfigPath ?? DEFAULT_DATABASE_CONFIG_PATH);
    },
  });

  return Object.freeze([describeTool, inspectRoutesTool, explainRouteTool, schemaTool]);
}
