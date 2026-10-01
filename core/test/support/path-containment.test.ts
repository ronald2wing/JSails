/** Tests for the path-containment helpers: `relativePathInside`, `isPathInside`, `assertPathInside`, and `resolveDirWithin`. */

import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertPathInside,
  isPathInside,
  relativePathInside,
  resolveDirWithin,
} from '../../src/support/path-containment.server.js';

const root = resolve('/srv/app');

describe('relativePathInside', () => {
  it('returns the relative path for a descendant and an empty string for the parent itself', () => {
    assert.equal(relativePathInside(root, join(root, 'a', 'b')), join('a', 'b'));
    assert.equal(relativePathInside(root, root), '');
  });

  it('accepts a directory whose name merely starts with two dots', () => {
    assert.equal(relativePathInside(root, join(root, '..foo')), '..foo');
  });

  it('rejects traversal and paths on another branch', () => {
    assert.equal(relativePathInside(root, resolve(root, '..')), undefined);
    assert.equal(relativePathInside(root, resolve(root, '..', 'other')), undefined);
    assert.equal(relativePathInside(root, resolve('/srv/application')), undefined);
  });
});

describe('isPathInside and assertPathInside', () => {
  it('agrees with relativePathInside', () => {
    assert.equal(isPathInside(root, join(root, 'x')), true);
    assert.equal(isPathInside(root, root), true);
    assert.equal(isPathInside(root, resolve(root, '..')), false);
  });

  it('throws the caller-built error only when outside', () => {
    assert.doesNotThrow(() => assertPathInside(root, join(root, 'x'), () => new Error('no')));
    assert.throws(
      () => assertPathInside(root, resolve(root, '..'), () => new Error('escaped')),
      /escaped/,
    );
  });
});

describe('resolveDirWithin', () => {
  it('defaults to the working directory and resolves a relative value inside it', () => {
    assert.equal(
      resolveDirWithin(root, undefined, () => new Error('no')),
      root,
    );
    assert.equal(
      resolveDirWithin(root, '', () => new Error('no')),
      root,
    );
    assert.equal(
      resolveDirWithin(root, `sub${sep}dir`, () => new Error('no')),
      join(root, 'sub', 'dir'),
    );
  });

  it('refuses traversal and an absolute path elsewhere with the caller-built error', () => {
    assert.throws(
      () => resolveDirWithin(root, '../elsewhere', () => new Error('escaped')),
      /escaped/,
    );
    assert.throws(
      () => resolveDirWithin(root, resolve('/tmp'), () => new Error('escaped')),
      /escaped/,
    );
  });
});
