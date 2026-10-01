/**
 * Permission ceilings: the most a publisher's releases, or anything on a site,
 * may be granted. A ceiling entry is a registered permission exactly as a
 * manifest declares it (`mail.send`, `net.fetch:api.example.com`), or a scoped
 * permission with `*` as its scope (`net.fetch:*`), which covers every scope of
 * it. A release passes when every permission it asks for is covered by its
 * publisher's ceiling and by the site's.
 */

import { getPermission, parsePermission } from 'jsails/internal/plugin-manifest';

/** A checked ceiling, ready for lookups. */
export interface CompiledCeiling {
  /** The entries as declared, in order. */
  readonly entries: readonly string[];
  readonly exact: ReadonlySet<string>;
  /** Ids of scoped permissions covered whatever their scope. */
  readonly anyScope: ReadonlySet<string>;
}

const MAX_ENTRIES = 200;
const ANY_SCOPE = ':*';

/** Check a declared ceiling: registered permissions or `id:*`, no duplicates. `undefined` when invalid. */
export function compileCeiling(value: unknown): CompiledCeiling | undefined {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) return undefined;
  const exact = new Set<string>();
  const anyScope = new Set<string>();
  const entries: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'string' || entries.includes(entry)) return undefined;
    if (entry.endsWith(ANY_SCOPE)) {
      const id = entry.slice(0, -ANY_SCOPE.length);
      if (getPermission(id)?.scoped === undefined) return undefined;
      anyScope.add(id);
    } else {
      if (!parsePermission(entry).ok) return undefined;
      exact.add(entry);
    }
    entries.push(entry);
  }
  return Object.freeze({ entries: Object.freeze(entries), exact, anyScope });
}

/** Whether `ceiling` covers the registered permission `permission`. */
export function ceilingCovers(ceiling: CompiledCeiling, permission: string): boolean {
  if (ceiling.exact.has(permission)) return true;
  const parsed = parsePermission(permission);
  return (
    parsed.ok &&
    parsed.permission.scope !== undefined &&
    ceiling.anyScope.has(parsed.permission.definition.id)
  );
}
