/**
 * The `jamal.config.ts` every server-rendered starter generates loads through
 * the real loader: Node strips its types, its `@jsails/jamal` import provides
 * `defineJamal` and `secret`, and the schema accepts the result. A template
 * edit the schema rejects, or a construct type stripping cannot erase, fails
 * here rather than in a fresh app's first `jamal up`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createStarterFiles } from 'jsails';

import { loadJamalConfig } from '../src/config/loader.js';
import { SecretRef } from '../src/config/secret-ref.js';

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'jamal-starter-fixture-'),
);
after(() => rmSync(fixturesRoot, { recursive: true, force: true }));

const PACKAGE_IMPORT = "from '@jsails/jamal';";

/** The starter's config text with its package import pointed at this build. */
function againstThisBuild(dir: string, text: string): string {
  const index = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const specifier = relative(dir, index).replaceAll('\\', '/');
  assert.equal(text.split(PACKAGE_IMPORT).length, 2, 'one @jsails/jamal import');
  return text.replace(PACKAGE_IMPORT, `from './${specifier}';`);
}

describe('starter jamal.config.ts', () => {
  for (const preset of ['admin', 'saas', 'blog'] as const) {
    it(`loads the --${preset} config through the jamal loader`, async () => {
      const { files } = await createStarterFiles({ [preset]: true });
      const text = files['jamal.config.ts'];
      assert.equal(typeof text, 'string');
      const dir = join(fixturesRoot, preset);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'jamal.config.ts');
      writeFileSync(path, againstThisBuild(dir, text as string));

      const config = await loadJamalConfig(dir);

      assert.equal(config.service, 'jsails-app');
      assert.equal(config.local.app, 'host');
      assert.deepEqual(Object.keys(config.services).sort(), ['db', 'valkey']);
      assert.ok(config.env['DATABASE_PASSWORD']?.value instanceof SecretRef);
      assert.equal(config.env['JSAILS_TRUSTED_PROXIES']?.value, 'hops=1');
      assert.equal(config.production, undefined);
    });
  }
});
