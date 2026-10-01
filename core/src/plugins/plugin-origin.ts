/**
 * Which extensions are managed plugins.
 *
 * The capability gate (`gatePluginCapabilities`) marks every wrapper it
 * returns here; nothing else marks a plugin. The framework activates no
 * managed plugin yet, so only a plugin an app passes through the gate itself
 * carries the mark until the marketplace plugin source does. The extension
 * runner reads the mark when it builds an extension's HTTP registrar: a
 * managed plugin's routes are stamped `managed-plugin` (refused by an app
 * whose plugin origins are code-only) and it is never granted `mount`. The
 * mark lives in core only, so no plugin can claim or shed it.
 */

const managed = new WeakSet<object>();

/** Mark `extension` as a managed plugin. */
export function markManagedPlugin(extension: object): void {
  managed.add(extension);
}

/** Whether `extension` was marked as a managed plugin. */
export function isManagedPlugin(extension: object): boolean {
  return managed.has(extension);
}
