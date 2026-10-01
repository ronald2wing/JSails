/**
 * Which of a path's owners answers it, decided at assembly: an asset, or a
 * route.
 *
 * Assets are served before routing, so a literal asset path wins over a
 * parametric route (`/:slug`), a catch-all and a mount's prefix: a root
 * `[slug]` page and `public/favicon.ico` coexist, and the file is served.
 * What cannot coexist is an asset whose path equals a literal route pattern
 * (a mount's own prefix included), a reserved framework path, or a path in
 * the `/_jsails` namespace: two answers for one path. That fails assembly
 * with `asset.route_collision` and the count. With a development index
 * (`watch`) it is a warning instead, the route keeps the path, and the rule
 * runs again whenever the files change, so a dev server keeps running while
 * files move.
 *
 * A directory alias (`/docs` and `/docs/` for `docs/index.html`) is a
 * convenience, not a claim: a literal route on an alias path keeps it,
 * silently, and the file is still served at its own path.
 */

import { RESERVED_NAMESPACE } from '../server/route-table.js';
import { isDynamicSegment, type RouteMeta } from '../server/route-meta.js';
import { AssetErrors, pathSlot } from './asset-errors.js';
import type { AssetIndex } from './asset-index.js';
import { directoryAliases } from './asset-path.js';
import type { AssetResponder } from './responder.js';

/** The asset paths an assembled app's routes claim. */
export interface AssetCollisions {
  /** Entry paths equal to a literal route, a reserved path, or a namespace path; sorted. */
  readonly entries: readonly string[];
  /** Directory alias paths equal to one; sorted. */
  readonly aliases: readonly string[];
}

/** What the asset rules are checked against. */
export interface AssetRuleInputs {
  /** Every route the app serves (the route table's rows). */
  readonly routes: () => readonly RouteMeta[];
  /** The framework's reserved exact paths. */
  readonly reserved: ReadonlySet<string>;
  /** Whether the app runs in production: an unbuilt index is then worth a warning. */
  readonly production: boolean;
}

/** Find the asset paths `routes`, `reserved` and the namespace claim. */
export function findAssetCollisions(
  paths: Iterable<string>,
  routes: readonly RouteMeta[],
  reserved: ReadonlySet<string>,
): AssetCollisions {
  const literal = new Set<string>();
  for (const route of routes) {
    if (!route.pattern.split('/').some(isDynamicSegment)) literal.add(route.pattern);
  }
  const claimed = (path: string): boolean =>
    literal.has(path) ||
    reserved.has(path) ||
    path === RESERVED_NAMESPACE ||
    path.startsWith(`${RESERVED_NAMESPACE}/`);
  const entries: string[] = [];
  const aliases: string[] = [];
  for (const path of paths) {
    if (claimed(path)) entries.push(path);
    for (const alias of directoryAliases(path)) if (claimed(alias)) aliases.push(alias);
  }
  return { entries: entries.sort(), aliases: aliases.sort() };
}

/**
 * Apply the precedence rule to `responder`, and warn once when a production
 * app serves a snapshot it hashed at start instead of a built index. A
 * snapshot that holds no file (no asset root, or only empty ones) gives no
 * warning: there was nothing to read, and a build would add nothing.
 *
 * @throws `asset.route_collision` for a snapshot or built index.
 */
export function enforceAssetRules(
  index: AssetIndex,
  responder: AssetResponder,
  inputs: AssetRuleInputs,
): void {
  if (index.source === 'snapshot' && inputs.production && !isEmpty(index.paths())) {
    process.emitWarning(
      'jsails: the asset index was built at start from the asset roots (no build manifest): every file was read and hashed, and none has a precompressed copy',
      { code: 'JSAILS_ASSETS_NOT_BUILT' },
    );
  }
  let warned = '';
  const check = (): void => {
    const found = findAssetCollisions(index.paths(), inputs.routes(), inputs.reserved);
    const first = found.entries[0];
    if (index.source !== 'watch') {
      if (first !== undefined) {
        throw new AssetErrors.Error('route_collision', {
          count: found.entries.length,
          path: pathSlot(first),
        });
      }
      responder.block(new Set(found.aliases));
      return;
    }
    responder.block(new Set([...found.entries, ...found.aliases]));
    const key = found.entries.join('\n');
    if (first !== undefined && key !== warned) {
      process.emitWarning(
        `jsails: ${found.entries.length} asset path(s) equal a route or a reserved path, first "${pathSlot(first)}"; the route answers them`,
        { code: 'JSAILS_ASSET_ROUTE_COLLISION' },
      );
    }
    warned = key;
  };
  check();
  if (index.source === 'watch') index.onChange(check);
}

function isEmpty(paths: Iterable<string>): boolean {
  return paths[Symbol.iterator]().next().done === true;
}
