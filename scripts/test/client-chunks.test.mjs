/**
 * Tests for the client chunk graph check of `verify:starter`
 * (`scripts/verify-starter/client-chunks.mjs`): a chunk that imports the
 * entry back fails, statically or dynamically (a string or a Vite template
 * literal), and the lazy chunks are named.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { checkClientChunks, readClientChunks } from '../verify-starter/client-chunks.mjs';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function build(files) {
  const root = mkdtempSync(join(tmpdir(), 'jsails-client-chunks-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const ENTRY =
  'import{r as e}from"./assets/registry-AbC123xy.js";e();import("./assets/editor-runtime-Zz9_aa11.js");';

describe('readClientChunks', () => {
  it('passes a build whose lazy chunk imports a shared chunk, not the entry', async () => {
    const dir = build({
      'app.js': ENTRY,
      'assets/registry-AbC123xy.js': 'export const r=()=>"from ../app.js";',
      'assets/editor-runtime-Zz9_aa11.js': 'import{r}from"./registry-AbC123xy.js";export{r};',
    });
    assert.deepEqual(await readClientChunks(dir), {
      entryImporters: [],
      lazy: ['assets/editor-runtime-Zz9_aa11.js'],
    });
    assert.equal(
      await checkClientChunks(dir, { lazyNames: ['editor-runtime'] }),
      'no chunk imports app.js; lazy: editor-runtime-Zz9_aa11.js',
    );
  });

  it('fails a chunk that imports the entry back, statically or dynamically', async () => {
    const dir = build({
      'app.js': 'export const r=1;import("./assets/editor-runtime-Zz9_aa11.js");',
      'assets/editor-runtime-Zz9_aa11.js': 'import{r}from"../app.js";export{r};',
      'assets/late-Qq.js': 'import("/assets/app.js?v=1");import("https://cdn.example/app.js");',
    });
    const chunks = await readClientChunks(dir);
    assert.deepEqual(chunks.entryImporters, [
      'assets/editor-runtime-Zz9_aa11.js',
      'assets/late-Qq.js',
    ]);
    await assert.rejects(
      checkClientChunks(dir),
      /chunks import the entry app\.js, which loads a second client: assets\/editor-runtime/,
    );
  });

  it('reads the template-literal dynamic imports Vite writes', async () => {
    const dir = build({
      'app.js':
        'import{r as e}from"./assets/registry-AbC123xy.js";' +
        'const p=()=>e(()=>import(`./assets/editor-runtime-Zz9_aa11.js`),__vite__mapDeps([0,1]));' +
        'const q=(n)=>import(`./assets/${n}.js`);',
      'assets/registry-AbC123xy.js': 'export const r=(f)=>f();',
      'assets/editor-runtime-Zz9_aa11.js': 'export const a=()=>import(`../app.js`);',
    });
    assert.deepEqual(await readClientChunks(dir), {
      entryImporters: ['assets/editor-runtime-Zz9_aa11.js'],
      lazy: ['app.js', 'assets/editor-runtime-Zz9_aa11.js'],
    });
  });

  it('fails when a required chunk is not lazy', async () => {
    const dir = build({
      'app.js': 'import"./assets/editor-runtime-Zz9_aa11.js";',
      'assets/editor-runtime-Zz9_aa11.js': 'export const a=1;',
    });
    await assert.rejects(
      checkClientChunks(dir, { lazyNames: ['editor-runtime'] }),
      /no lazy editor-runtime chunk in the client build \(lazy: none\)/,
    );
  });
});
