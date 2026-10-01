/**
 * Every npm script in the repo that runs the built `jsails` CLI by path runs
 * one of the files core's `bin` field declares. `dist/src/cli/index.js` is a
 * module with no main-module guard: `node .../cli/index.js build` loads it and
 * exits 0 having done nothing, so a script that names it passes while its
 * command never runs (the docs site's build would index stale output).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { readManifest, repoRoot, workspaceDirs } from '../workspaces.mjs';

/** Core's executables, as paths under its package root. */
const BIN_FILES = new Set(
  Object.values(readManifest(join(repoRoot, 'core')).bin).map((file) => file.replace(/^\.\//, '')),
);

/** The repo root, every workspace and the docs site, which is not a workspace. */
const PACKAGE_DIRS = [repoRoot, ...workspaceDirs(), join(repoRoot, 'website')];

/** The CLI files `script` runs by path (`dist/src/cli/<file>` of jsails or core). */
function cliFilesRun(script) {
  return [...script.matchAll(/(?:\bjsails|\bcore)\/(dist\/src\/cli\/[\w.-]+)/g)].map(
    (match) => match[1],
  );
}

describe('npm scripts that run the jsails CLI by path', () => {
  it('finds the files a script runs', () => {
    assert.deepEqual(
      cliFilesRun('vite build && node node_modules/jsails/dist/src/cli/index.js build'),
      ['dist/src/cli/index.js'],
    );
    assert.deepEqual(cliFilesRun('node core/dist/src/cli/bin.cjs jamal up'), [
      'dist/src/cli/bin.cjs',
    ]);
    assert.deepEqual(cliFilesRun('jsails build'), []);
  });

  it('run a file core declares as a bin', () => {
    assert.ok(BIN_FILES.has('dist/src/cli/bin.cjs'), 'core declares the jsails bin');
    const offenders = [];
    let checked = 0;
    for (const dir of PACKAGE_DIRS) {
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const { scripts = {} } = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const [name, script] of Object.entries(scripts)) {
        for (const file of cliFilesRun(script)) {
          checked += 1;
          if (!BIN_FILES.has(file)) offenders.push(`${manifestPath} "${name}": ${file}`);
        }
      }
    }
    assert.ok(checked > 0, 'some script runs the CLI by path');
    assert.deepEqual(offenders, []);
  });
});
