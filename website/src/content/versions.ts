/**
 * Docs version source of truth — a thin path adapter over `@jsails/content`.
 *
 * The framework primitive owns manifest reading, validation, and version
 * resolution; the site only needs the manifest path.
 */
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { readContentVersions, type ContentVersionsManifest } from '@jsails/content';

function resolveVersionsPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));
  return resolvePath(__dirname, '..', '..', '..', 'content', 'versions.json');
}

export function readDocsVersions(): ContentVersionsManifest {
  return readContentVersions(resolveVersionsPath());
}
