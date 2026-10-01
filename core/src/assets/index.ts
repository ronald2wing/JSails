/**
 * The asset index: the files an app serves from its asset roots. Re-exported
 * by `jsails/app`; the responder and the precedence rule are the server's,
 * and the path rule, the fixed-entry index and the surface rows stay inside
 * core.
 */

export { AssetErrors } from './asset-errors.js';
export {
  createAssetIndex,
  type AssetEntry,
  type AssetIndex,
  type AssetIndexSource,
  type AssetRoot,
  type AssetVariant,
  type CreateAssetIndexOptions,
  type ResolvedAssetRoot,
  type WatchAssetRoot,
} from './asset-index.js';
