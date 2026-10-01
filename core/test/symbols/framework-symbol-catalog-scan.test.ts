/** Tests for the browser-safety validator's bare-specifier allowlist in the framework-symbol catalog scan. */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { assertBrowserSafeSubpathsBundleable } from '../../src/symbols/framework-symbol-catalog-scan.js';

const roots: string[] = [];

/**
 * A framework root whose only export is `jsails/support`, with a barrel that
 * imports `specifier`. The other declared browser-safe subpaths are missing, so
 * they are always offenders; the assertions look only at `jsails/support`.
 */
function supportRootImporting(specifier: string): string {
  const root = mkdtempSync(join(tmpdir(), 'jsails-catalog-scan-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ exports: { './support': './dist/src/support/index.js' } }),
  );
  mkdirSync(join(root, 'src', 'support'), { recursive: true });
  writeFileSync(join(root, 'src', 'support', 'index.ts'), `export { helper } from './leaf.js';\n`);
  writeFileSync(
    join(root, 'src', 'support', 'leaf.ts'),
    `import { value } from '${specifier}';\nexport const helper = value;\n`,
  );
  return root;
}

function supportIsBundleable(specifier: string): boolean {
  const offenders = assertBrowserSafeSubpathsBundleable({
    rootDir: supportRootImporting(specifier),
  });
  return !offenders.includes('jsails/support');
}

describe('assertBrowserSafeSubpathsBundleable bare specifiers', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts the allowlisted package roots', () => {
    assert.equal(supportIsBundleable('date-fns'), true);
    assert.equal(supportIsBundleable('es-toolkit'), true);
  });

  it('accepts per-function subpaths of the subpath-safe packages', () => {
    assert.equal(supportIsBundleable('date-fns/addDays'), true);
    assert.equal(supportIsBundleable('es-toolkit/array'), true);
    assert.equal(supportIsBundleable('es-toolkit/compat/get'), true);
  });

  it('rejects packages that only share a name prefix with an allowlisted one', () => {
    assert.equal(supportIsBundleable('date-fns-tz'), false);
    assert.equal(supportIsBundleable('date-fns-tz/format'), false);
    assert.equal(supportIsBundleable('es-toolkit-extra/array'), false);
  });

  it('keeps exact matching for packages not allowlisted by subpath', () => {
    assert.equal(supportIsBundleable('preact/hooks'), true);
    assert.equal(supportIsBundleable('preact/compat'), false);
    assert.equal(supportIsBundleable('zod/v4'), false);
    assert.equal(supportIsBundleable('typeorm'), false);
  });

  it('rejects node builtins', () => {
    assert.equal(supportIsBundleable('node:fs'), false);
  });
});
