/**
 * Static route resolution: the explain snapshot.
 *
 * `buildExplainResult` answers "which route handles this path, and what pipeline
 * stages would run?" purely from `discoverRoutes` + the fixed pipeline stage
 * list — it never imports page/API modules and never opens a connection.
 *
 * This module is the neutral home for that logic. The `explain` CLI command
 * (`src/cli/explain-commands.ts`) and the MCP introspection server
 * (`src/mcp/tools.ts`) are both consumers, so neither depends on the other.
 */

import { isAppConfigError, loadAppConfig, type ResolvedAppConfig } from '../app/config/index.js';
import { formatError } from '../internal/errors.js';
import { PIPELINE_STAGES } from './builtin-providers.js';
import { discoverRoutes, type RouteManifest, type RouteManifestEntry } from '../routing/routes.js';

/** The JSON shape emitted by `--json`. */
export interface ExplainResult {
  readonly path: string;
  readonly matched: boolean;
  readonly route?: {
    readonly kind: 'page' | 'api';
    readonly route: string;
    readonly dynamic: boolean;
    readonly params: readonly string[];
    readonly layoutCount: number;
  };
  /** Resolved param values when matched (e.g. { slug: 'hello' }). */
  readonly paramValues?: Readonly<Record<string, string>>;
  /** The fixed pipeline stages that would run for this request. */
  readonly stages: readonly string[];
  /** True when the path is under the reserved `/_jsails` namespace. */
  readonly reserved: boolean;
}

/** CLI input to the explain command. Exported so tests can inject fakes. */
export interface ExplainInput {
  readonly configPath: string;
  readonly path: string;
  readonly json?: boolean;
}

/** Dependency seam for the explain command. */
export interface ExplainDeps {
  loadConfig(configPath: string): Promise<ResolvedAppConfig>;
  stdout(text: string): void;
  stderr(text: string): void;
}

/**
 * Match a concrete request path against the route manifest using the same
 * Hono-style segment rules as the runtime: static segments must match exactly,
 * `[name]` segments capture one non-empty segment, and a trailing `*name`
 * (catch-all) segment captures the remainder as a slash-joined string.
 *
 * Returns `undefined` when no route matches. Prefers the first match in
 * manifest order (deterministic; `discoverRoutes` is lexical).
 */
