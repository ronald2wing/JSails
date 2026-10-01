/**
 * Tests for `scripts/check-licenses.mjs`: workspace LICENSE copies, and the
 * repo-root LICENSE, README.md and CHANGELOG.md, which must be regular files
 * equal to their `core/` originals (never symlinks, so a Windows checkout needs
 * no `core.symlinks`). The repository itself must pass.
 */
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  licenseViolations,
  ROOT_COPIES,
  rootCopyViolations,
  writeRootCopies,
} from '../check-licenses.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'jsails-licenses-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A repo with `core/` originals and, unless `copies` is false, equal root copies. */
function fixture(name, { copies = true } = {}) {
  const root = join(scratch, name);
  mkdirSync(join(root, 'core'), { recursive: true });
  for (const file of ROOT_COPIES) {
    writeFileSync(join(root, 'core', file), `${file} text\n`);
    if (copies) writeFileSync(join(root, file), `${file} text\n`);
  }
  return root;
}

describe('rootCopyViolations', () => {
  it('passes regular files equal to core/', () => {
    assert.deepEqual(rootCopyViolations(fixture('equal')), []);
  });

  it('reports a missing, a differing, and a symlinked root copy', (t) => {
    const root = fixture('broken', { copies: false });
    writeFileSync(join(root, 'README.md'), 'stale\n');
    try {
      symlinkSync(join('core', 'CHANGELOG.md'), join(root, 'CHANGELOG.md'));
    } catch {
      // Creating a symlink needs a privilege Windows may not grant.
      t.skip('symlinks cannot be created here');
      return;
    }
    assert.deepEqual(rootCopyViolations(root), [
      'LICENSE: missing (a copy of core/LICENSE)',
      'README.md: differs from core/README.md (run node scripts/check-licenses.mjs --write)',
      'CHANGELOG.md: must be a regular file equal to core/CHANGELOG.md, not a symlink',
    ]);
  });

  it('writeRootCopies replaces stale files and symlinks with regular copies', (t) => {
    const root = fixture('rewrite', { copies: false });
    writeFileSync(join(root, 'README.md'), 'stale\n');
    try {
      symlinkSync(join('core', 'LICENSE'), join(root, 'LICENSE'));
    } catch {
      t.skip('symlinks cannot be created here');
      return;
    }
    writeRootCopies(root);
    assert.deepEqual(rootCopyViolations(root), []);
    for (const file of ROOT_COPIES) assert.ok(lstatSync(join(root, file)).isFile());
    // The source survived: copying through the old symlink would have emptied it.
    assert.deepEqual(rootCopyViolations(root), []);
  });
});

describe('licenseViolations', () => {
  it('reports a missing and a differing workspace LICENSE', () => {
    const root = fixture('workspaces');
    for (const [dir, text] of [
      ['packages/same', 'LICENSE text\n'],
      ['packages/other', 'other terms\n'],
      ['packages/none', undefined],
    ]) {
      mkdirSync(join(root, dir), { recursive: true });
      if (text !== undefined) writeFileSync(join(root, dir, 'LICENSE'), text);
    }
    const dirs = ['packages/same', 'packages/other', 'packages/none'].map((dir) => join(root, dir));
    assert.deepEqual(licenseViolations(root, dirs), [
      'packages/other/LICENSE: differs from core/LICENSE',
      'packages/none/LICENSE: missing',
    ]);
  });
});

describe('the repository', () => {
  it('ships core/LICENSE everywhere and keeps regular root copies', () => {
    assert.deepEqual(licenseViolations(), []);
    assert.deepEqual(rootCopyViolations(), []);
  });
});
