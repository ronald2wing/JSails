/**
 * The sealed activation mode of a loaded app.
 *
 * The mode is not a field of the loaded app or of its resolved config. It is
 * kept here, in a module-private map keyed by the loaded app object, so no
 * consumer can read or change it by spreading, cloning or casting. Two
 * modules use it, and a structure test holds both import sites:
 *
 * - the loader (`load-app.ts`) seals the mode once, when it creates the app;
 * - the plugin resolver (`resolve-plugins.ts`) reads it, and is the only
 *   code that branches on it.
 *
 * An object the loader did not seal reads as `'locked'`, so every other path
 * fails closed.
 */

import type { ActivationMode } from '../../app/config/schema.js';

const MODES = new WeakMap<object, ActivationMode>();

/**
 * Seal `mode` on `app`. The loader calls it once, on the frozen app object it
 * has just created, so the first seal is the only one that counts.
 */
export function sealActivationMode(app: object, mode: ActivationMode): void {
  if (!MODES.has(app)) MODES.set(app, mode);
}

/** The mode sealed on `app`; `'locked'` when none was. */
export function sealedActivationMode(app: object): ActivationMode {
  return MODES.get(app) ?? 'locked';
}
