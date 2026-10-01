/**
 * Tests for digest-pinned image references: the pinned form, the repository
 * of a reference, and picking a repository's digest out of `RepoDigests`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  imageRepository,
  isPinnedImage,
  pinnedRepoDigest,
} from '../../src/production/image-ref.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;

describe('isPinnedImage', () => {
  it('accepts a repository named by its SHA-256 digest, a tag beside it included', () => {
    for (const ref of [
      `ghcr.io/acme/app@${DIGEST}`,
      `varnish@${DIGEST}`,
      `localhost:5000/app@${DIGEST}`,
      `ghcr.io/acme/app:v1@${DIGEST}`,
    ]) {
      assert.ok(isPinnedImage(ref), ref);
    }
  });

  it('refuses a tag, a short or uppercase digest, another algorithm, and malformed names', () => {
    for (const ref of [
      'ghcr.io/acme/app',
      'ghcr.io/acme/app:latest',
      `@${DIGEST}`,
      `app@sha256:${'a'.repeat(63)}`,
      `app@sha256:${'A'.repeat(64)}`,
      `app@sha512:${'a'.repeat(128)}`,
      `has space@${DIGEST}`,
      `app@${DIGEST}@${DIGEST}`,
      `-app@${DIGEST}`,
    ]) {
      assert.equal(isPinnedImage(ref), false, ref);
    }
  });
});

describe('imageRepository', () => {
  it('drops the tag and the digest, never a registry port', () => {
    assert.equal(imageRepository('ghcr.io/acme/app'), 'ghcr.io/acme/app');
    assert.equal(imageRepository('ghcr.io/acme/app:v1'), 'ghcr.io/acme/app');
    assert.equal(imageRepository(`ghcr.io/acme/app@${DIGEST}`), 'ghcr.io/acme/app');
    assert.equal(imageRepository(`ghcr.io/acme/app:v1@${DIGEST}`), 'ghcr.io/acme/app');
    assert.equal(imageRepository('localhost:5000/app'), 'localhost:5000/app');
    assert.equal(imageRepository('localhost:5000/app:v1'), 'localhost:5000/app');
  });
});

describe('pinnedRepoDigest', () => {
  it('picks the one digest the registry holds for the repository', () => {
    assert.equal(
      pinnedRepoDigest([`other/app@${OTHER}`, `ghcr.io/acme/app@${DIGEST}`], 'ghcr.io/acme/app'),
      `ghcr.io/acme/app@${DIGEST}`,
    );
  });

  it('matches every spelling Docker gives an official Docker Hub image', () => {
    for (const entry of [
      `varnish@${DIGEST}`,
      `library/varnish@${DIGEST}`,
      `docker.io/library/varnish@${DIGEST}`,
    ]) {
      assert.equal(pinnedRepoDigest([entry], 'varnish'), `varnish@${DIGEST}`, entry);
    }
    assert.equal(
      pinnedRepoDigest([`docker.io/basecamp/kamal-proxy@${DIGEST}`], 'basecamp/kamal-proxy'),
      `basecamp/kamal-proxy@${DIGEST}`,
    );
  });

  it('gives no answer for no digest, several digests, or another registry of the same path', () => {
    assert.equal(pinnedRepoDigest([], 'ghcr.io/acme/app'), undefined);
    assert.equal(pinnedRepoDigest(['ghcr.io/acme/app:v1'], 'ghcr.io/acme/app'), undefined);
    assert.equal(
      pinnedRepoDigest(
        [`ghcr.io/acme/app@${DIGEST}`, `ghcr.io/acme/app@${OTHER}`],
        'ghcr.io/acme/app',
      ),
      undefined,
    );
    assert.equal(pinnedRepoDigest([`acme/app@${DIGEST}`], 'ghcr.io/acme/app'), undefined);
  });

  it('counts one digest pushed under several spellings once', () => {
    assert.equal(
      pinnedRepoDigest([`varnish@${DIGEST}`, `docker.io/library/varnish@${DIGEST}`], 'varnish'),
      `varnish@${DIGEST}`,
    );
  });
});
