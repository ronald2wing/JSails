/**
 * Tests for the MCP index source: a present index is used without a scan, an
 * absent index falls back to the scan and says so, and a stale index throws
 * rather than falling back.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CODE_INDEX_FILE, CodeIndexError, emitCodeIndex } from '../../src/build/code-index.js';
import { buildCodeIndex } from '../../src/build/scan-code-index.js';
import {
  buildMetaManifest,
  emitMetaManifest,
  META_MANIFEST_FILE,
} from '../../src/build/meta-manifest.js';
import { fromIndexOrScan, tryReadCodeIndex } from '../../src/mcp/index-source.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-index-source-'));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

function project(files: Readonly<Record<string, string>>): string {
  const dir = join(root, `case-${seq++}`);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(dir, relative);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return dir;
}

async function writeArtifacts(dir: string): Promise<void> {
  mkdirSync(join(dir, '.jsails'), { recursive: true });
  writeFileSync(join(dir, '.jsails', META_MANIFEST_FILE), emitMetaManifest(buildMetaManifest(dir)));
  writeFileSync(join(dir, '.jsails', CODE_INDEX_FILE), emitCodeIndex(await buildCodeIndex(dir)));
}

const ROUTES = { 'pages/index.tsx': 'export default 1', 'api/health.ts': 'export default 1' };

describe('tryReadCodeIndex', () => {
  it('returns undefined when the index is absent', () => {
    assert.equal(tryReadCodeIndex(project(ROUTES)), undefined);
  });

  it('returns the index when it is fresh', async () => {
    const dir = project(ROUTES);
    await writeArtifacts(dir);
    assert.equal(tryReadCodeIndex(dir)?.routes.length, 2);
  });

  it('throws on a stale index rather than returning undefined', async () => {
    const dir = project(ROUTES);
    await writeArtifacts(dir);
    writeFileSync(join(dir, 'pages/index.tsx'), 'export default 2');
    assert.throws(
      () => tryReadCodeIndex(dir),
      (error: unknown) => error instanceof CodeIndexError && error.code === 'stale_index',
    );
  });
});

describe('fromIndexOrScan', () => {
  it('uses the index and never calls the scan when the index exists', async () => {
    const dir = project(ROUTES);
    await writeArtifacts(dir);
    let scanned = false;
    const result = await fromIndexOrScan(
      dir,
      (index) => index.routes.map((route) => route.route),
      () => {
        scanned = true;
        return [];
      },
    );
    assert.equal(result.source, 'index');
    assert.deepEqual(result.data, ['/', '/api/health']);
    assert.equal(scanned, false);
  });

  it('falls back to the scan and reports source scan when the index is absent', async () => {
    const dir = project(ROUTES);
    const result = await fromIndexOrScan(
      dir,
      () => ['from index'],
      () => ['from scan'],
    );
    assert.deepEqual(result, { source: 'scan', data: ['from scan'] });
  });

  it('propagates a stale index instead of falling back', async () => {
    const dir = project(ROUTES);
    await writeArtifacts(dir);
    writeFileSync(join(dir, 'pages/index.tsx'), 'export default 2');
    await assert.rejects(
      () =>
        fromIndexOrScan(
          dir,
          () => [],
          () => [],
        ),
      (error: unknown) => error instanceof CodeIndexError && error.code === 'stale_index',
    );
  });
});
