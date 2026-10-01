/**
 * Serve/export parity for compiled `.jsails` pages (sfc-plan §3.4): the
 * corpus app compiled by `compileSfc` is exported with `generateStaticSite`
 * and served with `createTestApp`, and every file the export writes is
 * byte-equal to the body the server answers for its URL: each static page,
 * each static path of the dynamic page, and `404.html` against an unmatched
 * URL. Parity holds for every page a static host can serve: the corpus's
 * failing page, which the server answers with its error boundary at 500, is
 * left out of the parity app, and the full corpus fails the export closed
 * with `error_status`, naming the route and carrying the build-time failure,
 * rather than publishing the boundary as a page. A page exporting
 * `serverOnly = true` is served and fails the export closed, naming the
 * route, with nothing written.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { generateStaticSite, StaticSiteError } from '../../../src/pages/static-site/index.js';
import { discoverRoutes } from '../../../src/routing/routes.js';
import { createTestApp } from '../../../src/testing/app.js';
import type { TestApplication } from '../../../src/testing/index.js';
import { compileFixtureApp, type CompiledFixtureApp } from './compiled-fixture.js';
import { CORPUS_APP, CORPUS_RESOLVER } from './corpus.js';

/** The corpus page whose load always fails, so its error boundary answers. */
const FAILING_PAGE = 'pages/broken.jsails';

/** The corpus without its failing page: every page a static host can serve. */
const EXPORTABLE = CORPUS_APP.filter((file) => file.path !== FAILING_PAGE);

/** A browser navigation, so a failure is answered with the app's HTML page. */
const NAVIGATION: RequestInit = { headers: { accept: 'text/html' } };

const scratch = mkdtempSync(join(tmpdir(), 'jsails-sfc-parity-'));

let fixture: CompiledFixtureApp | undefined;
let app: TestApplication | undefined;

before(async () => {
  fixture = compileFixtureApp(EXPORTABLE, { resolver: CORPUS_RESOLVER });
  app = await createTestApp({ config: { rootDir: fixture.root, port: 0 } });
});

after(async () => {
  await app?.close();
  fixture?.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

/** The URL a written export file answers: `404.html` for any unmatched URL. */
function urlOf(file: string): string {
  if (file === '404.html') return '/no-such-page';
  const path = file.replace(/(^|\/)index\.html$/, '');
  return `/${path}`;
}

describe('the exported and the served corpus', () => {
  it('write every page the server answers, byte for byte', async () => {
    assert.ok(fixture !== undefined && app !== undefined);
    const outDir = join(scratch, 'out');
    const result = await generateStaticSite({
      manifest: discoverRoutes(fixture.root),
      outDir,
      root: fixture.root,
    });
    const files = result.written.map((file) => relative(outDir, file).split(sep).join('/'));
    assert.deepEqual(files.toSorted(), [
      '404.html',
      'blog/again/index.html',
      'blog/hello/index.html',
      'index.html',
      'posts/index.html',
    ]);
    assert.deepEqual(result.liveOnly, []);
    for (const file of files) {
      const response = await app.request(urlOf(file), NAVIGATION);
      assert.equal(
        readFileSync(join(outDir, ...file.split('/')), 'utf8'),
        await response.text(),
        file,
      );
    }
  });

  it('serve the failing page through its error boundary and refuse to export it', async () => {
    const full = compileFixtureApp(CORPUS_APP, { resolver: CORPUS_RESOLVER });
    const served = await createTestApp({ config: { rootDir: full.root, port: 0 } });
    try {
      const response = await served.request('/broken', NAVIGATION);
      assert.equal(response.status, 500);
      await response.body?.cancel();
      const outDir = join(scratch, 'full-out');
      await assert.rejects(
        generateStaticSite({ manifest: discoverRoutes(full.root), outDir, root: full.root }),
        (error: unknown) => {
          assert.ok(error instanceof StaticSiteError);
          assert.equal(error.code, 'error_status');
          assert.match(error.message, /page "\/broken" answered with status 500/);
          assert.ok(error.cause instanceof Error);
          assert.equal(error.cause.message, 'the fixture page always fails');
          return true;
        },
      );
      assert.equal(existsSync(join(outDir, 'broken', 'index.html')), false);
    } finally {
      await served.close();
      full.dispose();
    }
  });

  it('serve a serverOnly page and refuse to export it', async () => {
    const live = compileFixtureApp(
      [
        ...EXPORTABLE,
        {
          path: 'pages/live.jsails',
          source:
            '<script lang="ts">\n/** A page only the live server renders. */\nexport const serverOnly = true;\n</script>\n' +
            '<template><p>Live only</p></template>\n',
        },
      ],
      { resolver: CORPUS_RESOLVER },
    );
    const served = await createTestApp({ config: { rootDir: live.root, port: 0 } });
    try {
      const response = await served.request('/live', NAVIGATION);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<p data-s="[0-9a-z]{8}">Live only<\/p>/);
      const outDir = join(scratch, 'live-out');
      await assert.rejects(
        generateStaticSite({ manifest: discoverRoutes(live.root), outDir, root: live.root }),
        /"\/live" is marked SERVER_ONLY/,
      );
      assert.equal(existsSync(join(outDir, 'live', 'index.html')), false);
    } finally {
      await served.close();
      live.dispose();
    }
  });
});