export function matchRoute(
  manifest: RouteManifest,
  path: string,
): { entry: RouteManifestEntry; paramValues: Record<string, string> } | undefined {
  // Normalize: strip query/hash, trailing slash (except root), ensure leading slash.
  let normalised = path;
  const queryIndex = normalised.indexOf('?');
  if (queryIndex !== -1) normalised = normalised.slice(0, queryIndex);
  const hashIndex = normalised.indexOf('#');
  if (hashIndex !== -1) normalised = normalised.slice(0, hashIndex);

  if (normalised.length > 1 && normalised.endsWith('/')) {
    normalised = normalised.slice(0, -1);
  }
  if (!normalised.startsWith('/')) {
    normalised = '/' + normalised;
  }
  if (normalised === '') normalised = '/';

  const pathSegments = normalised === '/' ? [] : normalised.slice(1).split('/');

  for (const entry of manifest.entries) {
    const routeSegments = entry.route === '/' ? [] : entry.route.slice(1).split('/');

    // A catch-all route has one trailing `*name` segment that can consume the
    // remainder of the path (0..N segments).
    if (entry.catchAll) {
      const fixedCount = routeSegments.length - 1; // everything before `*name`
      if (pathSegments.length < fixedCount) continue;

      const paramValues: Record<string, string> = {};
      let matched = true;

      // Match the fixed prefix (static + `:param` segments before `*name`).
      for (let index = 0; index < fixedCount; index++) {
        const routeSegment = routeSegments[index]!;
        const pathSegment = pathSegments[index]!;

        if (routeSegment.startsWith(':')) {
          const name = routeSegment.slice(1);
          if (pathSegment === '') {
            matched = false;
            break;
          }
          paramValues[name] = tryDecode(pathSegment);
        } else if (routeSegment !== pathSegment) {
          matched = false;
          break;
        }
      }

      if (!matched) continue;

      // The catch-all segment captures remaining path segments, joined with `/`.
      const catchAllSegment = routeSegments[fixedCount]!;
      const catchAllName = catchAllSegment.slice(1); // strip `*`
      const tail = pathSegments.slice(fixedCount);
      for (const seg of tail) {
        if (seg === '') {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      // Decode each segment so the value mirrors Hono's `c.req.param('slug')`.
      paramValues[catchAllName] = tail.map((s) => tryDecode(s)).join('/');
      return { entry, paramValues };
    }

    // Exact-segment-count match for non-catch-all routes.
    if (routeSegments.length !== pathSegments.length) continue;

    const paramValues: Record<string, string> = {};
    let matched = true;

    for (let index = 0; index < routeSegments.length; index++) {
      const routeSegment = routeSegments[index]!;
      const pathSegment = pathSegments[index]!;

      if (routeSegment.startsWith(':')) {
        // Dynamic segment: capture one non-empty path segment.
        const name = routeSegment.slice(1);
        if (pathSegment === '') {
          matched = false;
          break;
        }
        paramValues[name] = tryDecode(pathSegment);
      } else if (routeSegment !== pathSegment) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return { entry, paramValues };
    }
  }

  return undefined;
}

/** Decode a URI segment, falling back to the raw segment on malformed encoding. */
function tryDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed percent encoding — use raw segment as-is.
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Reserved namespace
// ---------------------------------------------------------------------------

/** Framework-owned path prefix that is never in the filesystem manifest. */
const RESERVED_PREFIX = '/_jsails';

// ---------------------------------------------------------------------------
// buildExplainResult
// ---------------------------------------------------------------------------

/** Default dependency seam: load the real config, discard incidental output. */
export const defaultExplainDeps: ExplainDeps = {
  loadConfig: (configPath) => loadAppConfig(configPath),
  stdout: () => undefined,
  stderr: () => undefined,
};

/** Error types whose messages are safe to echo verbatim. */
/**
 * Resolve `input.path` against the app's route manifest and compose the result.
 * Returns `{ result }` on success and `{ exitCode: 1 }` on a config or discovery
 * failure (the failure message is written to `deps.stderr`). Never renders the
 * result — each consumer decides how to present it.
 */
export async function buildExplainResult(
  input: ExplainInput,
  deps: ExplainDeps = defaultExplainDeps,
): Promise<{ readonly exitCode: number; readonly result?: ExplainResult }> {
  let config: ResolvedAppConfig;
  try {
    config = await deps.loadConfig(input.configPath);
  } catch (error) {
    deps.stderr(
      `jsails: ${formatError(error, { allow: isAppConfigError, fallback: 'failed to load config' })}`,
    );
    return { exitCode: 1 };
  }

  let manifest: RouteManifest;
  try {
    manifest = discoverRoutes(config.rootDir, {
      pagesDir: config.pagesDir,
      apiDir: config.apiDir,
    });
  } catch (error) {
    deps.stderr(
      `jsails: ${formatError(error, { allow: isAppConfigError, fallback: 'route discovery failed' })}`,
    );
    return { exitCode: 1 };
  }

  const isReserved = input.path.startsWith(RESERVED_PREFIX);

  let matchedEntry: RouteManifestEntry | undefined;
  let paramValues: Record<string, string> | undefined;

  // Framework-owned paths are never in the filesystem manifest.
  if (!isReserved) {
    const match = matchRoute(manifest, input.path);
    if (match) {
      matchedEntry = match.entry;
      paramValues = match.paramValues;
    }
  }

  const result: ExplainResult = {
    path: input.path,
    matched: matchedEntry !== undefined,
    ...(matchedEntry
      ? {
          route: {
            kind: matchedEntry.kind,
            route: matchedEntry.route,
            dynamic: matchedEntry.dynamic,
            params: matchedEntry.params,
            layoutCount: matchedEntry.layouts?.length ?? 0,
          },
          paramValues,
        }
      : {}),
    stages: PIPELINE_STAGES,
    reserved: isReserved,
  };

  return { exitCode: 0, result };
}
