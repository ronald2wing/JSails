/**
 * The asset copies of {@link generateStaticSite}: every entry of the asset
 * index, mapped to a contained output path and registered in the shared
 * collision map.
 *
 * The index already decided what is published: it holds no symlink, special
 * file or hidden file (`.env`), and the only dot-prefixed path it holds is
 * `/.well-known/...`. The export copies exactly what the server serves.
 */

import { resolve } from 'node:path';

import type { AssetIndex } from '../../assets/asset-index.js';
import { assertPathInside } from '../../support/path-containment.server.js';

import { addOutput, StaticSiteError, type OutputRegistry } from './plan.js';

/** A public asset to copy, mapped to its posix-separated output path. */
export interface PlannedAsset {
  readonly rel: string;
  readonly from: string;
}

/** The copies of every entry of `assets`, in path order. */
export function planAssets(
  assets: AssetIndex | undefined,
  outDir: string,
  outputs: OutputRegistry,
): PlannedAsset[] {
  if (assets === undefined) return [];
  const planned: PlannedAsset[] = [];
  for (const entry of assets.entries()) {
    const rel = entry.path.slice(1);
    const target = resolve(outDir, ...rel.split('/'));
    assertPathInside(
      outDir,
      target,
      () =>
        new StaticSiteError(
          'invalid_public_asset',
          `public asset "${rel}" escapes the output directory`,
        ),
    );
    addOutput(outputs, rel, `public asset "${rel}"`);
    planned.push({ rel, from: entry.file });
  }
  return planned;
}
