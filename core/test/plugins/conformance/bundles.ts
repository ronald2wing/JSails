/**
 * Fixture material for the marketplace conformance suite: deterministic
 * plugin bundles, fixture publishers with Ed25519 keys, signed release
 * envelopes and catalogs, and the recorder through which a bundle's code
 * reports that it was evaluated and set up.
 *
 * Envelopes and catalogs follow the shapes MKT-03 specifies
 * (`{ statement, signatures: [{ keyId, sig }] }` over canonical JSON, and a
 * catalog with a `sequence` and an expiry). Today's implementation verifies
 * none of them, which is what the expected failures record; the
 * `@jsails/marketplace` driver verifies them against these keys.
 */

import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/** The global slot a bundle's code reports through. */
export const RECORDER_KEY = Symbol.for('jsails.conformance.recorder');

/**
 * The variable a `reports-env` bundle reads during `setup`, so a harness test
 * can see that a boot's `env` is in force while plugins set up.
 */
export const ENV_PROBE = 'JSAILS_CONFORMANCE_PROBE';

/** What a bundle's code calls while it runs. */
export interface BundleRecorder {
  /** The module body was evaluated. */
  imported(label: string): void;
  /** `setup` completed, having read `settings` from `ctx.settings.current()`. */
  setup(label: string, settings: unknown): void;
}

