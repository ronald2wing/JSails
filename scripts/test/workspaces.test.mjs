/**
 * Tests for `scripts/workspaces.mjs` discovery: which directories the root
 * `workspaces` globs name. A removed package whose ignored build output
 * survives in a checkout that built it is not a workspace, as it is not one
 * to npm, so every script that discovers workspaces keeps working there.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { readWorkspaces, workspaceDirs } from '../workspaces.mjs';

const root = mkdtempSync(join(tmpdir(), 'jsails-workspaces-'));
after(() => rmSync(root, { recursive: true, force: true }));

function writeManifest(dir, manifest) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest)}\n`);
}

writeManifest(root, { private: true, workspaces: ['core', 'packages/*'] });
writeManifest(join(root, 'core'), { name: 'jsails' });
writeManifest(join(root, 'packages', 'auth'), { name: '@jsails/auth' });
// A package removed from the tree, with the ignored build output git leaves.
mkdirSync(join(root, 'packages', 'removed', 'dist', 'src'), { recursive: true });
writeFileSync(join(root, 'packages', 'stray-file'), '');

describe('workspaceDirs', () => {
  it('names each listed directory and each glob match that holds a package.json', () => {
    assert.deepEqual(workspaceDirs(root), [join(root, 'core'), join(root, 'packages', 'auth')]);
  });
});

describe('readWorkspaces', () => {
  it('reads every workspace manifest and skips a leftover without one', () => {
    const workspaces = readWorkspaces(root);
    assert.deepEqual([...workspaces.keys()], ['jsails', '@jsails/auth']);
    assert.equal(workspaces.get('@jsails/auth').dir, join(root, 'packages', 'auth'));
  });
});
