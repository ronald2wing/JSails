/**
 * Structural guard for a plugin object.
 *
 * The activation path (discovered plugin modules) and the `plugins.use` path
 * (specifier and factory entries) must agree on what counts as a plugin before
 * the extension runner sees it. One guard keeps that contract identical.
 */

import type { JsailsPlugin } from '../extensions/plugin-contract.js';

export function isJsailsPlugin(value: unknown): value is JsailsPlugin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' &&
    record['name'].trim() !== '' &&
    typeof record['setup'] === 'function'
  );
}
