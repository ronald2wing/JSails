/**
 * Tests for the `legacy-config` gate (`scripts/gates/legacy-config.mjs`):
 * reading the compat mapper's surface table, and ratcheting it against the
 * ledger in a scratch repository. The gate run against the real repository
 * is `npm run gates -- legacy-config`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { legacySurfaces, MAPPER, run } from '../gates/legacy-config.mjs';

const TABLE = `export const LEGACY_CONFIG_ROOT = 'jsails.app.js';
const LEGACY_USE_SURFACE = 'plugins.use specifiers';
export const LEGACY_CONFIG_SURFACES: readonly LegacyConfigSurface[] = Object.freeze([
  { key: LEGACY_CONFIG_ROOT, replacement: 'jsails.config.ts' },
  { key: 'pages', replacement: 'routes' },
  { key: LEGACY_USE_SURFACE, replacement: 'instances' },
]);
`;

const scratch = mkdtempSync(join(tmpdir(), 'legacy-config-gate-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;

/** A scratch repository holding the mapper source and a ledger of `ids`. */
function repo(source, ids) {
  const root = join(scratch, `repo-${sequence++}`);
  mkdirSync(join(root, 'core/src/app/config'), { recursive: true });
  mkdirSync(join(root, 'scripts/expected-failures'), { recursive: true });
  mkdirSync(join(root, 'scripts/gates'), { recursive: true });
  writeFileSync(join(root, 'scripts/gates/legacy-config.mjs'), '');
  writeFileSync(join(root, MAPPER), source);
  writeFileSync(
    join(root, 'scripts/expected-failures/legacy-config.json'),
    JSON.stringify({
      description: 'test',
      kind: 'gate',
      gate: 'legacy-config',
      entries: ids.map((id) => ({ id, reason: 'test', fixedBy: 'KRN-11b' })),
    }),
  );
  return root;
}

describe('legacySurfaces', () => {
  it('reads literal keys and module constants, in table order', () => {
    assert.deepEqual(legacySurfaces(TABLE), ['jsails.app.js', 'pages', 'plugins.use specifiers']);
  });

  it('reports a source without the table', () => {
    assert.equal(legacySurfaces('export const nothing = 1;\n'), undefined);
  });
});

describe('the legacy-config gate', () => {
  const ids = ['jsails.app.js', 'pages', 'plugins.use specifiers'];

  it('passes when the table and the ledger agree', () => {
    assert.deepEqual(run({ repoRoot: repo(TABLE, ids) }), []);
  });

  it('fails on a new legacy surface without a ledger entry', () => {
    const grown = TABLE.replace(
      "  { key: 'pages',",
      "  { key: 'api', replacement: 'x' },\n  { key: 'pages',",
    );
    const failures = run({ repoRoot: repo(grown, ids) });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^api is a new legacy config surface/);
  });

  it('fails on a ledger entry whose surface was removed, so the ledger shrinks', () => {
    const failures = run({ repoRoot: repo(TABLE, [...ids, 'seo']) });
    assert.deepEqual(failures, [
      'fixed: seo is no longer a legacy config surface; remove it from legacy-config.json',
    ]);
  });

  it('fails on a duplicate or unresolved surface', () => {
    const broken = TABLE.replace("{ key: 'pages',", '{ key: MISSING_NAME,');
    const failures = run({ repoRoot: repo(broken, ids) });
    assert.ok(
      failures.some((failure) => /<unresolved MISSING_NAME> is not a string/.test(failure)),
    );
  });
});
