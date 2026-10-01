/**
 * The single importer of route modules.
 *
 * Every API, page (not-found pages included), layout and error-boundary module the server or
 * the renderer loads goes through {@link loadRouteModule}: the path must name
 * a compiled `.js` or `.mjs` file, it is imported by file URL (so a project
 * path holding `#` or `%` loads; `importFile`), its exports are validated
 * once by the caller's validator, and the validated result is memoized on
 * the module kind and absolute path. A failed load is not kept, so it is
 * retried and Node's own module cache decides what the retry returns.
 *
 * Node caches every imported module for the life of the process (the dev
 * runtime restarts its server child on a change instead of re-importing), so
 * memoizing the validated result keeps that meaning and spares each request
 * the resolution, loader round trip and export checks. Production assembly
 * preloads every route's modules through here, so the first request after
 * listening imports nothing; development loads them on first use.
 */

import { extname, resolve } from 'node:path';

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import { importFile } from '../support/project-paths.server.js';

/**
 * The kinds of route module the importer loads.
 *
 * @public
 */
export type RouteModuleKind = 'api' | 'page' | 'layout' | 'error';

const ROUTE_MODULE_ERRORS = {
  invalid_path: {
    kind: 'internal',
    message: 'a {kind} module path must name a compiled .js or .mjs file',
    context: { kind: ['api', 'page', 'layout', 'error'] },
    suggestion: 'build the app (tsc) and point the route at the emitted file',
  },
  import_failed: {
    kind: 'internal',
    message: 'a {kind} module failed to import',
    context: { kind: ['api', 'page', 'layout', 'error'] },
    suggestion: 'the cause names the module and what failed while it evaluated',
  },
} as const;

/**
 * The route module importer's codes, `route_module.*`: a path that is not a
 * compiled module, and a module whose evaluation failed (the cause carries
 * the failure).
 *
 * @public
 */
export const RouteModuleErrors: ErrorRegistry<'route_module', typeof ROUTE_MODULE_ERRORS> =
  defineErrors('route_module', ROUTE_MODULE_ERRORS);

/** Compiled module extensions; TypeScript sources are refused. */
const MODULE_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.mjs']);

const loaded = new Map<string, Promise<unknown>>();

/**
 * Load the `kind` module at `file` and validate its exports with `validate`,
 * once per kind and absolute path.
 *
 * @throws `route_module.invalid_path` for a path that is not a compiled
 *   module, `route_module.import_failed` (with the failure as its cause) when
 *   it does not evaluate, or what `validate` throws.
 */
export function loadRouteModule<T>(
  kind: RouteModuleKind,
  file: string,
  validate: (exports: Record<string, unknown>) => T,
): Promise<T> {
  if (typeof file !== 'string' || !MODULE_EXTENSIONS.has(extname(file).toLowerCase())) {
    return Promise.reject(new RouteModuleErrors.Error('invalid_path', { kind }));
  }
  const key = `${kind}\u0000${resolve(file)}`;
  const cached = loaded.get(key);
  if (cached !== undefined) return cached as Promise<T>;
  const pending = importValidated(kind, file, validate);
  loaded.set(key, pending);
  pending.catch(() => {
    // A failed load is retried on the next call; its caller sees the failure.
    loaded.delete(key);
  });
  return pending;
}

async function importValidated<T>(
  kind: RouteModuleKind,
  file: string,
  validate: (exports: Record<string, unknown>) => T,
): Promise<T> {
  let imported: Record<string, unknown>;
  try {
    imported = await importFile(file);
  } catch (error) {
    throw new RouteModuleErrors.Error('import_failed', { kind }, { cause: error });
  }
  return validate(imported);
}