/** A fixture publisher: an id namespace and one release/catalog key. */
export interface FixturePublisher {
  readonly id: string;
  /** Plugin id patterns the publisher may sign (`acme-*`). */
  readonly ids: readonly string[];
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

function publisher(id: string, ids: readonly string[]): FixturePublisher {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return Object.freeze({
    id,
    ids: Object.freeze([...ids]),
    keyId: `${id}-release-1`,
    publicKey,
    privateKey,
  });
}

/**
 * `acme` is trusted by the default boot config and may sign `acme-*`;
 * `stranger` is never trusted unless a scenario says so.
 */
export const PUBLISHERS: Readonly<Record<'acme' | 'stranger', FixturePublisher>> = Object.freeze({
  acme: publisher('acme', ['acme-*']),
  stranger: publisher('stranger', ['stranger-*']),
});

/** The publisher that signs a bundle, or `null` for an unsigned bundle. */
export type Signer = keyof typeof PUBLISHERS | null;

/** What a fixture bundle is. Every field but `id` has a default. */
export interface BundleSpec {
  readonly id: string;
  /** Defaults to `1.0.0`. */
  readonly version?: string;
  /** Manifest permissions. Defaults to none. */
  readonly permissions?: readonly string[];
  /**
   * `throws-in-setup` makes `setup` throw before it records completion;
   * `reports-env` records `{ probe: process.env[ENV_PROBE] ?? null }` in place
   * of its settings.
   */
  readonly behaviour?: 'ok' | 'throws-in-setup' | 'reports-env';
  /** Distinguishes two different bundles that claim one id and version. */
  readonly variant?: string;
  /** Declare `autoload: { mode: 'all' }`, which a bundle may not. */
  readonly autoload?: boolean;
  /** The manifest's settings schema. */
  readonly settings?: Readonly<Record<string, unknown>>;
  /** Defaults to `acme`. */
  readonly signedBy?: Signer;
  /** Sign the envelope over this id instead of the bundle's own. */
  readonly signedId?: string;
}

/** The MKT-03 release statement. */
export interface ReleaseStatement {
  readonly v: 1;
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly size: number;
  readonly manifestDigest: string;
  readonly permissions: readonly string[];
  readonly jsailsCompat: string;
  readonly publisher: string;
  readonly issuedAt: string;
}

/** A detached, signed release statement. */
export interface ReleaseEnvelope {
  readonly statement: ReleaseStatement;
  readonly signatures: readonly { readonly keyId: string; readonly sig: string }[];
}

/** A built bundle: archive bytes, their digest, the manifest, and the envelope. */
export interface BuiltBundle {
  readonly id: string;
  readonly version: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly envelope: ReleaseEnvelope | undefined;
  /** The label the bundle's code records (`id@version[#variant]`). */
  readonly label: string;
}

/** A signed publisher catalog (MKT-03 shape, plugin entries omitted). */
export interface CatalogFixture {
  readonly body: {
    readonly v: 1;
    readonly publisher: string;
    readonly sequence: number;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly plugins: readonly unknown[];
  };
  readonly signatures: readonly { readonly keyId: string; readonly sig: string }[];
}

const FIXED_ISSUED_AT = '2026-11-01T00:00:00.000Z';
const JSAILS_COMPAT = '^1.0.0';

/** Canonical JSON: object keys sorted, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of `bytes`, lowercase hex. */
export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function signWith(signer: FixturePublisher, payload: unknown): { keyId: string; sig: string } {
  const sig = sign(null, Buffer.from(canonicalJson(payload)), signer.privateKey).toString('base64');
  return { keyId: signer.keyId, sig };
}

/** The ESM source of a fixture plugin: it records evaluation and setup. */
function pluginSource(id: string, label: string, behaviour: BundleSpec['behaviour']): string {
  const throwLine =
    behaviour === 'throws-in-setup'
      ? "    throw new Error('conformance plugin setup failed');\n"
      : '';
  return `const recorder = globalThis[Symbol.for('jsails.conformance.recorder')];
recorder?.imported(${JSON.stringify(label)});
export default {
  name: ${JSON.stringify(id)},
  setup(context) {
${throwLine}    const settings = context.settings;
    const current = ${
      behaviour === 'reports-env'
        ? `{ probe: process.env[${JSON.stringify(ENV_PROBE)}] ?? null }`
        : "typeof settings?.current === 'function' ? settings.current() : undefined"
    };
    globalThis[Symbol.for('jsails.conformance.recorder')]?.setup(${JSON.stringify(label)}, current);
  },
};
`;
}

/** Build a fixture bundle. Deterministic for a given spec, apart from the publisher keys. */
export function buildBundle(spec: BundleSpec): BuiltBundle {
  const version = spec.version ?? '1.0.0';
  const label = `${spec.id}@${version}${spec.variant === undefined ? '' : `#${spec.variant}`}`;
  const permissions = [...(spec.permissions ?? [])];
  const manifest: Record<string, unknown> = {
    manifestVersion: 1,
    id: spec.id,
    version,
    name: spec.id,
    summary: 'A conformance fixture bundle.',
    publisher: spec.signedBy ?? 'acme',
    jsailsCompat: JSAILS_COMPAT,
    apiTier: 'stable',
    entry: './index.mjs',
    permissions,
    marketplace: true,
    ...(spec.autoload === true ? { autoload: { mode: 'all' } } : {}),
    ...(spec.settings === undefined ? {} : { settings: spec.settings }),
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const bytes = tarGz([
    { name: 'package/', type: 'directory' },
    { name: 'package/index.mjs', content: pluginSource(spec.id, label, spec.behaviour) },
    { name: 'package/manifest.json', content: manifestText },
  ]);
  const digest = sha256(bytes);
  const signerId = spec.signedBy === undefined ? 'acme' : spec.signedBy;
  let envelope: ReleaseEnvelope | undefined;
  if (signerId !== null) {
    const signer = PUBLISHERS[signerId];
    const statement: ReleaseStatement = {
      v: 1,
      id: spec.signedId ?? spec.id,
      version,
      digest,
      size: bytes.byteLength,
      manifestDigest: sha256(manifestText),
      permissions,
      jsailsCompat: JSAILS_COMPAT,
      publisher: signer.id,
      issuedAt: FIXED_ISSUED_AT,
    };
    envelope = { statement, signatures: [signWith(signer, statement)] };
  }
  return Object.freeze({ id: spec.id, version, bytes, digest, manifest, envelope, label });
}

/** A catalog signed by `acme`, `expiresInDays` from a fixed issue date. */
export function buildCatalog(sequence: number, expiresInDays = 30): CatalogFixture {
  const issued = Date.parse(FIXED_ISSUED_AT);
  const body = {
    v: 1 as const,
    publisher: PUBLISHERS.acme.id,
    sequence,
    issuedAt: FIXED_ISSUED_AT,
    expiresAt: new Date(issued + expiresInDays * 86_400_000).toISOString(),
    plugins: [],
  };
  return { body, signatures: [signWith(PUBLISHERS.acme, body)] };
}

/** One entry of a fixture tar archive. */
export interface TarEntry {
  /** The entry name; raw bytes when a scenario needs a name that is not UTF-8. */
  readonly name: string | Uint8Array;
  readonly content?: string | Uint8Array;
  /** Defaults to `file`. */
  readonly type?: 'file' | 'directory' | 'symlink';
  /** Symlink target. */
  readonly linkName?: string;
}

const BLOCK = 512;
const encoder = new TextEncoder();

function bytesOf(value: string | Uint8Array | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  return typeof value === 'string' ? encoder.encode(value) : value;
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  const digits = value.toString(8).padStart(length - 1, '0');
  block.set(encoder.encode(digits), offset);
  block[offset + length - 1] = 0;
}

/** Recompute and store a ustar header's checksum (the field counts as spaces). */
export function writeHeaderChecksum(block: Uint8Array): void {
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += block[i] ?? 0;
  block.set(encoder.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
}

function header(entry: TarEntry, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const name = bytesOf(entry.name);
  if (name.length > 100) throw new RangeError('fixture tar names are at most 100 bytes');
  block.set(name, 0);
  const type = entry.type ?? 'file';
  writeOctal(block, 100, 8, type === 'directory' ? 0o755 : 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  block[156] = (type === 'directory' ? '5' : type === 'symlink' ? '2' : '0').charCodeAt(0);
  if (entry.linkName !== undefined) block.set(bytesOf(entry.linkName), 157);
  block.set(encoder.encode('ustar\u000000'), 257);
  writeHeaderChecksum(block);
  return block;
}

/** A deterministic ustar archive. */
export function tar(entries: readonly TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const content =
      entry.type === 'file' || entry.type === undefined
        ? bytesOf(entry.content)
        : new Uint8Array(0);
    parts.push(header(entry, content.length));
    const padded = new Uint8Array(Math.ceil(content.length / BLOCK) * BLOCK);
    padded.set(content);
    parts.push(padded);
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A deterministic gzip-compressed ustar archive. */
export function tarGz(entries: readonly TarEntry[]): Uint8Array {
  return new Uint8Array(gzipSync(tar(entries), { level: 9 }));
}
