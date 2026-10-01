/** Tests for `findShadowedPublicFiles`: which public files a page or API route answers first. */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  findShadowedPublicFiles,
  groupShadowedPublicFiles,
} from '../../src/app/public-route-shadowing.js';
import type { RouteManifest, RouteManifestEntry } from '../../src/routing/routes.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-public-shadow-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

function publicTree(name: string, files: readonly string[]): string {
  const dir = join(root, name);
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), 'x');
  }
  return dir;
}

function entry(route: string, overrides: Partial<RouteManifestEntry> = {}): RouteManifestEntry {
  return {
    kind: 'page',
    route,
    file: `pages${route}.js`,
    dynamic: route.includes(':') || route.includes('*'),
    catchAll: route.includes('*'),
    params: [],
    ...overrides,
  };
}

function manifest(...entries: RouteManifestEntry[]): RouteManifest {
  return { entries, byRoute: new Map(entries.map((e) => [e.route, e])) };
}

describe('findShadowedPublicFiles', () => {
  it('reports a root dynamic page that answers /favicon.ico', () => {
    const dir = publicTree('root-dynamic', ['favicon.ico', 'assets/app.css']);
    const shadowed = findShadowedPublicFiles(manifest(entry('/:slug')), dir);
    assert.deepEqual(shadowed, [{ path: '/favicon.ico', route: '/:slug', file: 'pages/:slug.js' }]);
  });

  it('reports every file under a catch-all, and the base for an optional one', () => {
    const dir = publicTree('catch-all', ['docs/a.txt', 'docs/b/c.txt', 'other.txt']);
    const required = findShadowedPublicFiles(manifest(entry('/docs/*slug')), dir)
      .map((item) => item.path)
      .sort();
    assert.deepEqual(required, ['/docs/a.txt', '/docs/b/c.txt']);

    const optionalDir = publicTree('optional', ['docs', 'x.txt']);
    const optional = findShadowedPublicFiles(
      manifest(entry('/docs/*slug', { optionalCatchAll: true })),
      optionalDir,
    );
    assert.deepEqual(
      optional.map((item) => item.path),
      ['/docs'],
    );
  });

  it('reports nothing when routes are nested away from the public files', () => {
    const dir = publicTree('nested', ['favicon.ico', 'robots.txt']);
    assert.deepEqual(findShadowedPublicFiles(manifest(entry('/blog/:slug'), entry('/')), dir), []);
  });

  it('skips symlinks and tolerates a missing public directory', () => {
    const dir = publicTree('links', ['real.txt']);
    symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'));
    assert.deepEqual(
      findShadowedPublicFiles(manifest(entry('/:slug')), dir).map((item) => item.path),
      ['/real.txt'],
    );
    assert.deepEqual(findShadowedPublicFiles(manifest(entry('/:slug')), join(root, 'nope')), []);
  });
});

describe('groupShadowedPublicFiles', () => {
  it('folds every file a route shadows into one summary with sorted examples', () => {
    const dir = publicTree('grouped', ['robots.txt', 'favicon.ico', 'a.txt', 'b/c.txt']);
    const groups = groupShadowedPublicFiles(
      findShadowedPublicFiles(manifest(entry('/b/:x'), entry('/*slug')), dir),
      2,
    );
    assert.deepEqual(
      [...groups].sort((a, b) => a.route.localeCompare(b.route)),
      [
        { route: '/*slug', file: 'pages/*slug.js', count: 3, examples: ['/a.txt', '/favicon.ico'] },
        { route: '/b/:x', file: 'pages/b/:x.js', count: 1, examples: ['/b/c.txt'] },
      ],
    );
  });
});
