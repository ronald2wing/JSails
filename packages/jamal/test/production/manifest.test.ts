/**
 * Tests for the release manifest v1: the strict parse, the byte form, and the
 * config digest a manifest records.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeJamalConfig, secret } from '../../src/config/index.js';
import {
  configDigest,
  encodeManifest,
  ManifestErrors,
  parseManifest,
  type ReleaseManifest,
} from '../../src/production/manifest.js';
import { manifestOf, release } from './host-observation.js';

const CONFIG = normalizeJamalConfig({
  service: 'myapp',
  image: 'ghcr.io/acme/myapp',
  env: { APP_SECRET: secret('APP_SECRET'), LOG_LEVEL: 'info' },
  production: { server: '203.0.113.7', domain: 'example.com' },
});

const MANIFEST: ReleaseManifest = {
  ...manifestOf(CONFIG, 2, 1),
  secretNames: ['APP_SECRET', 'DATABASE_PASSWORD'],
  infra: {
    proxyImage: `basecamp/kamal-proxy@sha256:${'c'.repeat(64)}`,
    cacheProxyImage: `varnish@sha256:${'d'.repeat(64)}`,
  },
};

/** Whether `run` throws the value-free invalid error. */
function refuses(run: () => unknown, label: string): void {
  assert.throws(
    run,
    (error: unknown) =>
      ManifestErrors.is(error, 'invalid') &&
      error.message === 'the release manifest is not a v1 manifest',
    label,
  );
}

describe('encodeManifest and parseManifest', () => {
  it('round-trip a manifest, its optional fields included and absent', () => {
    assert.deepEqual(parseManifest(encodeManifest(MANIFEST)), MANIFEST);
    const first = manifestOf(CONFIG, 1);
    assert.equal('previous' in first, false);
    assert.deepEqual(parseManifest(encodeManifest(first)), first);
  });

  it('write two-space JSON with a trailing newline', () => {
    const text = Buffer.from(encodeManifest(MANIFEST)).toString('utf8');
    assert.ok(text.startsWith('{\n  "v": 1,\n  "releaseId": '));
    assert.ok(text.endsWith('}\n'));
  });

  it('refuse anything but exactly a v1 manifest, value-free', () => {
    const variants: Record<string, unknown> = {
      'a version 2': { ...MANIFEST, v: 2 },
      'an image by tag': { ...MANIFEST, image: 'ghcr.io/acme/myapp:latest' },
      'a release id that is none': { ...MANIFEST, releaseId: 'latest' },
      'a short commit': { ...MANIFEST, git: { sha: 'abcdef1', dirty: false } },
      'unsorted secret names': { ...MANIFEST, secretNames: ['B', 'A'] },
      'a repeated secret name': { ...MANIFEST, secretNames: ['A', 'A'] },
      'a secret name that is no variable': { ...MANIFEST, secretNames: ['A-B'] },
      'a short secrets digest': { ...MANIFEST, secretsSha256: 'abc' },
      'itself as previous': { ...MANIFEST, previous: MANIFEST.releaseId },
      'a previous that is no release id': { ...MANIFEST, previous: 'v1' },
      'an unpinned proxy image': { ...MANIFEST, infra: { proxyImage: 'kamal-proxy:v1' } },
      'an unpinned cache proxy image': {
        ...MANIFEST,
        infra: { proxyImage: null, cacheProxyImage: 'varnish:7.7' },
      },
      'no roles': { ...MANIFEST, roles: {} },
      'a role with no replica': {
        ...MANIFEST,
        roles: { web: { container: 'myapp-web-x', command: [], replicas: 0 } },
      },
      'a status field': { ...MANIFEST, status: 'live' },
      'no author': { ...MANIFEST, by: undefined },
    };
    for (const [label, candidate] of Object.entries(variants)) {
      refuses(() => parseManifest(Buffer.from(JSON.stringify(candidate))), label);
    }
    refuses(() => parseManifest(Buffer.from('{"v":1')), 'truncated JSON');
    refuses(() => encodeManifest({ ...MANIFEST, secretNames: ['B', 'A'] }), 'an encode');
  });

  it('accept a release a dirty tree built, and a deferred release step', () => {
    const dirty: ReleaseManifest = {
      ...MANIFEST,
      git: { sha: 'f'.repeat(40), dirty: true },
      release: { ran: false, exit: null, deferred: true },
      previous: release(1),
    };
    assert.deepEqual(parseManifest(encodeManifest(dirty)), dirty);
  });
});

describe('configDigest', () => {
  it('is stable across key order and changes with any setting', () => {
    const reordered = normalizeJamalConfig({
      production: { domain: 'example.com', server: '203.0.113.7' },
      env: { LOG_LEVEL: 'info', APP_SECRET: secret('APP_SECRET') },
      image: 'ghcr.io/acme/myapp',
      service: 'myapp',
    });
    assert.match(configDigest(CONFIG), /^[0-9a-f]{64}$/);
    assert.equal(configDigest(reordered), configDigest(CONFIG));
    const changed = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp',
      env: { APP_SECRET: secret('APP_SECRET'), LOG_LEVEL: 'debug' },
      production: { server: '203.0.113.7', domain: 'example.com' },
    });
    assert.notEqual(configDigest(changed), configDigest(CONFIG));
  });

  it('digests a secret by its name, which the config holds, never a value', () => {
    const renamed = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp',
      env: { APP_SECRET: secret('OTHER_SECRET'), LOG_LEVEL: 'info' },
      production: { server: '203.0.113.7', domain: 'example.com' },
    });
    assert.notEqual(configDigest(renamed), configDigest(CONFIG));
  });
});
