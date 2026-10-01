/**
 * Tests for the conformance harness itself: the fixture bundles, envelopes
 * and catalogs (`bundles.ts`) and the kernel driver's observation and attack
 * primitives, so a scenario that passes or fails does so because of the
 * implementation under test, not because the harness cannot see.
 *
 * The fixture archives are read back with a minimal ustar listing written
 * here: core has no archive reader (MKT-03's lives in `@jsails/marketplace`,
 * which core cannot import), and the check is about the fixture, not a reader.
 */

import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import { describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';

import {
  buildBundle,
  buildCatalog,
  canonicalJson,
  ENV_PROBE,
  PUBLISHERS,
  sha256,
  type FixturePublisher,
} from './bundles.js';
import { createKernelDriver } from './kernel-driver.js';

/** The regular files of a gzip-compressed ustar archive, by name. */
function listTarGz(bytes: Uint8Array): Map<string, string> {
  const archive = gunzipSync(bytes);
  const files = new Map<string, string>();
  const field = (offset: number, length: number): string =>
    archive.toString('latin1', offset, offset + length).replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= archive.length;) {
    const name = field(offset, 100);
    if (name === '') break;
    const size = Number.parseInt(field(offset + 124, 12), 8);
    const type = field(offset + 156, 1);
    if (type === '0' || type === '') {
      files.set(name, archive.toString('utf8', offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function verifies(publisher: FixturePublisher, payload: unknown, sig: string): boolean {
  return verify(
    null,
    Buffer.from(canonicalJson(payload)),
    publisher.publicKey,
    Buffer.from(sig, 'base64'),
  );
}

describe('conformance fixture bundles', () => {
  it('builds a deterministic archive holding the manifest and the entry module', () => {
    const bundle = buildBundle({
      id: 'acme-notes',
      version: '1.2.3',
      permissions: ['http.routes'],
    });
    assert.deepEqual(
      buildBundle({ id: 'acme-notes', version: '1.2.3', permissions: ['http.routes'] }).bytes,
      bundle.bytes,
    );
    assert.equal(bundle.digest, sha256(bundle.bytes));
    const files = listTarGz(bundle.bytes);
    assert.deepEqual([...files.keys()], ['package/index.mjs', 'package/manifest.json']);
    const manifest = JSON.parse(files.get('package/manifest.json') ?? '') as Record<
      string,
      unknown
    >;
    assert.deepEqual(manifest, bundle.manifest);
    assert.equal(manifest['id'], 'acme-notes');
    assert.equal(manifest['version'], '1.2.3');
    assert.deepEqual(manifest['permissions'], ['http.routes']);
    assert.match(files.get('package/index.mjs') ?? '', /"acme-notes@1\.2\.3"/);
    assert.equal(bundle.label, 'acme-notes@1.2.3');
  });

  it('gives a variant different bytes under the same id and version', () => {
    const plain = buildBundle({ id: 'acme-notes' });
    const evil = buildBundle({ id: 'acme-notes', variant: 'evil' });
    assert.notEqual(plain.digest, evil.digest);
    assert.equal(evil.label, 'acme-notes@1.0.0#evil');
  });

  it('signs a release statement the publisher key verifies, over the archive digest', () => {
    const bundle = buildBundle({ id: 'acme-notes' });
    const envelope = bundle.envelope;
    assert.ok(envelope !== undefined);
    assert.equal(envelope.statement.digest, bundle.digest);
    assert.equal(envelope.statement.publisher, 'acme');
    const signature = envelope.signatures[0];
    assert.ok(signature !== undefined);
    assert.equal(signature.keyId, PUBLISHERS.acme.keyId);
    assert.equal(verifies(PUBLISHERS.acme, envelope.statement, signature.sig), true);
    assert.equal(
      verifies(PUBLISHERS.acme, { ...envelope.statement, version: '9.9.9' }, signature.sig),
      false,
      'a changed statement does not verify',
    );
    assert.equal(verifies(PUBLISHERS.stranger, envelope.statement, signature.sig), false);
  });

  it('leaves an unsigned bundle without an envelope and can sign another id', () => {
    assert.equal(buildBundle({ id: 'acme-notes', signedBy: null }).envelope, undefined);
    const misnamed = buildBundle({ id: 'acme-notes', signedId: 'acme-other' });
    assert.equal(misnamed.envelope?.statement.id, 'acme-other');
  });

  it('serialises canonical JSON with sorted keys at every depth', () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: 'x' } }),
      '{"a":{"c":"x","d":[2,{"e":0,"f":1}]},"b":1}',
    );
  });

  it('signs catalogs with their sequence', () => {
    const catalog = buildCatalog(7, 1);
    assert.equal(catalog.body.sequence, 7);
    assert.ok(Date.parse(catalog.body.expiresAt) > Date.parse(catalog.body.issuedAt));
    const signature = catalog.signatures[0];
    assert.ok(signature !== undefined);
    assert.equal(verifies(PUBLISHERS.acme, catalog.body, signature.sig), true);
  });
});

