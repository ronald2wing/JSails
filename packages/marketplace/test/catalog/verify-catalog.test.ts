import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { catalog, verifyCatalog, type CatalogSource } from '../../src/catalog/index.js';
import {
  createTrust,
  MarketplaceConfigErrors,
  verifyRelease,
  verifyStatement,
  type Trust,
} from '../../src/trust/index.js';
import {
  acmePublisher,
  buildBundle,
  delegationOf,
  envelopeFor,
  KEYS,
  sha256,
  signature,
  SITE_CEILING,
  statementFor,
  strangerPublisher,
  type FixtureKey,
} from '../trust/trust-fixtures.js';

const BUNDLE = buildBundle();
const ENVELOPE = envelopeFor(statementFor(BUNDLE), KEYS.acmeRelease);
const NOW = new Date('2026-11-15T00:00:00.000Z');

function baseTrust(): Trust {
  return createTrust({ publishers: [acmePublisher(), strangerPublisher()], ceiling: SITE_CEILING });
}

function catalogRecord(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    v: 1,
    publisher: 'acme',
    sequence: 7,
    issuedAt: '2026-11-10T00:00:00.000Z',
    expiresAt: '2026-11-20T00:00:00.000Z',
    delegations: [],
    revoked: { keys: [], releases: [] },
    plugins: [
      {
        id: 'acme-notes',
        name: 'Notes',
        summary: 'Notes for the admin.',
        category: 'content',
        releases: [
          {
            version: '1.2.0',
            urls: ['https://cdn.acme.example/acme-notes-1.2.0.tgz'],
            changelog: 'First release.',
            envelope: ENVELOPE,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function signed(record: Readonly<Record<string, unknown>>, ...keys: readonly FixtureKey[]): string {
  const signers = keys.length === 0 ? [KEYS.acmeCatalog] : keys;
  return JSON.stringify({
    catalog: record,
    signatures: signers.map((key) => signature('catalog', record, key)),
  });
}

function code(verdict: { readonly ok: boolean; readonly code?: string }): string {
  return verdict.ok ? 'ok' : String(verdict.code);
}

describe('verifyCatalog', () => {
  it('verifies a catalog signed by a configured catalog key, from text or bytes', () => {
    const text = signed(catalogRecord());
    for (const raw of [text, new TextEncoder().encode(text)]) {
      const verdict = verifyCatalog(raw, baseTrust(), {
        now: NOW,
        accepted: { sequence: 7, keyId: KEYS.acmeCatalog.id },
      });
      assert.ok(verdict.ok);
      assert.equal(verdict.catalog.sequence, 7);
      assert.equal(verdict.catalog.stale, false);
      assert.equal(verdict.catalog.keyId, KEYS.acmeCatalog.id);
      assert.equal(
        verdict.catalog.catalog.plugins[0]?.releases[0]?.envelope.statement.digest,
        sha256(BUNDLE.bytes),
      );
      assert.ok(Object.isFrozen(verdict.catalog));
    }
  });

  it('keeps an expired catalog verifiable but marks it stale', () => {
    const verdict = verifyCatalog(signed(catalogRecord()), baseTrust(), {
      now: new Date('2026-11-20T00:00:00.001Z'),
    });
    assert.ok(verdict.ok);
    assert.equal(verdict.catalog.stale, true);
    const atExpiry = verifyCatalog(signed(catalogRecord()), baseTrust(), {
      now: new Date('2026-11-20T00:00:00.000Z'),
    });
    assert.ok(atExpiry.ok && !atExpiry.catalog.stale);
  });

  it('keeps a yanked release and its envelope', () => {
    const record = catalogRecord();
    const plugin = (record.plugins as Record<string, unknown>[])[0]!;
    plugin.releases = [{ ...(plugin.releases as Record<string, unknown>[])[0], yanked: true }];
    const verdict = verifyCatalog(signed(record), baseTrust(), { now: NOW });
    assert.ok(verdict.ok);
    assert.equal(verdict.catalog.catalog.plugins[0]?.releases[0]?.yanked, true);
  });

  describe('refusals, one per code', () => {
    const delegatedRecord = (signedDelegation: unknown) =>
      catalogRecord({ delegations: [signedDelegation] });
    const table: readonly (readonly [string, () => { ok: boolean; code?: string }])[] = [
      ['invalid_catalog', () => verifyCatalog('{', baseTrust())],
      ['invalid_catalog', () => verifyCatalog(new Uint8Array([0x7b, 0xff]), baseTrust())],
      ['invalid_catalog', () => verifyCatalog(signed(catalogRecord({ extra: 1 })), baseTrust())],
      [
        'unknown_publisher',
        () =>
          verifyCatalog(signed(catalogRecord({ publisher: 'nobody', plugins: [] })), baseTrust()),
      ],
      ['unknown_key', () => verifyCatalog(signed(catalogRecord(), KEYS.outsider), baseTrust())],
      ['key_use', () => verifyCatalog(signed(catalogRecord(), KEYS.acmeRelease), baseTrust())],
      [
        'key_revoked',
        () =>
          verifyCatalog(
            signed(catalogRecord()),
            createTrust({
              publishers: [acmePublisher()],
              ceiling: SITE_CEILING,
              revoked: { keys: [{ publisher: 'acme', keyId: KEYS.acmeCatalog.id }] },
            }),
          ),
      ],
      [
        'key_revoked',
        // A catalog that revokes the very key that signed it.
        () =>
          verifyCatalog(
            signed(catalogRecord({ revoked: { keys: [KEYS.acmeCatalog.id], releases: [] } })),
            baseTrust(),
          ),
      ],
      [
        'bad_signature',
        () => {
          const text = signed(catalogRecord()).replace('"sequence":7', '"sequence":70');
          return verifyCatalog(text, baseTrust(), {
            accepted: { sequence: 7, keyId: KEYS.acmeCatalog.id },
          });
        },
      ],
      [
        'key_expired',
        () => {
          const delegation = delegationOf(KEYS.acmeDelegatedCatalog, {
            use: ['catalog'],
            notAfter: '2026-11-09T00:00:00.000Z',
          });
          return verifyCatalog(
            signed(delegatedRecord(delegation), KEYS.acmeDelegatedCatalog),
            baseTrust(),
            { now: NOW },
          );
        },
      ],
      [
        'invalid_delegation',
        () => {
          const delegation = delegationOf(KEYS.acmeDelegatedCatalog, { use: ['catalog'] });
          const forged = {
            ...delegation,
            delegation: { ...delegation.delegation, notAfter: '2030-01-01T00:00:00.000Z' },
          };
          return verifyCatalog(signed(delegatedRecord(forged)), baseTrust(), { now: NOW });
        },
      ],
      [
        'invalid_delegation',
        () => {
          const delegation = delegationOf(KEYS.strangerCatalog, {
            publisher: 'stranger',
            use: ['catalog'],
          });
          return verifyCatalog(signed(delegatedRecord(delegation)), baseTrust(), { now: NOW });
        },
      ],
      [
        'id_outside_namespace',
        () => {
          const bundle = buildBundle({ id: 'stranger-notes' });
          const record = catalogRecord();
          const plugin = (record.plugins as Record<string, unknown>[])[0]!;
          record.plugins = [
            {
              ...plugin,
              id: 'stranger-notes',
              releases: [
                {
                  version: '1.2.0',
                  urls: ['https://cdn.acme.example/x.tgz'],
                  changelog: '',
                  envelope: envelopeFor(statementFor(bundle), KEYS.acmeRelease),
                },
              ],
            },
          ];
          return verifyCatalog(signed(record), baseTrust(), { now: NOW });
        },
      ],
      [
        'catalog_rollback',
        () =>
          verifyCatalog(signed(catalogRecord()), baseTrust(), {
            accepted: { sequence: 8, keyId: KEYS.acmeCatalog.id },
            now: NOW,
          }),
      ],
    ];
    for (const [expected, run] of table) {
      it(`refuses with ${expected}`, () => {
        assert.equal(code(run()), expected);
      });
    }
  });

  describe('rollback', () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    const stolen = { sequence: MAX, keyId: KEYS.acmeCatalog.id };
    const releaseEnvelope = envelopeFor(
      statementFor(buildBundle({ version: '1.3.0' }), { issuedAt: '2026-11-12T00:00:00.000Z' }),
      KEYS.acmeRelease,
    );

    it('accepts an equal sequence as a refetch and refuses a lower one', () => {
      const accepted = { sequence: 7, keyId: KEYS.acmeCatalog.id };
      assert.equal(code(verifyCatalog(signed(catalogRecord()), baseTrust(), { accepted })), 'ok');
      assert.equal(
        code(verifyCatalog(signed(catalogRecord({ sequence: 6 })), baseTrust(), { accepted })),
        'catalog_rollback',
      );
    });

    it("returns a refused catalog's revocations, which createTrust applies", () => {
      // A stolen catalog key pushed the accepted sequence to the maximum; the
      // publisher's next catalog revokes the stolen release key.
      const record = catalogRecord({
        sequence: 12,
        revoked: { keys: [KEYS.acmeRelease.id], releases: [sha256(BUNDLE.bytes)] },
      });
      const verdict = verifyCatalog(signed(record), baseTrust(), { accepted: stolen, now: NOW });
      assert.ok(!verdict.ok && verdict.code === 'catalog_rollback');
      assert.deepEqual(verdict.revocations.revoked, record.revoked);
      assert.deepEqual(verdict.revocations.delegations, []);
      assert.ok(Object.isFrozen(verdict) && Object.isFrozen(verdict.revocations));
      assert.equal(code(verifyStatement(releaseEnvelope, baseTrust())), 'ok');
      const trust = createTrust({
        publishers: [acmePublisher(), strangerPublisher()],
        ceiling: SITE_CEILING,
        catalogs: [verdict.revocations],
      });
      assert.equal(code(verifyStatement(releaseEnvelope, trust)), 'key_revoked');
      assert.equal(code(verifyRelease(ENVELOPE, BUNDLE.bytes, trust)), 'release_revoked');
    });

    it("adds no key from a refused catalog's delegations", () => {
      const record = catalogRecord({
        sequence: 3,
        delegations: [delegationOf(KEYS.acmeDelegated)],
      });
      const verdict = verifyCatalog(signed(record), baseTrust(), {
        accepted: { sequence: 7, keyId: KEYS.acmeCatalog.id },
        now: NOW,
      });
      assert.ok(!verdict.ok && verdict.code === 'catalog_rollback');
      const trust = createTrust({
        publishers: [acmePublisher()],
        ceiling: SITE_CEILING,
        catalogs: [verdict.revocations],
      });
      const envelope = envelopeFor(statementFor(BUNDLE), KEYS.acmeDelegated);
      assert.equal(code(verifyRelease(envelope, BUNDLE.bytes, trust)), 'unknown_key');
    });

    it('drops the floor once the catalog revokes the key that set it', () => {
      // The publisher recovers at its usual next sequence, signing with a key
      // it delegated and revoking the stolen catalog key.
      const record = catalogRecord({
        sequence: 12,
        delegations: [delegationOf(KEYS.acmeDelegatedCatalog, { use: ['catalog'] })],
        revoked: { keys: [KEYS.acmeCatalog.id], releases: [] },
      });
      const verdict = verifyCatalog(signed(record, KEYS.acmeDelegatedCatalog), baseTrust(), {
        accepted: stolen,
        now: NOW,
      });
      assert.ok(verdict.ok);
      assert.equal(verdict.catalog.sequence, 12);
      assert.equal(verdict.catalog.keyId, KEYS.acmeDelegatedCatalog.id);
    });

    it("drops the floor once the site's trust revokes the key that set it", () => {
      const trust = createTrust({
        publishers: [acmePublisher()],
        ceiling: SITE_CEILING,
        revoked: { keys: [{ publisher: 'acme', keyId: KEYS.acmeDelegatedCatalog.id }] },
      });
      const accepted = { sequence: MAX, keyId: KEYS.acmeDelegatedCatalog.id };
      assert.equal(code(verifyCatalog(signed(catalogRecord()), trust, { accepted })), 'ok');
      assert.equal(
        code(
          verifyCatalog(signed(catalogRecord()), baseTrust(), {
            accepted: { sequence: MAX, keyId: KEYS.acmeDelegatedCatalog.id },
          }),
        ),
        'catalog_rollback',
      );
    });

    it("keeps the floor when another publisher's revocation names the same key id", () => {
      const trust = createTrust({
        publishers: [acmePublisher(), strangerPublisher()],
        ceiling: SITE_CEILING,
        revoked: { keys: [{ publisher: 'stranger', keyId: KEYS.acmeDelegatedCatalog.id }] },
      });
      const accepted = { sequence: MAX, keyId: KEYS.acmeDelegatedCatalog.id };
      assert.equal(
        code(verifyCatalog(signed(catalogRecord()), trust, { accepted })),
        'catalog_rollback',
      );
    });

    for (const [label, options, field] of [
      ['a non-object', 'soon', 'shape'],
      ['a fractional sequence', { accepted: { sequence: 1.5, keyId: 'k' } }, 'accepted'],
      ['a negative sequence', { accepted: { sequence: -1, keyId: 'k' } }, 'accepted'],
      ['NaN as the sequence', { accepted: { sequence: Number.NaN, keyId: 'k' } }, 'accepted'],
      ['a missing key id', { accepted: { sequence: 1 } }, 'accepted'],
      ['a bare number', { accepted: 7 }, 'accepted'],
      ['an invalid date', { now: new Date(Number.NaN) }, 'now'],
      ['a timestamp string', { now: '2026-11-15T00:00:00.000Z' }, 'now'],
    ] as const) {
      it(`throws invalid_catalog_options for ${label}`, () => {
        assert.throws(
          () =>
            verifyCatalog(
              signed(catalogRecord()),
              baseTrust(),
              options as unknown as Parameters<typeof verifyCatalog>[2],
            ),
          (error: unknown) =>
            MarketplaceConfigErrors.is(error, 'invalid_catalog_options') &&
            error.context.field === field,
        );
      });
    }
  });

  describe('malformed catalogs', () => {
    const plugin = (catalogRecord().plugins as Record<string, unknown>[])[0]!;
    const release = (plugin.releases as Record<string, unknown>[])[0]!;
    const withRelease = (overrides: Readonly<Record<string, unknown>>) =>
      catalogRecord({ plugins: [{ ...plugin, releases: [{ ...release, ...overrides }] }] });
    const withPlugin = (overrides: Readonly<Record<string, unknown>>) =>
      catalogRecord({ plugins: [{ ...plugin, ...overrides }] });
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['version 2', catalogRecord({ v: 2 })],
      ['a negative sequence', catalogRecord({ sequence: -1 })],
      ['an expiry before issue', catalogRecord({ expiresAt: '2026-11-10T00:00:00.000Z' })],
      [
        'a revoked key id that is not one',
        catalogRecord({ revoked: { keys: ['Bad Id'], releases: [] } }),
      ],
      [
        'a repeated revoked digest',
        catalogRecord({ revoked: { keys: [], releases: ['a'.repeat(64), 'a'.repeat(64)] } }),
      ],
      ['a repeated plugin', catalogRecord({ plugins: [plugin, plugin] })],
      ['a repeated release version', withPlugin({ releases: [release, release] })],
      ['an invalid category', withPlugin({ category: 'Content' })],
      ['a multi-line summary', withPlugin({ summary: 'a\nb' })],
      ['no download URL', withRelease({ urls: [] })],
      ['an http URL', withRelease({ urls: ['http://cdn.acme.example/x.tgz'] })],
      ['a URL with credentials', withRelease({ urls: ['https://user:pw@cdn.acme.example/x.tgz'] })],
      ['a repeated URL', withRelease({ urls: ['https://a.example/x', 'https://a.example/x'] })],
      ['a non-boolean yanked', withRelease({ yanked: 'yes' })],
      ['an envelope for another version', withRelease({ version: '1.2.1' })],
      ['an envelope from another publisher', catalogRecord({ publisher: 'stranger' })],
      ['a changelog over 10,000 characters', withRelease({ changelog: 'a'.repeat(10_001) })],
    ];
    for (const [label, record] of cases) {
      it(`refuses ${label} as invalid_catalog`, () => {
        assert.equal(
          code(verifyCatalog(signed(record), baseTrust(), { now: NOW })),
          'invalid_catalog',
        );
      });
    }

    it('refuses a fractional sequence as invalid_catalog', () => {
      // No canonical form exists to sign, so the number is swapped into signed text.
      const text = signed(catalogRecord({ sequence: 1 })).replace(
        '"sequence":1,',
        '"sequence":1.5,',
      );
      assert.ok(text.includes('"sequence":1.5,'));
      assert.equal(code(verifyCatalog(text, baseTrust(), { now: NOW })), 'invalid_catalog');
    });

    it('refuses a catalog over 4 MiB before parsing it', () => {
      assert.equal(
        code(verifyCatalog(' '.repeat(4 * 1024 * 1024 + 1), baseTrust())),
        'invalid_catalog',
      );
    });
  });

  describe('feeding a verified catalog back into trust', () => {
    it('applies a delegated release key the catalog carries', () => {
      const delegation = delegationOf(KEYS.acmeDelegated);
      const verdict = verifyCatalog(
        signed(catalogRecord({ delegations: [delegation] })),
        baseTrust(),
        { now: NOW },
      );
      assert.ok(verdict.ok);
      assert.equal(verdict.catalog.delegations.length, 1);
      const envelope = envelopeFor(statementFor(BUNDLE), KEYS.acmeDelegated);
      assert.equal(code(verifyRelease(envelope, BUNDLE.bytes, baseTrust())), 'unknown_key');
      const trust = createTrust({
        publishers: [acmePublisher(), strangerPublisher()],
        ceiling: SITE_CEILING,
        catalogs: [verdict.catalog],
      });
      const release = verifyRelease(envelope, BUNDLE.bytes, trust);
      assert.ok(release.ok && release.delegated);
    });

    it('verifies a catalog signed by a delegated catalog key it carries', () => {
      const delegation = delegationOf(KEYS.acmeDelegatedCatalog, { use: ['catalog'] });
      const record = catalogRecord({ delegations: [delegation] });
      const verdict = verifyCatalog(signed(record, KEYS.acmeDelegatedCatalog), baseTrust(), {
        now: NOW,
      });
      assert.ok(verdict.ok);
      assert.equal(verdict.catalog.keyId, KEYS.acmeDelegatedCatalog.id);
    });

    it('ignores a delegation signed by a root this site does not know', () => {
      const delegation = delegationOf(KEYS.acmeDelegated, { roots: [KEYS.outsider] });
      const verdict = verifyCatalog(
        signed(catalogRecord({ delegations: [delegation] })),
        baseTrust(),
        { now: NOW },
      );
      assert.ok(verdict.ok);
      assert.equal(verdict.catalog.delegations.length, 0);
    });

    it("applies the catalog's revocations to its own publisher only", () => {
      const strangerBundle = buildBundle({ id: 'stranger-notes', publisher: 'stranger' });
      const strangerEnvelope = envelopeFor(statementFor(strangerBundle), KEYS.strangerRelease);
      const record = catalogRecord({
        revoked: {
          keys: [KEYS.acmeRelease.id, KEYS.strangerRelease.id],
          releases: [sha256(BUNDLE.bytes), sha256(strangerBundle.bytes)],
        },
      });
      const verdict = verifyCatalog(signed(record), baseTrust(), { now: NOW });
      assert.ok(verdict.ok);
      const trust = createTrust({
        publishers: [acmePublisher(), strangerPublisher()],
        ceiling: SITE_CEILING,
        catalogs: [verdict.catalog],
      });
      assert.equal(code(verifyStatement(ENVELOPE, trust)), 'release_revoked');
      const resigned = envelopeFor(
        statementFor(buildBundle({ version: '1.3.0' })),
        KEYS.acmeRelease,
      );
      assert.equal(code(verifyStatement(resigned, trust)), 'key_revoked');
      assert.equal(code(verifyStatement(strangerEnvelope, trust)), 'ok');
    });

    it('refuses a catalog-shaped object that verifyCatalog did not return', () => {
      const verdict = verifyCatalog(signed(catalogRecord()), baseTrust(), { now: NOW });
      assert.ok(verdict.ok);
      assert.throws(
        () =>
          createTrust({
            publishers: [acmePublisher()],
            ceiling: SITE_CEILING,
            catalogs: [{ ...verdict.catalog }],
          }),
        (error: unknown) =>
          MarketplaceConfigErrors.is(error, 'invalid_trust') && error.context.field === 'catalogs',
      );
    });
  });
});

describe('catalog()', () => {
  it('returns a frozen source', () => {
    const source = catalog({ publisher: 'acme', url: 'https://plugins.acme.example/catalog.json' });
    assert.deepEqual(source, {
      publisher: 'acme',
      url: 'https://plugins.acme.example/catalog.json',
    });
    assert.ok(Object.isFrozen(source));
  });

  for (const [label, input, field] of [
    ['a non-object', 'acme', 'shape'],
    ['an extra member', { publisher: 'acme', url: 'https://a.example', extra: 1 }, 'shape'],
    ['an invalid publisher', { publisher: 'Acme', url: 'https://a.example' }, 'publisher'],
    ['an http URL', { publisher: 'acme', url: 'http://a.example' }, 'url'],
    ['a URL with credentials', { publisher: 'acme', url: 'https://token@a.example' }, 'url'],
    ['a relative URL', { publisher: 'acme', url: '/catalog.json' }, 'url'],
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.throws(
        () => catalog(input as unknown as CatalogSource),
        (error: unknown) =>
          MarketplaceConfigErrors.is(error, 'invalid_catalog_source') &&
          error.context.field === field,
      );
    });
  }
});
