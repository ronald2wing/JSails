/**
 * The asset index as rows of the app's surface list: one per entry, shaped
 * like a route's record. The surface registry (`security/surfaces.ts`)
 * describes the whole index as one `asset:public` surface, since one access
 * decides every file; these rows are the files behind it, listed beside the
 * routes. Only a caller of {@link assetRowsOf} loads this module:
 * assembly records the app's asset surface (`server/app.ts`), and serving
 * never builds a row.
 *
 * A row is an entry's own path: the directory aliases of an index document
 * (`/docs`, `/docs/`) are a convenience over the entry, not surfaces of
 * their own.
 */

import { assetSurfaceOf } from '../server/app.js';
import type { AssetIndex } from './asset-index.js';

/**
 * One asset as a surface: its path, the methods it answers, who provides it.
 * Every asset is public (it is public by being in an asset root) and reads no
 * credential.
 *
 * @public
 */
export interface AssetRow {
  readonly kind: 'asset';
  readonly pattern: string;
  readonly methods: readonly ['GET', 'HEAD'];
  readonly owner: string;
}

const METHODS: readonly ['GET', 'HEAD'] = Object.freeze(['GET', 'HEAD'] as const);

/**
 * The asset surface of an app `createApp` built: one row per file its asset
 * index serves, sorted by path, read at the call (a development index's rows
 * follow its files). A path a route keeps is the route's, not a row. Empty
 * for an app without an asset index; `undefined` for any other object.
 * Beside `routeTableOf`, it lists every surface the app answers through.
 *
 * @public
 */
export function assetRowsOf(app: object): readonly AssetRow[] | undefined {
  const surface = assetSurfaceOf(app);
  if (surface === undefined) return undefined;
  if (surface === null) return Object.freeze([]);
  return assetRows(surface.index, (path) => surface.responder.blocks(path));
}

/**
 * The surface rows of every entry of `index` that `blocked` does not take
 * from it (a path a route keeps), sorted by path.
 */
function assetRows(index: AssetIndex, blocked: (path: string) => boolean): readonly AssetRow[] {
  // Read first: a development index runs the precedence rule while it
  // refreshes, which may change what `blocked` answers.
  const entries = [...index.entries()];
  return Object.freeze(
    entries
      .filter((entry) => !blocked(entry.path))
      .map((entry) =>
        Object.freeze({
          kind: 'asset' as const,
          pattern: entry.path,
          methods: METHODS,
          owner: entry.owner,
        }),
      ),
  );
}
