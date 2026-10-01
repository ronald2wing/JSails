/**
 * Fixture material for the trust and catalog tests: Ed25519 keys derived from
 * fixed seeds (so signatures are reproducible), signing through the package's
 * own signing message, bundles built with the tar builder, release statements
 * and envelopes that match them, and the standard publishers `acme` and
 * `stranger`.
 */

import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';

import { publisher, type Publisher } from '../../src/trust/publisher.js';
import { signingMessage, type SignedRecordKind } from '../../src/trust/signature.js';
import { tarGz } from '../archive/tar-builder.js';

/** A fixture key: its id, private key and standard base64 public key. */
export interface FixtureKey {
  readonly id: string;
  readonly privateKey: KeyObject;
  readonly publicKey: string;
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The Ed25519 key whose 32-byte seed is `seed` repeated. */
export function fixtureKey(id: string, seed: number): FixtureKey {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.alloc(32, seed)]);
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  return Object.freeze({
    id,
    privateKey,
    publicKey: Buffer.from(String(jwk.x), 'base64url').toString('base64'),
  });
}

/** One signature entry by `key` over `record` of `kind`. */
export function signature(
  kind: SignedRecordKind,
  record: unknown,
  key: FixtureKey,
): { keyId: string; sig: string } {
  return {
    keyId: key.id,
    sig: sign(null, signingMessage(kind, record), key.privateKey).toString('base64'),
  };
}

export const KEYS = Object.freeze({
  acmeRoot: fixtureKey('acme-root-1', 1),
  acmeRoot2: fixtureKey('acme-root-2', 2),
  acmeRelease: fixtureKey('acme-release-1', 3),
  acmeCatalog: fixtureKey('acme-catalog-1', 4),
  acmeDelegated: fixtureKey('acme-release-2026', 5),
  acmeDelegatedCatalog: fixtureKey('acme-catalog-2026', 6),
  strangerRelease: fixtureKey('stranger-release-1', 7),
  strangerCatalog: fixtureKey('stranger-catalog-1', 8),
  outsider: fixtureKey('outsider-1', 9),
});

/** `acme`: may release `acme-*` and `acme`, up to a moderate ceiling. */
export function acmePublisher(overrides: Partial<Parameters<typeof publisher>[0]> = {}): Publisher {
  return publisher({
    id: 'acme',
    ids: ['acme-*', 'acme'],
    keys: [
      { id: KEYS.acmeRoot.id, publicKey: KEYS.acmeRoot.publicKey, use: ['root'] },
      { id: KEYS.acmeRoot2.id, publicKey: KEYS.acmeRoot2.publicKey, use: ['root'] },
      { id: KEYS.acmeRelease.id, publicKey: KEYS.acmeRelease.publicKey, use: ['release'] },
      { id: KEYS.acmeCatalog.id, publicKey: KEYS.acmeCatalog.publicKey, use: ['catalog'] },
    ],
    ceiling: ['http.routes', 'mail.send', 'net.fetch:*', 'data.own', 'http.transform'],
    ...overrides,
  });
}

/** `stranger`: may release `stranger-*`. */
export function strangerPublisher(): Publisher {
  return publisher({
    id: 'stranger',
    ids: ['stranger-*'],
    keys: [
      { id: KEYS.strangerRelease.id, publicKey: KEYS.strangerRelease.publicKey, use: ['release'] },
      { id: KEYS.strangerCatalog.id, publicKey: KEYS.strangerCatalog.publicKey, use: ['catalog'] },
    ],
    ceiling: ['http.routes'],
  });
}

/** The site ceiling the tests trust under unless they say otherwise. */
export const SITE_CEILING: readonly string[] = Object.freeze([
  'http.routes',
  'mail.send',
  'net.fetch:*',
  'data.own',
]);

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What a fixture bundle is. */
export interface BundleSpec {
  readonly id?: string;
  readonly version?: string;
  readonly publisher?: string;
  readonly permissions?: readonly string[];
  readonly jsailsCompat?: string;
}

/** A built bundle: its bytes and the manifest bytes inside. */
export interface FixtureBundle {
  readonly bytes: Uint8Array;
  readonly manifestText: string;
  readonly spec: Required<BundleSpec>;
}

export function buildBundle(spec: BundleSpec = {}): FixtureBundle {
  const full: Required<BundleSpec> = {
    id: spec.id ?? 'acme-notes',
    version: spec.version ?? '1.2.0',
    publisher: spec.publisher ?? 'acme',
    permissions: spec.permissions ?? ['http.routes'],
    jsailsCompat: spec.jsailsCompat ?? '^1.0.0',
  };
  const manifestText = `${JSON.stringify(
    {
      manifestVersion: 1,
      id: full.id,
      version: full.version,
      name: 'Notes',
      summary: 'A fixture plugin.',
      publisher: full.publisher,
      jsailsCompat: full.jsailsCompat,
      apiTier: 'stable',
      permissions: full.permissions,
      entry: './index.js',
      marketplace: true,
    },
    null,
    2,
  )}\n`;
  const bytes = tarGz([
    { name: 'package/', type: '5' },
    { name: 'package/manifest.json', content: manifestText },
    { name: 'package/index.js', content: 'export default { name: "notes", setup() {} };\n' },
  ]);
  return Object.freeze({ bytes, manifestText, spec: full });
}

export const ISSUED_AT = '2026-11-01T00:00:00.000Z';

/** The statement that exactly describes `bundle`, with `overrides` on top. */
export function statementFor(
  bundle: FixtureBundle,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    v: 1,
    id: bundle.spec.id,
    version: bundle.spec.version,
    digest: sha256(bundle.bytes),
    size: bundle.bytes.byteLength,
    manifestDigest: sha256(bundle.manifestText),
    permissions: [...bundle.spec.permissions].sort(),
    jsailsCompat: bundle.spec.jsailsCompat,
    publisher: bundle.spec.publisher,
    issuedAt: ISSUED_AT,
    ...overrides,
  };
}

/** An envelope over `statement` signed by each of `keys`. */
export function envelopeFor(
  statement: Readonly<Record<string, unknown>>,
  ...keys: readonly FixtureKey[]
): { statement: Readonly<Record<string, unknown>>; signatures: { keyId: string; sig: string }[] } {
  return { statement, signatures: keys.map((key) => signature('release', statement, key)) };
}

/** A delegation of `key` by `roots`, signed as the publisher's root would. */
export function delegationOf(
  key: FixtureKey,
  options: {
    readonly publisher?: string;
    readonly use?: readonly string[];
    readonly notAfter?: string;
    readonly roots?: readonly FixtureKey[];
  } = {},
): { delegation: Record<string, unknown>; signatures: { keyId: string; sig: string }[] } {
  const delegation = {
    v: 1,
    publisher: options.publisher ?? 'acme',
    keyId: key.id,
    publicKey: key.publicKey,
    use: options.use ?? ['release'],
    notAfter: options.notAfter ?? '2027-01-01T00:00:00.000Z',
  };
  return {
    delegation,
    signatures: (options.roots ?? [KEYS.acmeRoot]).map((root) =>
      signature('delegation', delegation, root),
    ),
  };
}
