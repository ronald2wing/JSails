/**
 * The route table: every route the app serves, as registered.
 *
 * Every registration path (filesystem API and page routes, the
 * server-component transport, introspection, health and readiness, the
 * registrar's `add` and `mount`) records a frozen {@link RouteMeta} here
 * before the router sees it. {@link RouteTable.entries} is the list of every public surface, in
 * registration order: the security cluster's surface registry and deny matrix
 * read it, and the registration snapshots pin it.
 *
 * Registration rules, each failing assembly with a `route.*` code, and each
 * checked whichever of two rows comes first:
 * - the same method and pattern registered twice is refused;
 * - a mount owns every path under its prefix: a route whose pattern lies
 *   under a mount's prefix (its leading segments are the prefix's, literally)
 *   is refused, and so is a mount at, above or under another mount;
 * - the reserved-route table: an exact reserved path (health, readiness,
 *   introspection, the component endpoints) is the framework's alone, and a
 *   mount may not cover one; the `/_jsails` namespace takes only framework
 *   and code-plugin routes (never an app's route or a managed plugin's);
 * - under `pluginOrigins: 'code-only'` a managed plugin's route is refused,
 *   the backstop of the locked activation mode.
 *
 * A pattern that only may match a path another route owns (a catch-all such
 * as `/:slug{.+}`, or `/:section/orders` beside a mount at `/api`) is not a
 * clash: it is a fallback. Assembly (`createApp`) compiles the owners first:
 * the framework routes (each answering every method of its reserved path,
 * a 405 for those it does not serve), the registrar's mounts, the
 * registrar's routes under `/_jsails`, the registrar's other routes, then the
 * filesystem routes (static segments
 * before parameters before catch-alls). So which route answers never depends
 * on the order the app, its plugins or its files happen to register in.
 *
 * The table also answers the not-found path's question, which methods a path
 * answers ({@link RouteTable.allowedMethods}), from a trie built on the first
 * miss: a matched request pays nothing for it.
 */

import { TrieRouter } from 'hono/router/trie-router';

import type { ApiMethod } from '../contracts/http.js';
import {
  isDynamicSegment,
  ownerSlot,
  patternSlot,
  RouteErrors,
  type RouteMeta,
} from './route-meta.js';

/** The framework's own namespace. */
export const RESERVED_NAMESPACE = '/_jsails';

/**
 * Which plugin origins an app serves routes from.
 *
 * @public
 */
export type PluginOrigins = 'code-only' | 'allow-managed';

/**
 * Every route the app serves.
 *
 * @public
 */
export interface RouteTable {
  /** Every registered route, in registration order. */
  entries(): readonly RouteMeta[];
  /** The methods a concrete `path` answers, sorted; empty when no route has its path. */
  allowedMethods(path: string): readonly string[];
}

/** The table assembly writes and the not-found path reads. */
export interface MutableRouteTable extends RouteTable {
  /** Record `meta`, enforcing the registration rules; returns the frozen record. */
  record(meta: RouteMeta): RouteMeta;
}

/** Options for {@link createRouteTable}. */
export interface RouteTableOptions {
  /** Exact paths only the framework registers (health, readiness, endpoints). */
  readonly reservedPaths: ReadonlySet<string>;
  readonly pluginOrigins: PluginOrigins;
}

