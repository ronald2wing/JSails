/**
 * Public-asset discovery for {@link generateStaticSite}.
 *
 * Walks `publicDir` and records every copyable file: dot-files are skipped,
 * symlinks and non-regular files are rejected, and every asset is mapped to a
 * contained output path and registered in the shared collision map.
 */

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assertPathInside } from '../../support/path-containment.server.js';

import { addOutput, StaticSiteError } from './plan.js';

/** A copyable public asset mapped to its posix-separated output path. */
export interface PlannedAsset {
  readonly rel: string;
  readonly from: string;
}

/** Recursively collect copyable public assets, rejecting symlinks and dot-files. */
export function planAssets(
  publicDir: string | undefined,
  outDir: string,
  outputs: Map<string, string>,
): PlannedAsset[] {
  if (publicDir === undefined || !existsSync(publicDir)) return [];

  const rootStat = lstatSync(publicDir);
  if (rootStat.isSymbolicLink()) {
    throw new StaticSiteError(
      'invalid_public_asset',
      `publicDir "${publicDir}" must not be a symlink`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new StaticSiteError(
      'invalid_public_asset',
      `publicDir "${publicDir}" must be a directory`,
    );
  }

  const assets: PlannedAsset[] = [];
  walk('', publicDir);
  return assets;

  function walk(prefix: string, dir: string): void {
    const dirents = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const dirent of dirents) {
      // Dot-entries are skipped, never copied: this is what keeps `.env` and
      // other secret-bearing files out of the published output.
      if (dirent.name.startsWith('.')) continue;

      const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      const full = join(dir, dirent.name);

      if (dirent.isSymbolicLink()) {
        throw new StaticSiteError(
          'invalid_public_asset',
          `public asset "${rel}" is a symlink; symlinks are not copied`,
        );
      }
      if (dirent.isDirectory()) {
        walk(rel, full);
        continue;
      }
      if (!dirent.isFile()) {
        throw new StaticSiteError(
          'invalid_public_asset',
          `public asset "${rel}" is not a regular file`,
        );
      }

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
      assets.push({ rel, from: full });
    }
  }
}
