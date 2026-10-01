/**
 * Tests for the conformance harness itself: the fixture bundles, envelopes
 * and catalogs (`bundles.ts`) and the legacy driver's observation and attack
 * primitives, so a scenario that passes or fails does so because of the
 * implementation under test, not because the harness cannot see.
 */

import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import { describe, it } from 'node:test';

import { extractTarGz } from '../../../src/plugins/archive.js';
import {
  flattenBundleEntries,
  parseExtractedManifest,
} from '../../../src/plugins/bundle-intake.js';
import {
  buildBundle,
  buildCatalog,
  canonicalJson,
  ENV_PROBE,
  PUBLISHERS,
  sha256,
  type FixturePublisher,
} from './bundles.js';
import { createLegacyDriver } from './legacy-driver.js';

function verifies(publisher: FixturePublisher, payload: unknown, sig: string): boolean {
  return verify(
    null,
    Buffer.from(canonicalJson(payload)),
    publisher.publicKey,
    Buffer.from(sig, 'base64'),
  );
}

describe('conformance fixture bundles', () => {
  it('builds a deterministic archive the current reader opens', () => {
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
    const files = flattenBundleEntries(extractTarGz(bundle.bytes));
    const manifest = parseExtractedManifest(files);
    assert.equal(manifest.id, 'acme-notes');
    assert.equal(manifest.version, '1.2.3');
    assert.deepEqual(manifest.permissions, ['http.routes']);
    assert.ok(files.has('index.mjs'));
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

describe('legacy conformance driver', () => {
  it('sees what a plugin does at boot and what an attacker wrote', async () => {
    const driver = await createLegacyDriver();
    try {
      const bundle = buildBundle({ id: 'acme-notes' });
      await driver.putBundle(bundle);
      const { table, row } = driver.forgeRow({
        id: bundle.id,
        version: bundle.version,
        enabled: true,
      });
      assert.equal(table, 'jsails_plugin_state');
      await driver.sqlWrite(table, row);
      const { rows } = await driver.status();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.['pluginId'], 'acme-notes');

      const report = await driver.boot('managed');
      assert.equal(report.booted, true);
      assert.deepEqual(report.loaded, ['acme-notes@1.0.0']);
      assert.deepEqual(report.imported, ['acme-notes@1.0.0']);
      assert.ok(report.storeCalls > 0, 'a managed boot reads the store');
      assert.deepEqual((await driver.status()).running, ['acme-notes@1.0.0']);

      await driver.sqlWrite(table, { ...row, enabled: false });
      assert.equal((await driver.status()).rows.length, 1, 'a second write updates the row');
      assert.deepEqual((await driver.boot('managed')).loaded, []);
    } finally {
      await driver.close();
    }
  });

  it('reports a failed boot with its value-free codes', async () => {
    const driver = await createLegacyDriver();
    try {
      const ghost = buildBundle({ id: 'acme-ghost' });
      const { table, row } = driver.forgeRow({
        id: ghost.id,
        version: ghost.version,
        enabled: true,
      });
      await driver.sqlWrite(table, row);
      const report = await driver.boot('managed');
      assert.equal(report.booted, false);
      assert.deepEqual(report.issues, ['enabled_plugin_missing']);
      assert.deepEqual((await driver.status()).running, []);
    } finally {
      await driver.close();
    }
  });

  it('calls a throwing activation store in a managed boot, which then fails', async () => {
    const driver = await createLegacyDriver();
    try {
      const report = await driver.boot('managed', { throwingStore: true });
      assert.ok(report.storeCalls >= 1, 'the throwing store reaches the boot');
      assert.equal(report.booted, false);
    } finally {
      await driver.close();
    }
  });

  it('applies the boot env while plugins set up and restores it afterwards', async () => {
    const driver = await createLegacyDriver();
    const outer = process.env[ENV_PROBE];
    process.env[ENV_PROBE] = 'outer';
    try {
      const bundle = buildBundle({ id: 'acme-env', behaviour: 'reports-env' });
      await driver.putBundle(bundle);
      const { table, row } = driver.forgeRow({
        id: bundle.id,
        version: bundle.version,
        enabled: true,
      });
      await driver.sqlWrite(table, row);
      const report = await driver.boot('managed', { env: { [ENV_PROBE]: 'inner' } });
      assert.deepEqual(report.settings[bundle.id], { probe: 'inner' });
      assert.equal(process.env[ENV_PROBE], 'outer', 'the variable is restored');
    } finally {
      if (outer === undefined) delete process.env[ENV_PROBE];
      else process.env[ENV_PROBE] = outer;
      await driver.close();
    }
  });

  it('evaluates bundle code afresh on every boot, from the bytes stored now', async () => {
    const driver = await createLegacyDriver();
    try {
      const bundle = buildBundle({ id: 'acme-notes' });
      const ref = await driver.putBundle(bundle);
      const { table, row } = driver.forgeRow({
        id: bundle.id,
        version: bundle.version,
        enabled: true,
      });
      await driver.sqlWrite(table, row);
      assert.deepEqual((await driver.boot('managed')).imported, [bundle.label]);
      assert.deepEqual((await driver.boot('managed')).imported, [bundle.label], 'a second boot');

      const evil = buildBundle({ id: 'acme-notes', variant: 'evil' });
      await driver.putBundle(evil, { replacing: ref });
      const report = await driver.boot('managed');
      assert.deepEqual(
        report.imported,
        [evil.label],
        'the replaced bytes run, not a cached module',
      );
      assert.deepEqual(report.loaded, [evil.label]);
    } finally {
      await driver.close();
    }
  });

  it('adds nodes with empty storage that share the database', async () => {
    const driver = await createLegacyDriver();
    try {
      const bundle = buildBundle({ id: 'acme-notes' });
      const ref = await driver.putBundle(bundle);
      assert.deepEqual(
        await driver.adminAction(
          { id: 'owner', grants: [], authenticatedMinutesAgo: 0 },
          { kind: 'install', bundle: ref },
        ),
        { ok: true },
      );
      const [node] = await driver.nodes(1);
      assert.ok(node !== undefined);
      const report = await node.boot('locked');
      assert.equal(report.booted, true);
      assert.deepEqual(report.loaded, []);
      assert.equal((await driver.status()).rows.length, 1, 'the install is visible to every node');
    } finally {
      await driver.close();
    }
  });
});
