/**
 * Partial-reload selection rules (v3 protocol, partial reloads).
 *
 * A request is partial only when `X-Inertia-Partial-Component` equals the
 * component being rendered; any other value (the login page answering an
 * expired session, say) is a full visit and the Data/Except lists are ignored.
 *
 * Paths match the way the reference adapter (inertia-laravel `PropsResolver`)
 * matches them: a prop path is selected by `X-Inertia-Partial-Data` when it
 * equals or descends from a listed path, or when it leads to one (an ancestor,
 * so the walk can reach the listed child); `X-Inertia-Partial-Except` then
 * removes any path that equals or descends from an excepted path. Data
 * narrows first and Except removes second. Metadata (merge and once labels) is
 * stricter: a path that only leads to a listed path is walked but contributes
 * no metadata.
 *
 * Matching is pure string comparison on paths the engine built from the props
 * tree, so a header path can never be used to read or write an object key.
 */

import type { InertiaVisit } from './visit.js';

/** The Data/Except lists of a partial reload that applies to this component. */
export interface PartialSelection {
  readonly only: readonly string[] | null;
  readonly except: readonly string[] | null;
}

/** The selection for `component`, or `null` when the visit is a full visit. */
export function partialSelection(visit: InertiaVisit, component: string): PartialSelection | null {
  const partial = visit.partial;
  if (partial === null || partial.component !== component) return null;
  return { only: partial.only, except: partial.except };
}

/** Whether a partial reload walks into (and resolves) the prop at `path`. */
export function selectsPath(selection: PartialSelection, path: string): boolean {
  if (
    selection.only !== null &&
    !matchesAny(selection.only, path) &&
    !leadsToAny(selection.only, path)
  ) {
    return false;
  }
  return selection.except === null || !matchesAny(selection.except, path);
}

/** Whether the prop at `path` contributes merge and once metadata to a partial reload. */
export function selectsMetadata(selection: PartialSelection, path: string): boolean {
  if (selection.only !== null && !matchesAny(selection.only, path)) return false;
  return selection.except === null || !matchesAny(selection.except, path);
}

/** Whether `path` equals `parent` or lies in its subtree. */
export function isSameOrDescendant(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}.`);
}

function matchesAny(list: readonly string[], path: string): boolean {
  return list.some((entry) => isSameOrDescendant(path, entry));
}

function leadsToAny(list: readonly string[], path: string): boolean {
  return list.some((entry) => entry.startsWith(`${path}.`));
}