/** A table enforcing the registration rules of `options`. */
export function createRouteTable(options: RouteTableOptions): MutableRouteTable {
  const rows: RouteMeta[] = [];
  const registered = new Set<string>();
  const mounts: RouteMeta[] = [];
  let trie: TrieRouter<readonly string[]> | undefined;

  const overlap = (meta: RouteMeta, prefix: string): Error =>
    new RouteErrors.Error('mount_overlap', {
      pattern: patternSlot(meta.pattern),
      prefix: patternSlot(prefix),
      owner: ownerSlot(meta.owner),
    });

  // A mount and a route under it, or two nested mounts, answer the same
  // paths; whichever is recorded second is refused.
  const assertNoMountOverlap = (meta: RouteMeta): void => {
    for (const mount of mounts) {
      if (liesUnder(meta.pattern, mount.pattern)) throw overlap(meta, mount.pattern);
      if (meta.kind === 'mount' && liesUnder(mount.pattern, meta.pattern)) {
        throw overlap(meta, mount.pattern);
      }
    }
    if (meta.kind !== 'mount') return;
    for (const row of rows) {
      if (liesUnder(row.pattern, meta.pattern)) throw overlap(meta, row.pattern);
    }
  };

  const assertAllowed = (meta: RouteMeta): void => {
    const pattern = patternSlot(meta.pattern);
    const owner = ownerSlot(meta.owner);
    if (meta.origin === 'managed-plugin' && options.pluginOrigins === 'code-only') {
      throw new RouteErrors.Error('managed_origin_refused', { pattern, owner });
    }
    if (meta.kind === 'mount' && meta.pattern.split('/').some(isDynamicSegment)) {
      throw new RouteErrors.Error('invalid_path', { owner, problem: 'dynamic_mount' });
    }
    if (meta.origin === 'framework') return;
    const reserved =
      options.reservedPaths.has(meta.pattern) ||
      (meta.kind === 'mount' && coversReserved(meta.pattern, options.reservedPaths)) ||
      (inNamespace(meta.pattern) && meta.origin !== 'code-plugin');
    if (reserved) throw new RouteErrors.Error('reserved_path', { pattern, owner });
  };

  return {
    record(meta) {
      assertAllowed(meta);
      assertNoMountOverlap(meta);
      const frozen = Object.freeze({ ...meta, methods: Object.freeze([...meta.methods]) });
      for (const method of frozen.methods) {
        const key = `${method} ${frozen.pattern}`;
        if (registered.has(key)) {
          throw new RouteErrors.Error('duplicate_route', {
            pattern: patternSlot(frozen.pattern),
            method,
            owner: ownerSlot(frozen.owner),
          });
        }
      }
      for (const method of frozen.methods) registered.add(`${method} ${frozen.pattern}`);
      rows.push(frozen);
      if (frozen.kind === 'mount') mounts.push(frozen);
      trie = undefined;
      return frozen;
    },
    entries() {
      return Object.freeze(rows.slice());
    },
    allowedMethods(path) {
      trie ??= buildTrie(rows);
      const allowed = new Set<string>();
      for (const [methods] of trie.match('ALL', path)[0]) {
        for (const method of methods) allowed.add(method);
      }
      return [...allowed].sort();
    },
  };
}

/** Whether `pattern` is the framework namespace or under it. */
export function inNamespace(pattern: string): boolean {
  return pattern === RESERVED_NAMESPACE || pattern.startsWith(`${RESERVED_NAMESPACE}/`);
}

/**
 * Whether every path `pattern` matches is at or under the literal `prefix`:
 * its leading segments are the prefix's segments, written literally. A
 * pattern with a parameter or wildcard among those segments may match paths
 * elsewhere too, so it is a fallback, not under the prefix.
 */
export function liesUnder(pattern: string, prefix: string): boolean {
  if (prefix === '/') return true;
  const owned = prefix.split('/');
  const segments = pattern.split('/');
  if (segments.length < owned.length) return false;
  return owned.every((segment, index) => {
    const candidate = segments[index]!;
    return candidate === segment && !isDynamicSegment(candidate);
  });
}

/** Whether a mount at `prefix` (the prefix and everything under it) covers a reserved path. */
function coversReserved(prefix: string, reserved: ReadonlySet<string>): boolean {
  if (prefix === '/') return reserved.size > 0;
  for (const path of reserved) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/**
 * The pattern-to-methods trie of the 405 answer: a mount answers every method,
 * names no method of its own and is left out; GET implies HEAD.
 */
function buildTrie(rows: readonly RouteMeta[]): TrieRouter<readonly string[]> {
  const byPattern = new Map<string, Set<ApiMethod>>();
  for (const meta of rows) {
    if (meta.kind === 'mount') continue;
    const methods = byPattern.get(meta.pattern) ?? new Set<ApiMethod>();
    for (const method of meta.methods) {
      methods.add(method);
      if (method === 'GET') methods.add('HEAD');
    }
    byPattern.set(meta.pattern, methods);
  }
  const built = new TrieRouter<readonly string[]>();
  for (const [pattern, methods] of byPattern) built.add('ALL', pattern, [...methods]);
  return built;
}
