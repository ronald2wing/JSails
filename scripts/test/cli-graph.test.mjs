/**
 * Tests for the `cli-graph` gate (`scripts/gates/cli-graph.mjs`) and the CLI
 * signature snapshot (`scripts/cli-signature.mjs`) over throwaway trees: the
 * walk follows static imports and re-exports, never `import()`, and names
 * the edge that reaches a forbidden package or the app config schema; a
 * snapshot section is the text between its heading's fence. The gates run
 * against the real repository through `npm run gates -- cli-graph
 * cli-signature`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { loadParser } from '../api-report.mjs';
import { sectionOf } from '../cli-signature.mjs';
import { scanCliGraph } from '../gates/cli-graph.mjs';
import { repoRoot } from '../workspaces.mjs';

const root = mkdtempSync(join(tmpdir(), 'jsails-cli-graph-'));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

/** A `dist/src` tree of `files` (path to text) under a fresh directory. */
function tree(files) {
  const dir = join(root, `case-${seq++}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const BIN = "'use strict';\nimport('./index.js').then((cli) => cli.main([]));\n";

describe('scanCliGraph', () => {
  it('follows static imports and re-exports, not import()', async () => {
    const parseSync = await loadParser(repoRoot);
    const dir = tree({
      'cli/bin.cjs': BIN,
      'cli/index.js': "export * from './dispatch.js';\n",
      'cli/dispatch.js':
        "import { z } from 'zod';\nexport const load = () => import('hono');\nexport { h } from 'preact';\n",
      'cli/manifest.js': "export const load = () => import('../app/config/schema.js');\n",
      'app/config/schema.js': "import 'typeorm';\n",
    });
    assert.deepEqual(scanCliGraph(parseSync, dir), [
      'cli/dispatch.js -> zod',
      'cli/dispatch.js -> preact',
    ]);
  });

  it('names a static edge to the app config schema', async () => {
    const parseSync = await loadParser(repoRoot);
    const dir = tree({
      'cli/bin.cjs': BIN,
      'cli/index.js': "import '../app/config/schema.js';\n",
      'cli/manifest.js': 'export const BUILTIN_COMMANDS = [];\n',
      'app/config/schema.js': 'export {};\n',
    });
    assert.deepEqual(scanCliGraph(parseSync, dir), ['cli/index.js -> app/config/schema.js']);
  });

  it('reports a missing entry instead of passing', async () => {
    const parseSync = await loadParser(repoRoot);
    const dir = tree({ 'cli/index.js': 'export {};\n' });
    assert.deepEqual(scanCliGraph(parseSync, dir), [
      'cli/bin.cjs is missing; build core first',
      'cli/manifest.js is missing; build core first',
    ]);
  });
});

describe('sectionOf', () => {
  const snapshot =
    '# head\n\n## a\n\n```text\nhelp of a\n```\n\n## a:b\n\n```text\nhelp of a:b\n```\n';

  it('returns the fenced help under a heading, matched exactly', () => {
    assert.equal(sectionOf(snapshot, 'a'), 'help of a\n');
    assert.equal(sectionOf(snapshot, 'a:b'), 'help of a:b\n');
    assert.equal(sectionOf(snapshot, 'b'), undefined);
  });
});
