/**
 * Route pattern tests: a concrete path is rewritten to its parameter pattern
 * so diagnostics entries never carry path-embedded identifiers, while a route
 * the server already reports as a pattern is kept.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { routePatternOf } from '../../src/watchers/route-pattern.js';

function concrete(path: string, params: Record<string, string>) {
  return { route: path, url: new URL(`http://localhost${path}`), params };
}

describe('routePatternOf', () => {
  it('replaces a parameter segment with its name', () => {
    assert.equal(
      routePatternOf(concrete('/reset-password/9f2c1e', { token: '9f2c1e' })),
      '/reset-password/:token',
    );
  });

  it('replaces several parameters and every occurrence of a value', () => {
    assert.equal(
      routePatternOf(concrete('/users/8421/posts/77/by/8421', { id: '8421', post: '77' })),
      '/users/:id/posts/:post/by/:id',
    );
  });

  it('matches percent-encoded segments against decoded parameter values', () => {
    assert.equal(
      routePatternOf(concrete('/users/J%C3%BCrgen', { name: 'Jürgen' })),
      '/users/:name',
    );
  });

  it('replaces a value containing a slash that arrived encoded in one segment', () => {
    assert.equal(routePatternOf(concrete('/reset/ab%2Fcd', { token: 'ab/cd' })), '/reset/:token');
  });

  it('collapses a multi-segment catch-all into one marker', () => {
    assert.equal(
      routePatternOf(concrete('/docs/guides/a/b', { slug: 'guides/a/b' })),
      '/docs/:slug*',
    );
  });

  it('keeps a route the server already reports as a pattern', () => {
    assert.equal(
      routePatternOf({
        route: '/users/:id',
        url: new URL('http://localhost/users/8421'),
        params: { id: '8421' },
      }),
      '/users/:id',
    );
  });

  it('keeps a static path unchanged', () => {
    assert.equal(routePatternOf(concrete('/about', {})), '/about');
  });
});
