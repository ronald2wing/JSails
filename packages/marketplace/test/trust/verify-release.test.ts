import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArchiveErrors } from '../../src/archive/index.js';
import { verifyCatalog } from '../../src/catalog/index.js';
import { tarGz } from '../archive/tar-builder.js';
import {
  createTrust,
  MarketplaceConfigErrors,
  MarketplaceTrustErrors,
  verifyDelegation,
  verifyRelease,
  verifyStatement,
  type TrustInput,
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
  type FixtureBundle,
} from './trust-fixtures.js';

function trustWith(overrides: Partial<TrustInput> = {}) {
  return createTrust({
    publishers: [acmePublisher(), strangerPublisher()],
    ceiling: SITE_CEILING,
    ...overrides,
  });
}

const BUNDLE = buildBundle();
const GOOD = envelopeFor(statementFor(BUNDLE), KEYS.acmeRelease);

function code(verdict: { readonly ok: boolean; readonly code?: string }): string {
  return verdict.ok ? 'ok' : String(verdict.code);
}

describe('verifyRelease', () => {
  it('verifies a release signed by a configured release key and opens its bundle', () => {
    const verdict = verifyRelease(GOOD, BUNDLE.bytes, trustWith());
    assert.ok(verdict.ok);
    assert.equal(verdict.publisher, 'acme');
    assert.equal(verdict.keyId, KEYS.acmeRelease.id);
    assert.equal(verdict.delegated, false);
    assert.equal(verdict.bundle.manifest.id, 'acme-notes');
    assert.equal(verdict.statement.digest, sha256(BUNDLE.bytes));
    assert.ok(Object.isFrozen(verdict));
  });

  it('accepts provenance and any one valid signature among several', () => {
    const statement = statementFor(BUNDLE, {
      provenance: { repo: 'https://github.com/acme/notes', commit: 'a'.repeat(40), run: 'ci/123' },
    });
    const envelope = envelopeFor(statement, KEYS.outsider, KEYS.acmeCatalog, KEYS.acmeRelease);
    assert.equal(code(verifyRelease(envelope, BUNDLE.bytes, trustWith())), 'ok');
  });

  describe('refusals, one per code', () => {
    const otherBundle: FixtureBundle = buildBundle({ version: '1.2.1' });
    const table: readonly (readonly [string, () => { ok: boolean; code?: string }])[] = [
      ['digest_mismatch', () => verifyRelease(GOOD, otherBundle.bytes, trustWith())],
      [
        'digest_mismatch',
        () => verifyRelease(GOOD, new Uint8Array([...BUNDLE.bytes, 0]), trustWith()),
      ],
      [
        'unknown_publisher',
        () => verifyRelease(GOOD, BUNDLE.bytes, trustWith({ publishers: [strangerPublisher()] })),
      ],
      [
        'release_revoked',
        () =>
          verifyRelease(
            GOOD,
            BUNDLE.bytes,
            trustWith({ revoked: { releases: [sha256(BUNDLE.bytes)] } }),
          ),
      ],
      [
        'unknown_key',
        () =>
          verifyRelease(
            envelopeFor(statementFor(BUNDLE), KEYS.outsider),
            BUNDLE.bytes,
            trustWith(),
          ),
      ],
      [
        'unknown_key',
        // A key id the publisher lists, but under another publisher.
        () =>
          verifyRelease(
            envelopeFor(statementFor(BUNDLE), KEYS.strangerRelease),
            BUNDLE.bytes,
            trustWith(),
          ),
      ],
      [
        'key_use',
        () =>
          verifyRelease(
            envelopeFor(statementFor(BUNDLE), KEYS.acmeCatalog),
            BUNDLE.bytes,
            trustWith(),
          ),
      ],
      [
        'key_use',
        () =>
          verifyRelease(
            envelopeFor(statementFor(BUNDLE), KEYS.acmeRoot),
            BUNDLE.bytes,
            trustWith(),
          ),
      ],
      [
        'key_revoked',
        () =>
          verifyRelease(
            GOOD,
            BUNDLE.bytes,
            trustWith({ revoked: { keys: [{ publisher: 'acme', keyId: KEYS.acmeRelease.id }] } }),
          ),
      ],
      [
        'bad_signature',
        () => {
          const tampered = {
            ...GOOD,
            statement: { ...GOOD.statement, issuedAt: '2026-11-02T00:00:00.000Z' },
          };
          return verifyRelease(tampered, BUNDLE.bytes, trustWith());
        },
      ],
      [
        'id_outside_namespace',
        () => {
          const bundle = buildBundle({ id: 'stranger-notes' });
          return verifyRelease(
            envelopeFor(statementFor(bundle), KEYS.acmeRelease),
            bundle.bytes,
            trustWith(),
          );
        },
      ],
      [
        'permission_above_publisher_ceiling',
        () => {
          const bundle = buildBundle({ permissions: ['users.read'] });
          return verifyRelease(
            envelopeFor(statementFor(bundle), KEYS.acmeRelease),
            bundle.bytes,
            trustWith({ ceiling: ['users.read', 'http.routes'] }),
          );
        },
      ],
      [
        'permission_above_site_ceiling',
        () => {
          const bundle = buildBundle({ permissions: ['http.transform'] });
          return verifyRelease(
            envelopeFor(statementFor(bundle), KEYS.acmeRelease),
            bundle.bytes,
            trustWith(),
          );
        },
      ],
      [
        'statement_mismatch',
        () => {
          const statement = statementFor(BUNDLE, { permissions: ['mail.send'] });
          return verifyRelease(envelopeFor(statement, KEYS.acmeRelease), BUNDLE.bytes, trustWith());
        },
      ],
      [
        'statement_mismatch',
        () => {
          const statement = statementFor(BUNDLE, { manifestDigest: 'f'.repeat(64) });
          return verifyRelease(envelopeFor(statement, KEYS.acmeRelease), BUNDLE.bytes, trustWith());
        },
      ],
      [
        'statement_mismatch',
        () => {
          const statement = statementFor(BUNDLE, { jsailsCompat: '^1.1.0' });
          return verifyRelease(envelopeFor(statement, KEYS.acmeRelease), BUNDLE.bytes, trustWith());
        },
      ],
      [
        'invalid_bundle',
        () => {
          const bytes = new TextEncoder().encode('signed, but not an archive');
          const statement = statementFor(BUNDLE, { digest: sha256(bytes), size: bytes.byteLength });
          return verifyRelease(envelopeFor(statement, KEYS.acmeRelease), bytes, trustWith());
        },
      ],
    ];
    for (const [expected, run] of table) {
      it(`refuses with ${expected}`, () => {
        const verdict = run();
        assert.equal(code(verdict), expected);
        assert.ok(
          MarketplaceTrustErrors.codes[expected as keyof typeof MarketplaceTrustErrors.codes],
        );
      });
    }
  });

  it('never opens bytes that no trusted key signed', () => {
    const bytes = tarGz([{ name: 'link', type: '2' }]);
    const statement = statementFor(BUNDLE, { digest: sha256(bytes), size: bytes.byteLength });
    assert.equal(
      code(verifyRelease(envelopeFor(statement, KEYS.outsider), bytes, trustWith())),
      'unknown_key',
    );
  });

  describe('archive limits that are wrong', () => {
    for (const limits of [
      { maxEntries: 5_000 },
      { maxExtractedBytes: 0 },
      { maxCompressedBytes: 1.5 },
    ]) {
      it(`throws invalid_limits for ${JSON.stringify(limits)}, whatever the release`, () => {
        const isInvalidLimits = (error: unknown) => ArchiveErrors.is(error, 'invalid_limits');
        assert.throws(
          () => verifyRelease(GOOD, BUNDLE.bytes, trustWith(), { limits }),
          isInvalidLimits,
        );
        assert.throws(
          () => verifyRelease(GOOD, new Uint8Array(0), trustWith(), { limits }),
          isInvalidLimits,
        );
        assert.throws(
          () => verifyRelease({}, BUNDLE.bytes, trustWith(), { limits }),
          isInvalidLimits,
        );
      });
    }

    it('applies limits that are right to the signed bundle', () => {
      assert.equal(
        code(verifyRelease(GOOD, BUNDLE.bytes, trustWith(), { limits: { maxEntries: 2 } })),
        'invalid_bundle',
      );
    });
  });

  it('reports the furthest stage any signature reached', () => {
    const statement = statementFor(BUNDLE);
    const forged = {
      keyId: KEYS.acmeRelease.id,
      sig: signature('release', { other: true }, KEYS.acmeRelease).sig,
    };
    const envelope = {
      statement,
      signatures: [signature('release', statement, KEYS.outsider), forged],
    };
    assert.equal(code(verifyRelease(envelope, BUNDLE.bytes, trustWith())), 'bad_signature');
    const revoked = trustWith({
      revoked: { keys: [{ publisher: 'acme', keyId: KEYS.acmeRelease.id }] },
    });
    const withUse = envelopeFor(statement, KEYS.acmeCatalog, KEYS.acmeRelease);
    assert.equal(code(verifyRelease(withUse, BUNDLE.bytes, revoked)), 'key_use');
  });

  it('accepts a whole-scope ceiling entry and the publisher ceiling', () => {
    const bundle = buildBundle({ permissions: ['net.fetch:api.example.com', 'mail.send'] });
    assert.equal(
      code(
        verifyRelease(
          envelopeFor(statementFor(bundle), KEYS.acmeRelease),
          bundle.bytes,
          trustWith(),
        ),
      ),
      'ok',
    );
  });

  describe('malformed envelopes', () => {
    const statement = statementFor(BUNDLE);
    // Shape is checked before any signature, so these reuse a signature over another statement.
    const sign = (record: Readonly<Record<string, unknown>>) => ({
      statement: record,
      signatures: GOOD.signatures,
    });
    const cases: readonly (readonly [string, unknown])[] = [
      ['a non-object', 'envelope'],
      ['an extra envelope member', { ...GOOD, extra: 1 }],
      ['no signatures', { statement, signatures: [] }],
      [
        'nine signatures',
        {
          statement,
          signatures: Array.from({ length: 9 }, (_, i) => ({
            ...GOOD.signatures[0],
            keyId: `k${i}`,
          })),
        },
      ],
      [
        'a repeated signature key id',
        { statement, signatures: [GOOD.signatures[0], GOOD.signatures[0]] },
      ],
      [
        'a signature that is not base64',
        { statement, signatures: [{ keyId: 'k', sig: '!'.repeat(88) }] },
      ],
      [
        'non-canonical base64',
        {
          statement,
          signatures: [{ keyId: 'k', sig: `${GOOD.signatures[0]!.sig.slice(0, 85)}B==` }],
        },
      ],
      ['an extra statement member', sign({ ...statement, extra: 1 })],
      ['a missing statement member', sign({ ...statement, issuedAt: undefined })],
      ['version 2', sign({ ...statement, v: 2 })],
      ['an invalid plugin id', sign({ ...statement, id: 'Acme' })],
      ['an invalid version', sign({ ...statement, version: '1.2' })],
      ['an uppercase digest', sign({ ...statement, digest: 'A'.repeat(64) })],
      ['a zero size', sign({ ...statement, size: 0 })],
      ['a size above the archive limit', sign({ ...statement, size: 16 * 1024 * 1024 + 1 })],
      ['a fractional size', sign({ ...statement, size: 1.5 })],
      ['unsorted permissions', sign({ ...statement, permissions: ['mail.send', 'http.routes'] })],
      ['a repeated permission', sign({ ...statement, permissions: ['mail.send', 'mail.send'] })],
      ['an unregistered permission', sign({ ...statement, permissions: ['database.read'] })],
      ['an invalid compat range', sign({ ...statement, jsailsCompat: 'latest' })],
      ['an invalid publisher id', sign({ ...statement, publisher: 'Acme' })],
      [
        'a timestamp without milliseconds',
        sign({ ...statement, issuedAt: '2026-11-01T00:00:00Z' }),
      ],
      ['an impossible date', sign({ ...statement, issuedAt: '2026-02-30T00:00:00.000Z' })],
      [
        'provenance over http',
        sign({
          ...statement,
          provenance: { repo: 'http://x.example', commit: 'a'.repeat(40), run: '1' },
        }),
      ],
      [
        'provenance with a short commit',
        sign({ ...statement, provenance: { repo: 'https://x.example', commit: 'abc', run: '1' } }),
      ],
    ];
    for (const [label, envelope] of cases) {
      it(`refuses ${label} as invalid_envelope`, () => {
        assert.equal(code(verifyRelease(envelope, BUNDLE.bytes, trustWith())), 'invalid_envelope');
        assert.equal(code(verifyStatement(envelope, trustWith())), 'invalid_envelope');
      });
    }
  });

  describe('delegated release keys', () => {
    const delegation = (notAfter = '2027-01-01T00:00:00.000Z', roots = [KEYS.acmeRoot]) =>
      verifyDelegation(delegationOf(KEYS.acmeDelegated, { notAfter, roots }), trustWith());

    it('verifies a release signed by a key a root delegated', () => {
      const verified = delegation();
      assert.ok(verified.ok);
      const trust = trustWith({ delegations: [verified.delegation] });
      const verdict = verifyRelease(
        envelopeFor(statementFor(BUNDLE), KEYS.acmeDelegated),
        BUNDLE.bytes,
        trust,
      );
      assert.ok(verdict.ok);
      assert.equal(verdict.delegated, true);
      assert.equal(verdict.keyId, KEYS.acmeDelegated.id);
    });

    it('refuses a release issued after the delegation expired, and keeps older ones valid', () => {
      const verified = delegation('2026-11-01T00:00:00.000Z');
      assert.ok(verified.ok);
      const trust = trustWith({ delegations: [verified.delegation] });
      const late = statementFor(BUNDLE, { issuedAt: '2026-11-01T00:00:00.001Z' });
      assert.equal(
        code(verifyRelease(envelopeFor(late, KEYS.acmeDelegated), BUNDLE.bytes, trust)),
        'key_expired',
      );
      assert.equal(
        code(
          verifyRelease(envelopeFor(statementFor(BUNDLE), KEYS.acmeDelegated), BUNDLE.bytes, trust),
        ),
        'ok',
      );
    });

    it('drops a delegation once every root that signed it is revoked', () => {
      const one = delegation();
      const both = delegation(undefined, [KEYS.acmeRoot, KEYS.acmeRoot2]);
      assert.ok(one.ok && both.ok);
      assert.equal(both.delegation.roots.length, 2);
      const revoked = { keys: [{ publisher: 'acme', keyId: KEYS.acmeRoot.id }] };
      const envelope = envelopeFor(statementFor(BUNDLE), KEYS.acmeDelegated);
      assert.equal(
        code(
          verifyRelease(
            envelope,
            BUNDLE.bytes,
            trustWith({ revoked, delegations: [one.delegation] }),
          ),
        ),
        'unknown_key',
      );
      assert.equal(
        code(
          verifyRelease(
            envelope,
            BUNDLE.bytes,
            trustWith({ revoked, delegations: [both.delegation] }),
          ),
        ),
        'ok',
      );
    });

    it('drops a delegation whose root key the config no longer lists', () => {
      const verified = delegation();
      assert.ok(verified.ok);
      const rotated = acmePublisher({
        keys: [
          { id: KEYS.acmeRelease.id, publicKey: KEYS.acmeRelease.publicKey, use: ['release'] },
        ],
      });
      const trust = createTrust({
        publishers: [rotated],
        ceiling: SITE_CEILING,
        delegations: [verified.delegation],
      });
      const envelope = envelopeFor(statementFor(BUNDLE), KEYS.acmeDelegated);
      assert.equal(code(verifyRelease(envelope, BUNDLE.bytes, trust)), 'unknown_key');
    });

    it('counts every grant of a key delegated twice, in any order', () => {
      const old = delegation('2026-06-01T00:00:00.000Z');
      const renewed = delegation('2027-06-01T00:00:00.000Z');
      assert.ok(old.ok && renewed.ok);
      const late = statementFor(BUNDLE, { issuedAt: '2026-11-01T00:00:00.000Z' });
      const envelope = envelopeFor(late, KEYS.acmeDelegated);
      for (const delegations of [
        [old.delegation, renewed.delegation],
        [renewed.delegation, old.delegation],
      ]) {
        assert.equal(code(verifyRelease(envelope, BUNDLE.bytes, trustWith({ delegations }))), 'ok');
      }
      const after = envelopeFor(
        statementFor(BUNDLE, { issuedAt: '2027-06-01T00:00:00.001Z' }),
        KEYS.acmeDelegated,
      );
      assert.equal(
        code(
          verifyRelease(
            after,
            BUNDLE.bytes,
            trustWith({ delegations: [renewed.delegation, old.delegation] }),
          ),
        ),
        'key_expired',
      );
    });

    it('counts a grant of another use whichever delegation comes first', () => {
      const asCatalog = verifyDelegation(
        delegationOf(KEYS.acmeDelegated, { use: ['catalog'] }),
        trustWith(),
      );
      const asRelease = delegation();
      assert.ok(asCatalog.ok && asRelease.ok);
      const envelope = envelopeFor(statementFor(BUNDLE), KEYS.acmeDelegated);
      for (const delegations of [
        [asCatalog.delegation, asRelease.delegation],
        [asRelease.delegation, asCatalog.delegation],
      ]) {
        assert.equal(code(verifyRelease(envelope, BUNDLE.bytes, trustWith({ delegations }))), 'ok');
      }
    });

    it('counts a renewal from a later catalog after an older pinned delegation', () => {
      const pinned = delegation('2026-06-01T00:00:00.000Z');
      assert.ok(pinned.ok);
      const record = {
        v: 1,
        publisher: 'acme',
        sequence: 1,
        issuedAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-12-01T00:00:00.000Z',
        delegations: [delegationOf(KEYS.acmeDelegated, { notAfter: '2027-06-01T00:00:00.000Z' })],
        revoked: { keys: [], releases: [] },
        plugins: [],
      };
      const catalogVerdict = verifyCatalog(
        JSON.stringify({
          catalog: record,
          signatures: [signature('catalog', record, KEYS.acmeCatalog)],
        }),
        trustWith(),
        { now: new Date('2026-11-15T00:00:00.000Z') },
      );
      assert.ok(catalogVerdict.ok);
      const late = statementFor(BUNDLE, { issuedAt: '2026-11-01T00:00:00.000Z' });
      const trust = trustWith({
        delegations: [pinned.delegation],
        catalogs: [catalogVerdict.catalog],
      });
      assert.equal(
        code(verifyRelease(envelopeFor(late, KEYS.acmeDelegated), BUNDLE.bytes, trust)),
        'ok',
      );
    });

    it('refuses a delegated key used outside its use', () => {
      const verified = verifyDelegation(
        delegationOf(KEYS.acmeDelegated, { use: ['catalog'] }),
        trustWith(),
      );
      assert.ok(verified.ok);
      const trust = trustWith({ delegations: [verified.delegation] });
      const envelope = envelopeFor(statementFor(BUNDLE), KEYS.acmeDelegated);
      assert.equal(code(verifyRelease(envelope, BUNDLE.bytes, trust)), 'key_use');
    });
  });
});

