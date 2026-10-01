/**
 * The TSX twin (sfc-plan §3.4, docs/design/sfc.md §10): the corpus app
 * compiled from `.jsails` and the same app hand-written in TSX
 * (`fixtures/twin/`, compiled by the repository build) are served side by
 * side through `createTestApp`, and every URL answers both with the same
 * status, the same content type and byte-equal bodies: a static page, a
 * dynamic page with each of its static paths and a path it refuses, the
 * layout, the page whose `load` throws (the error boundary), and an
 * unmatched URL (the not-found page). The URLs cover every route of both
 * manifests, so a page added to one app and not the other fails here.
 * The twin writes by hand the scope marker the compiler puts on each
 * outermost element (`data-s`, `style.ts`), with each component's id.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverRoutes } from '../../../src/routing/routes.js';
import { createTestApp } from '../../../src/testing/app.js';
import type { TestApplication } from '../../../src/testing/index.js';
import { compileFixtureApp, type CompiledFixtureApp } from './compiled-fixture.js';
import { CORPUS_APP, CORPUS_RESOLVER } from './corpus.js';

const TWIN_ROOT = fileURLToPath(new URL('fixtures/twin/', import.meta.url));

/** Each URL, the route pattern it exercises, and the status both apps answer. */
const URLS: readonly (readonly [url: string, route: string, status: number])[] = [
  ['/', '/', 200],
  ['/posts', '/posts', 200],
  ['/broken', '/broken', 500],
  ['/blog/hello', '/blog/:slug', 200],
  ['/blog/again', '/blog/:slug', 200],
  ['/blog/missing', '/blog/:slug', 200],
  ['/no-such-page', '*', 404],
];

/** A browser navigation, so a failure is answered with the app's HTML page. */
const NAVIGATION: RequestInit = { headers: { accept: 'text/html' } };

let fixture: CompiledFixtureApp | undefined;
let compiled: TestApplication | undefined;
let twin: TestApplication | undefined;

before(async () => {
  fixture = compileFixtureApp(CORPUS_APP, { resolver: CORPUS_RESOLVER });
  compiled = await createTestApp({ config: { rootDir: fixture.root, port: 0 } });
  twin = await createTestApp({ config: { rootDir: TWIN_ROOT, port: 0 } });
});

after(async () => {
  await compiled?.close();
  await twin?.close();
  fixture?.dispose();
});

/** The page routes of a compiled app, as sorted patterns. */
function pageRoutes(root: string): string[] {
  return discoverRoutes(root)
    .entries.filter((entry) => entry.kind === 'page')
    .map((entry) => entry.route)
    .sort();
}

describe('the compiled corpus and its TSX twin', () => {
  it('declare the same pages, and the URLs below reach every one', () => {
    assert.ok(fixture !== undefined);
    const routes = pageRoutes(fixture.root);
    assert.deepEqual(routes, pageRoutes(TWIN_ROOT));
    const covered = new Set(URLS.map(([, route]) => route));
    for (const route of routes) assert.ok(covered.has(route), `no URL reaches ${route}`);
    assert.ok(covered.has('*'), 'an unmatched URL reaches the not-found page');
  });

  for (const [url, , status] of URLS) {
    it(`answer ${url} identically`, async () => {
      assert.ok(compiled !== undefined && twin !== undefined);
      const [left, right] = await Promise.all([
        compiled.request(url, NAVIGATION),
        twin.request(url, NAVIGATION),
      ]);
      const [leftBody, rightBody] = await Promise.all([left.text(), right.text()]);
      assert.equal(left.status, status);
      assert.equal(right.status, status);
      assert.equal(left.headers.get('content-type'), right.headers.get('content-type'));
      assert.equal(leftBody, rightBody);
      assert.match(leftBody, /^<!DOCTYPE html>/i);
    });
  }
});