describe('kernel conformance driver', () => {
  it('records what an attacker wrote, and a boot reads none of it', async () => {
    const driver = await createKernelDriver();
    try {
      const bundle = buildBundle({ id: 'acme-notes' });
      const ref = await driver.putBundle(bundle);
      assert.deepEqual(ref, { id: bundle.id, version: bundle.version, digest: bundle.digest });
      const { table, row } = driver.forgeRow({
        id: bundle.id,
        version: bundle.version,
        enabled: true,
      });
      assert.equal(table, 'jsails_plugin_activation');
      await driver.sqlWrite(table, row);
      await driver.sqlWrite(table, { ...row, enabled: false });
      const { rows } = await driver.status();
      assert.deepEqual(rows, [{ ...row, enabled: false }], 'a second write updates the row');

      for (const mode of ['locked', 'managed'] as const) {
        const report = await driver.boot(mode, { throwingStore: true });
        assert.equal(report.booted, true, report.failure ?? '');
        assert.deepEqual(report.loaded, []);
        assert.deepEqual(report.imported, []);
        assert.equal(report.storeCalls, 0);
      }
    } finally {
      await driver.close();
    }
  });

  it('sees code plugins set up, and what the running primary serves', async () => {
    const driver = await createKernelDriver();
    try {
      const report = await driver.boot('managed', { code: ['acme-notes'] });
      assert.deepEqual(report.loaded, ['acme-notes@code']);
      assert.deepEqual((await driver.status()).running, ['acme-notes@code']);
      const safe = await driver.boot('managed', { code: ['acme-notes'], safeMode: true });
      assert.equal(safe.booted, true, safe.failure ?? '');
    } finally {
      await driver.close();
    }
  });

  it('reports a failed boot with its value-free codes', async () => {
    const driver = await createKernelDriver();
    try {
      const report = await driver.boot('locked', { code: ['acme-twin', 'acme-twin'] });
      assert.equal(report.booted, false);
      assert.ok(report.failure !== undefined);
      assert.deepEqual((await driver.status()).running, []);
    } finally {
      await driver.close();
    }
  });

  it('applies the boot env while the app boots and restores it afterwards', async () => {
    const driver = await createKernelDriver();
    const outer = process.env[ENV_PROBE];
    process.env[ENV_PROBE] = 'outer';
    try {
      await driver.boot('locked', { env: { [ENV_PROBE]: 'inner' } });
      assert.equal(process.env[ENV_PROBE], 'outer', 'the variable is restored');
    } finally {
      if (outer === undefined) delete process.env[ENV_PROBE];
      else process.env[ENV_PROBE] = outer;
      await driver.close();
    }
  });

  it('refuses every admin action as unsupported, and adds nodes that boot', async () => {
    const driver = await createKernelDriver();
    try {
      const ref = await driver.putBundle(buildBundle({ id: 'acme-notes' }));
      assert.deepEqual(
        await driver.adminAction(
          { id: 'owner', grants: [], authenticatedMinutesAgo: 0 },
          { kind: 'install', bundle: ref },
        ),
        { ok: false, code: 'unsupported' },
      );
      const [node] = await driver.nodes(1);
      assert.ok(node !== undefined);
      const report = await node.boot('locked');
      assert.equal(report.booted, true, report.failure ?? '');
      assert.deepEqual(report.loaded, []);
    } finally {
      await driver.close();
    }
  });
});