describe('verifyDelegation', () => {
  const trust = trustWith();

  for (const [expected, signed] of [
    ['invalid_delegation', { ...delegationOf(KEYS.acmeDelegated), extra: 1 }],
    ['invalid_delegation', delegationOf(KEYS.acmeDelegated, { use: ['root'] })],
    ['invalid_delegation', delegationOf(KEYS.acmeDelegated, { use: [] })],
    ['invalid_delegation', delegationOf(KEYS.acmeDelegated, { notAfter: 'tomorrow' })],
    ['unknown_publisher', delegationOf(KEYS.acmeDelegated, { publisher: 'nobody' })],
    ['unknown_key', delegationOf(KEYS.acmeDelegated, { roots: [KEYS.outsider] })],
    ['key_use', delegationOf(KEYS.acmeDelegated, { roots: [KEYS.acmeRelease] })],
    [
      'bad_signature',
      {
        ...delegationOf(KEYS.acmeDelegated),
        delegation: { ...delegationOf(KEYS.acmeDelegated).delegation, keyId: 'acme-other' },
      },
    ],
  ] as const) {
    it(`refuses with ${expected}`, () => {
      assert.equal(code(verifyDelegation(signed, trust)), expected);
    });
  }

  it('refuses a delegation whose key is not a valid public key', () => {
    const signed = delegationOf(KEYS.acmeDelegated);
    const broken = { ...signed, delegation: { ...signed.delegation, publicKey: 'AAAA' } };
    assert.equal(code(verifyDelegation(broken, trust)), 'invalid_delegation');
  });
});

