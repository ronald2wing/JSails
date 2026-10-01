/**
 * Build determinism of the `.jsails` compiler (sfc-plan §3.4): the corpus
 * compiled twice, into two different directories, leaves byte-equal trees
 * (modules, maps and sidecars) and collects byte-equal CSS, and no file names the directory it was built
 * in, the working directory, the temporary directory or the home directory,
 * so an app's build output and its `.jsails/sfc` are reproducible and
 * portable between machines and platforms.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { sfcStyleSheet } from '../../../src/compiler/sfc/style-sheet.js';
import { compileFixtureApp } from './compiled-fixture.js';
import { CORPUS_APP, CORPUS_RESOLVER } from './corpus.js';

/** Every file under `dir` with its text, keyed by sorted `/` relative path. */
function snapshot(dir: string, prefix = ''): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      for (const [inner, text] of snapshot(join(dir, entry.name), `${path}/`)) {
        files.set(inner, text);
      }
    } else {
      files.set(path, readFileSync(join(dir, entry.name), 'utf8'));
    }
  }
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

describe('compiling the corpus', () => {
  it('is byte-for-byte reproducible and names no machine path', () => {
    const first = compileFixtureApp(CORPUS_APP, { resolver: CORPUS_RESOLVER });
    const second = compileFixtureApp(CORPUS_APP, { resolver: CORPUS_RESOLVER });
    try {
      assert.notEqual(first.root, second.root);
      const left = snapshot(first.root);
      const right = snapshot(second.root);
      assert.deepEqual([...left.keys()], [...right.keys()]);
      assert.ok([...left.keys()].some((path) => path.startsWith('.jsails/sfc/')));
      assert.ok([...left.keys()].some((path) => path.endsWith('.js.map')));
      const css = sfcStyleSheet(first.lowerings);
      assert.ok(css.blocks.some((block) => block.scoped));
      assert.equal(css.css, sfcStyleSheet(second.lowerings).css);
      const machine = [first.root, process.cwd(), tmpdir(), homedir()];
      for (const [path, text] of left) {
        assert.equal(text, right.get(path), path);
        for (const directory of machine) {
          assert.ok(!text.includes(directory), `${path} names a machine path`);
        }
      }
      for (const directory of machine) {
        assert.ok(!css.css.includes(directory), 'the stylesheet names a machine path');
      }
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});
