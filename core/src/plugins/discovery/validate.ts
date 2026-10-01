/**
 * Manifest validation for discovered plugin packages.
 *
 * Turns a raw `jsails` field into a validated {@link PluginManifestV1}. It never
 * walks the dependency graph — that is {@link ./scan.js} and
 * {@link ./dependencies.js} — and it never imports a module or opens a
 * connection. Manifest shape validation is delegated to
 * {@link parsePluginManifest}; this module only records value-free issues and
 * decides whether a plugin is omitted or admitted.
 */

import {
  parsePluginManifest,
  PluginManifestError,
  type PluginManifestV1,
  type PluginManifestIssue,
} from '../manifest/index.js';

import type { PluginIssue } from './scan.js';

/**
 * Parse a raw `jsails` manifest value into a {@link PluginManifestV1}, recording a
 * value-free `invalid_manifest` issue on failure. Returns `undefined` when the
 * manifest is invalid (the plugin is omitted).
 */
export function parseDependencyManifest(
  raw: unknown,
  manifestPath: string,
  issues: PluginIssue[],
): PluginManifestV1 | undefined {
  try {
    return parsePluginManifest(raw, 'package');
  } catch (error) {
    const message =
      error instanceof PluginManifestError ? formatManifestIssues(error) : 'invalid manifest';
    issues.push({
      code: 'invalid_manifest',
      message,
      path: manifestPath,
      pluginId: readManifestId(raw),
    });
    return undefined;
  }
}

/** Extract a best-effort plugin id from a raw manifest for issue attribution. */
function readManifestId(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const id = (raw as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Render a value-free summary of the manifest issues (never raw values). */
function formatManifestIssues(error: PluginManifestError): string {
  return `invalid plugin manifest: ${error.issues.map(renderIssue).join('; ')}`;
}

function renderIssue(issue: PluginManifestIssue): string {
  const location = issue.path.length > 0 ? issue.path.join('.') : '(manifest)';
  return `${location}: ${issue.message}`;
}
