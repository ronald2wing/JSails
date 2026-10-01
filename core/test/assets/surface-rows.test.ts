/**
 * The asset surface rows `assetRowsOf(app)` hands out: one row per file an
 * assembled app serves, beside the route table.
 *
 * Every fixture is a real file under a temporary directory; nothing listens.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createAssetIndex, type WatchAssetRoot } from '../../src/assets/asset-index.js';
import { preactPageRenderer } from '../../src/pages/page.js';
import { discoverRoutes, type RouteManifest } from '../../src/routing/routes.js';
import { assetRowsOf } from '../../src/assets/surface-rows.js';
import { createApp } from '../../src/server/app.js';

const workspace = mkdtempSync(join(tmpdir(), 'jsails-asset-rows-'));
after(() => rmSync(workspace, { recursive: true, force: true }));

const EMPTY: RouteManifest = { entries: [], byRoute: new Map() };

function caseDir(): string {
  return mkdtempSync(join(workspace, 'case-'));
}

function write(dir: string, relative: string, contents: string): void {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

describe('assetRowsOf', () => {
  it('lists every served file once, by its own path, with its owner', async () => {
    const pub = caseDir();
    const plugin = caseDir();
    write(pub, 'docs/index.html', 'docs');
    write(pub, 'robots.txt', 'User-agent: *\n');
    write(plugin, 'widget.js', 'widget');
    const index = await createAssetIndex({
      roots: [{ dir: pub }, { dir: plugin, prefix: '/acme', owner: 'acme' }],
    });
    const app = await createApp({ manifest: EMPTY, assets: index });

    const rows = assetRowsOf(app);
    assert.deepEqual(rows, [
      { kind: 'asset', pattern: '/acme/widget.js', methods: ['GET', 'HEAD'], owner: 'acme' },
      { kind: 'asset', pattern: '/docs/index.html', methods: ['GET', 'HEAD'], owner: 'app' },
      { kind: 'asset', pattern: '/robots.txt', methods: ['GET', 'HEAD'], owner: 'app' },
    ]);
    assert.ok(Object.isFrozen(rows));
    assert.ok(rows?.every((row) => Object.isFrozen(row) && Object.isFrozen(row.methods)));
  });

  it('is empty for an app without an asset index, and undefined for anything else', async () => {
    const app = await createApp({ manifest: EMPTY });
    assert.deepEqual(assetRowsOf(app), []);
    assert.equal(assetRowsOf({}), undefined);
  });

  it('follows a development index, leaving out a path a route keeps', async () => {
    const base = caseDir();
    write(base, 'pages/about/index.mjs', "export default () => 'about page';\n");
    write(base, 'public/about', 'file');
    write(base, 'public/app.css', 'body{}');
    let fire: (() => void) | undefined;
    const watch: WatchAssetRoot = (_dir, onEvent) => {
      fire = onEvent;
      return { close: () => undefined };
    };
    const index = await createAssetIndex({
      roots: [{ dir: join(base, 'public') }],
      mode: 'watch',
      watch,
    });
    try {
      const app = await createApp({
        manifest: discoverRoutes(base),
        assets: index,
        renderer: preactPageRenderer,
      });
      assert.deepEqual(
        assetRowsOf(app)?.map((row) => row.pattern),
        ['/app.css'],
      );
      write(base, 'public/new.js', 'new');
      unlinkSync(join(base, 'public', 'about'));
      fire?.();
      assert.deepEqual(
        assetRowsOf(app)?.map((row) => row.pattern),
        ['/app.css', '/new.js'],
      );
    } finally {
      index.close();
    }
  });
});
