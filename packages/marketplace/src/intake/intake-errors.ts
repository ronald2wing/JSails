/**
 * Bundle intake's error codes, `bundle_intake.*`: what is wrong with a bundle
 * whose archive read cleanly. A manifest the schema refuses carries the
 * parser's value-free issues (a path, a code, a message from the schema) as
 * payload, which stays in the process.
 */

import { defineErrors, type ErrorRegistry, type Payload } from 'jsails/errors';
import type { PluginManifestIssue } from 'jsails/internal/plugin-manifest';

const INTAKE_ERRORS = {
  manifest_missing: {
    kind: 'invalid',
    message: 'the bundle has no manifest.json at its root',
    suggestion:
      'Put manifest.json at the top of the archive, or inside its single top-level directory',
  },
  multiple_manifests: {
    kind: 'invalid',
    message: 'the bundle contains more than one manifest.json',
    suggestion:
      'A bundle is one plugin: keep exactly one manifest.json, at its root; a nested one would be a second, unreviewed plugin identity',
  },
  manifest_unreadable: {
    kind: 'invalid',
    message: 'manifest.json is not a UTF-8 JSON document of at most 256 KiB',
    suggestion: 'Write manifest.json as UTF-8 JSON without a byte order mark',
  },
  manifest_invalid: {
    kind: 'invalid',
    message: 'manifest.json is not a valid bundle manifest',
    suggestion: 'Fix the issues listed with the error; the manifest reference lists every field',
    payload: {} as Payload<{ readonly issues: readonly PluginManifestIssue[] }>,
  },
  missing_file: {
    kind: 'invalid',
    message: 'the file the manifest names as its {field} is not in the bundle',
    context: { field: ['entry', 'schema'] },
    suggestion: 'Pack the entry module and the schema file the manifest declares',
  },
} as const;

/**
 * Bundle intake's codes, `bundle_intake.*`.
 *
 * @public
 */
export const IntakeErrors: ErrorRegistry<'bundle_intake', typeof INTAKE_ERRORS> = defineErrors(
  'bundle_intake',
  INTAKE_ERRORS,
);
