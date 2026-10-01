/**
 * Resolve a raw route middleware list against the app's named middleware map.
 *
 * Pages and API routes both accept inline handlers plus registered-name strings.
 * Resolution happens at assembly time so an unknown name fails loudly instead
 * of silently dropping a middleware. The thrown message reports only the
 * position, never the name or handler.
 */

import type { RouteMiddlewareRef } from '../routing/middleware.js';
import type { AppMiddlewareHandler } from './env.js';

export function resolveStringRefs(
  refs: readonly RouteMiddlewareRef[] | undefined,
  map: Readonly<Record<string, AppMiddlewareHandler>> | undefined,
  onError: (message: string) => Error,
): readonly AppMiddlewareHandler[] {
  if (refs === undefined || refs.length === 0) return [];
  const result: AppMiddlewareHandler[] = [];
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index];
    if (typeof ref === 'function') {
      result.push(ref);
      continue;
    }
    if (typeof ref === 'string') {
      const resolved = map === undefined ? undefined : map[ref];
      if (resolved === undefined) {
        throw onError(`references an unregistered middleware at index ${index}`);
      }
      result.push(resolved);
    }
  }
  return result;
}
