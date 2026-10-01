/**
 * Detect public files that a filesystem route answers first.
 *
 * Public files are mounted after every page and API route on purpose: a file
 * in `public/` (which may hold uploads) must never shadow a protected handler.
 * The cost of that order is that a route matching a public file's URL — most
 * often a root `pages/[slug]` or catch-all page and `/favicon.ico` or
 * `/robots.txt` — answers the request and the file is never served.
 * {@link findShadowedPublicFiles} finds those pairs and
 * {@link groupShadowedPublicFiles} folds them into one summary per route, so
 * assembly can warn about them instead of failing silently, without a
 * catch-all page producing one warning per public file. The walk is bounded and never follows a
 * symlink (the public-files middleware refuses to serve through one anyway).
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { RouteManifest, RouteManifestEntry } from '../routing/routes.js';

/** Upper bound on the public files inspected, so a huge public tree cannot stall boot. */
const MAX_PUBLIC_FILES = 5000;

/** A public file whose URL a route claims first. */
export interface ShadowedPublicFile {
  /** URL path of the public file, e.g. `/favicon.ico`. */
  readonly path: string;
  /** The manifest route that answers that path, e.g. `/:slug`. */
  readonly route: string;
  /** The route's source file. */
  readonly file: string;
}

/**
 * List the public files a page or API route would answer before the
 * public-files middleware sees the request. A missing public directory yields
 * an empty list.
 */
export function findShadowedPublicFiles(
  manifest: RouteManifest,
  publicDir: string,
): readonly ShadowedPublicFile[] {
  const shadowed: ShadowedPublicFile[] = [];
  for (const segments of listPublicFiles(publicDir)) {
    const entry = manifest.entries.find((candidate) => routeMatches(candidate, segments));
    if (entry !== undefined) {
      shadowed.push({ path: `/${segments.join('/')}`, route: entry.route, file: entry.file });
    }
  }
  return shadowed;
}

/** The public files one route shadows, summarized for a single warning. */
export interface ShadowingRoute {
  /** The manifest route, e.g. `/*slug`. */
  readonly route: string;
  /** The route's source file. */
  readonly file: string;
  /** How many public files the route shadows. */
  readonly count: number;
  /** The first few shadowed URL paths, sorted, at most `exampleLimit`. */
  readonly examples: readonly string[];
}

/** Group shadowed files by the route that answers them, in route order of first appearance. */
export function groupShadowedPublicFiles(
  shadowed: readonly ShadowedPublicFile[],
  exampleLimit = 3,
): readonly ShadowingRoute[] {
  const byRoute = new Map<string, { file: string; paths: string[] }>();
  for (const item of shadowed) {
    const group = byRoute.get(item.route);
    if (group === undefined) byRoute.set(item.route, { file: item.file, paths: [item.path] });
    else group.paths.push(item.path);
  }
  return [...byRoute].map(([route, { file, paths }]) => ({
    route,
    file,
    count: paths.length,
    examples: paths.sort().slice(0, exampleLimit),
  }));
}

/** Whether a manifest route matches a request path split into segments. */
function routeMatches(entry: RouteManifestEntry, segments: readonly string[]): boolean {
  const parts = entry.route === '/' ? [] : entry.route.slice(1).split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part.startsWith('*')) {
      const rest = segments.length - i;
      return entry.optionalCatchAll === true ? rest >= 0 : rest >= 1;
    }
    const segment = segments[i];
    if (segment === undefined) return false;
    if (part.startsWith(':')) continue;
    if (part !== segment) return false;
  }
  return parts.length === segments.length;
}

/** Path segments of every regular file under `publicDir`, bounded and symlink-free. */
function listPublicFiles(publicDir: string): string[][] {
  const files: string[][] = [];
  const pending: string[][] = [[]];
  while (pending.length > 0 && files.length < MAX_PUBLIC_FILES) {
    const prefix = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(join(publicDir, ...prefix), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push([...prefix, entry.name]);
      else if (entry.isFile()) files.push([...prefix, entry.name]);
      if (files.length >= MAX_PUBLIC_FILES) break;
    }
  }
  return files;
}
