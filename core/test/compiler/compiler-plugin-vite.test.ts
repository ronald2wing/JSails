/**
 * End-to-end tests for the component compiler inside a real Vite build: a
 * `.jsails` file imported relatively from a nested directory resolves, its
 * `<style>` reaches the emitted stylesheet, its `<server>` block stays out of
 * the client chunk, and client source maps with sources are refused.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { build, type Rolldown } from 'vite';

import { compilerPlugin } from '../../src/compiler/compiler-plugin.js';

const CARD = [
  '<script>',
  'export const authorize = () => true;',
  '</script>',
  '<template>',
  '<p class="card">hi</p>',
  '</template>',
  '<style>',
  '.card { color: rebeccapurple; }',
  '</style>',
  '<server>',
  "const SECRET = 'server-secret-123';",
  'export async function load() { return SECRET; }',
  '</server>',
].join('\n');

/** A throwaway project: `src/main.ts` imports `./widgets/card.jsails`. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'jsails-vite-sfc-'));
  mkdirSync(join(root, 'src', 'widgets'), { recursive: true });
  writeFileSync(join(root, 'src', 'widgets', 'card.jsails'), CARD);
  writeFileSync(
    join(root, 'src', 'main.ts'),
    "import { card } from './widgets/card.jsails';\nconsole.log(card);\n",
  );
  return root;
}

/** Run a client build of the project, in memory. */
async function clientBuild(
  root: string,
  sourcemap: boolean,
): Promise<readonly (Rolldown.OutputChunk | Rolldown.OutputAsset)[]> {
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [compilerPlugin({ rootDir: root })],
    build: {
      write: false,
      sourcemap,
      minify: false,
      rolldownOptions: {
        input: join(root, 'src', 'main.ts'),
        external: [/^jsails/, /^preact/, /^react/],
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  return outputs.flatMap((output) => ('output' in output ? output.output : []));
}

describe('compilerPlugin in a real Vite build', () => {
  it('bundles a nested .jsails import with its style and without its server code', async () => {
    const root = project();
    try {
      const files = await clientBuild(root, false);
      const js = files
        .filter((file): file is Rolldown.OutputChunk => file.type === 'chunk')
        .map((file) => file.code)
        .join('\n');
      const css = files
        .filter((file): file is Rolldown.OutputAsset => file.type === 'asset')
        .filter((file) => file.fileName.endsWith('.css'))
        .map((file) => String(file.source))
        .join('\n');

      assert.match(js, /defineComponent/);
      assert.match(css, /\.card\s*\{\s*color:\s*rebeccapurple/);
      assert.doesNotMatch(js, /server-secret-123/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a client build that would publish the <server> block in a source map', async () => {
    const root = project();
    try {
      await assert.rejects(() => clientBuild(root, true), /server> block/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
