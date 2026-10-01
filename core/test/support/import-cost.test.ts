/**
 * Tests for the support barrel's import cost: it must load date-fns and
 * es-toolkit through per-function or per-category subpaths, never through the
 * root barrels that cost about a second on every CLI command and boot.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const supportBarrel = fileURLToPath(new URL('../../src/support/index.js', import.meta.url));
const compareLeaf = fileURLToPath(new URL('../../src/support/compare-strings.js', import.meta.url));

/** Import `entry` in a fresh process and return every module URL it loaded. */
function loadedModules(entry: string): string[] {
  const script = `
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const seen = [];
    registerHooks({
      load(url, context, nextLoad) {
        seen.push(url);
        return nextLoad(url, context);
      },
    });
    await import(pathToFileURL(process.argv[1]).href);
    process.stdout.write(JSON.stringify(seen));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, entry], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as string[];
}

describe('support import cost', () => {
  it('never loads the date-fns or es-toolkit root barrels', () => {
    const urls = loadedModules(supportBarrel);
    assert.ok(urls.some((url) => url.includes('/date-fns/')));
    assert.equal(
      urls.some((url) => /\/date-fns\/index\.js$/.test(url)),
      false,
    );
    assert.equal(
      urls.some((url) => /\/es-toolkit\/dist\/(?:compat\/)?index\.mjs$/.test(url)),
      false,
    );
    const dateFnsModules = urls.filter((url) => url.includes('/date-fns/')).length;
    assert.ok(dateFnsModules < 150, `date-fns modules loaded: ${dateFnsModules}`);
  });

  it('keeps compareStrings a dependency-free leaf', () => {
    const urls = loadedModules(compareLeaf).filter((url) => url.includes('/node_modules/'));
    assert.deepEqual(urls, []);
  });
});