describe('createTrust', () => {
  function invalid(input: unknown, field: string): void {
    assert.throws(
      () => createTrust(input as TrustInput),
      (error: unknown) =>
        MarketplaceConfigErrors.is(error, 'invalid_trust') && error.context.field === field,
    );
  }

  it('refuses inputs no checker produced', () => {
    invalid(null, 'shape');
    invalid({ publishers: [], ceiling: [], extra: 1 }, 'shape');
    invalid({ publishers: [{ ...acmePublisher() }], ceiling: [] }, 'publishers');
    invalid({ publishers: 'acme', ceiling: [] }, 'publishers');
    invalid({ publishers: [], ceiling: ['database.read'] }, 'ceiling');
    invalid(
      {
        publishers: [],
        ceiling: [],
        catalogs: [{ publisher: 'acme', revoked: { keys: [], releases: [] }, delegations: [] }],
      },
      'catalogs',
    );
    invalid({ publishers: [], ceiling: [], catalogs: 'x' }, 'catalogs');
    const verified = verifyDelegation(delegationOf(KEYS.acmeDelegated), trustWith());
    assert.ok(verified.ok);
    invalid(
      { publishers: [], ceiling: [], delegations: [{ ...verified.delegation }] },
      'delegations',
    );
    invalid({ publishers: [], ceiling: [], delegations: 'x' }, 'delegations');
  });

  it('refuses malformed revocations', () => {
    for (const revoked of [
      'x',
      { extra: [] },
      { keys: 'x' },
      { releases: 'x' },
      { keys: [{ publisher: 'acme' }] },
      { keys: [{ publisher: 'acme', keyId: 'Bad Id' }] },
      { keys: [{ publisher: 1, keyId: 'k' }] },
      { releases: ['abc'] },
      { releases: Array.from({ length: 10_001 }, () => 'a'.repeat(64)) },
    ]) {
      invalid({ publishers: [], ceiling: [], revoked }, 'revoked');
    }
  });

  it('refuses two publishers with one id', () => {
    assert.throws(
      () => createTrust({ publishers: [acmePublisher(), acmePublisher()], ceiling: [] }),
      (error: unknown) => MarketplaceConfigErrors.is(error, 'duplicate_publisher'),
    );
  });

  it('refuses a verifier call with a trust set it did not build', () => {
    assert.throws(
      () => verifyStatement(GOOD, { publishers: [], ceiling: [] }),
      (error: unknown) => MarketplaceConfigErrors.is(error, 'invalid_trust'),
    );
  });

  it('exposes its publishers and site ceiling as frozen data', () => {
    const trust = trustWith();
    assert.ok(Object.isFrozen(trust));
    assert.deepEqual(trust.ceiling, SITE_CEILING);
    assert.deepEqual(
      trust.publishers.map((entry) => entry.id),
      ['acme', 'stranger'],
    );
  });
});
