/**
 * Inspect commands: read-only introspection of the application's route
 * manifest. `inspect routes` wraps `discoverRoutes` and prints the manifest
 * without importing page/API modules or opening a connection.
 *
 * ```sh
 * jsails inspect routes --json        # machine-readable
 * jsails inspect routes                # human-readable table
 * jsails inspect routes --config jsails.app.js
 * ```
 */

import { resolve } from 'node:path';

import { DEFAULT_APP_CONFIG_PATH } from '../../app/config/defaults.js';
import { isAppConfigError } from '../../app/config/errors.js';
import type { ResolvedAppConfig } from '../../app/config/index.js';
import type { RouteManifest } from '../../routing/routes.js';
import { loadAppConfig } from '../config-loader.js';
import type { CommandModule } from '../descriptor.js';
import type { APP_JSON_OPTIONS } from '../manifest.js';
import { renderResult, writeFailure } from '../report.js';

/** Options for {@link runInspectRoutesCommand}. */
interface InspectRoutesOptions {
  /** Print a single JSON line instead of the human-readable table. */
  readonly json?: boolean;
}

/**
 * CLI input to the route introspection command.
 * Exported so tests can inject fakes.
 */
interface InspectRoutesInput {
  /** Path to the compiled app config module. */
  readonly configPath: string;
  /** Options parsed from CLI flags. */
  readonly options: InspectRoutesOptions;
}

/** Dependency seam for the `inspect routes` command. */
export interface InspectRoutesDeps {
  /** Load and resolve the app config. */
  loadConfig(configPath: string): Promise<ResolvedAppConfig>;
  /** Write one output line. */
  stdout(text: string): void;
  /** Write one error line. */
  stderr(text: string): void;
  /** The environment a failure report reads `JSAILS_DEBUG` from. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

const defaultInspectRoutesDeps: Omit<InspectRoutesDeps, 'env'> = {
  loadConfig: (configPath) => loadAppConfig(configPath),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

/**
 * Load the app config, call `discoverRoutes`, and print the route manifest.
 * Returns a process exit code. Errors are value-free: config and route failures
 * are caught and printed to stderr, returning 1.
 */
export async function runInspectRoutes(
  input: InspectRoutesInput,
  deps: InspectRoutesDeps,
): Promise<number> {
  let config: ResolvedAppConfig;
  try {
    config = await deps.loadConfig(input.configPath);
  } catch (error) {
    await writeFailure(error, (line) => deps.stderr(line), {
      allow: isAppConfigError,
      fallback: 'failed to load config',
      env: deps.env,
    });
    return 1;
  }

  const rootDir = config.rootDir;
  const resolvedPagesDir = config.pagesDir;
  const resolvedApiDir = config.apiDir;

  const { discoverRoutes } = await import('../../routing/routes.js');
  let manifest: RouteManifest;
  try {
    manifest = discoverRoutes(rootDir, { pagesDir: resolvedPagesDir, apiDir: resolvedApiDir });
  } catch (error) {
    await writeFailure(error, (line) => deps.stderr(line), {
      allow: isAppConfigError,
      fallback: 'route discovery failed',
      env: deps.env,
    });
    return 1;
  }

  const lines = renderRouteManifest(manifest, { json: input.options.json === true });
  for (const line of lines) {
    deps.stdout(line);
  }
  return 0;
}

/**
 * Render the route manifest as output lines.
 *
 * JSON shape (stable; keep in sync with the help text):
 * ```
 * {
 *   "entries": [
 *     {
 *       "kind": "page" | "api",
 *       "route": "/path/:param",
 *       "file": "/abs/path/to/file.js",
 *       "dynamic": true | false,
 *       "catchAll": false,
 *       "params": ["param"]
 *     }
 *   ]
 * }
 * ```
 */
function renderRouteManifest(
  manifest: RouteManifest,
  format: { readonly json: boolean },
): readonly string[] {
  const entries = manifest.entries.map((entry) => ({
    kind: entry.kind,
    route: entry.route,
    file: resolve(entry.file),
    dynamic: entry.dynamic,
    catchAll: entry.catchAll,
    params: entry.params,
  }));
  return renderResult({ entries }, { json: format.json, render: () => renderRouteTable(manifest) });
}

function renderRouteTable(manifest: RouteManifest): string[] {
  if (manifest.entries.length === 0) {
    return ['No routes found.'];
  }

  const lines: string[] = [
    `Route manifest (${manifest.entries.length} route(s)):`,
    '',
    'ROUTE                   KIND   DYNAMIC   PARAMS           FILE',
    '----                    ----   -------   ------           ----',
  ];
  for (const entry of manifest.entries) {
    const route = entry.route.padEnd(22);
    const kind = entry.kind.padEnd(6);
    const dynamic = String(entry.dynamic).padEnd(9);
    const params = entry.params.join(',').padEnd(16);
    lines.push(`${route} ${kind} ${dynamic} ${params} ${entry.file}`);
  }
  return lines;
}

/** `jsails inspect routes [--json]`. */
export const inspectCommand: CommandModule<typeof APP_JSON_OPTIONS, 'environment'> = {
  run: (context) => {
    if (context.positionals[0] !== 'routes') return context.usage('the one subject is routes');
    return runInspectRoutes(
      {
        configPath: context.values.config ?? DEFAULT_APP_CONFIG_PATH,
        options: { json: context.values.json === true },
      },
      { ...defaultInspectRoutesDeps, env: context.env },
    );
  },
};
