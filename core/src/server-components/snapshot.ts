/**
 * HMAC-SHA256 signed component snapshots.
 *
 * A snapshot token is a self-contained, integrity-protected record of a server
 * component's current state, bound to its component name, origin, and (through
 * a purpose-separated subject tag) the session or scope that owns it. It is
 * signed with a key the application supplies: there is no key generation, no
 * state store, no cookie, and no transport here — the caller owns key
 * management and wherever the token is carried.
 *
 * Security posture:
 * - Integrity only, never confidentiality. The MAC proves the snapshot was
 *   produced by a holder of the key; it does not encrypt. State, subject, and
 *   page are readable by anyone who holds the token, so secrets must never be
 *   placed in state.
 * - No replay guarantee. A valid token can be replayed until it expires. Keep
 *   `ttlMs` short and rely on server-side mutation state where non-replay is
 *   required.
 * - Bounded lifetime. Every re-sign slides `expiresAt` forward by `ttlMs`, but
 *   the mount time (`issuedAt`) is carried across re-signs and `expiresAt` is
 *   capped at `issuedAt + maxAgeMs`, so a token kept alive by periodic
 *   refreshes still ages out and the component must be re-mounted.
 * - Key rotation. `previousKeys` are accepted for verification only: a token
 *   signed under a retired key still verifies (and its subject tag is checked
 *   under that key), and the next re-sign moves it to the current key.
 * - The raw session/scope id is never serialized. `subjectFor` derives a
 *   purpose-separated HMAC tag from it; only that tag appears in the token.
 * - The subject tag and the snapshot signature use different HMAC keys derived
 *   from the master key, so a tag can never be forged from a snapshot
 *   signature (or vice versa) without the master key.
 * - The MAC is verified before the payload is parsed or trusted, and the
 *   comparison is constant-time (`timingSafeEqual`).
 * - Token size, payload size, JSON nesting depth, object shape (plain objects,
 *   no `__proto__`/`constructor`/`prototype` keys), and number finiteness are
 *   all bounded and validated, so a crafted token can never force unbounded
 *   work or pollute a prototype.
 * - Errors are generic and value-free: they never echo the key, state, token,
 *   or an underlying cause.
 */

import { createHmac } from 'node:crypto';

import { safeEqualStrings } from '../security/constant-time.js';
import { isHttpOrigin } from '../url/origin.js';
import { isValidRelativePath } from '../url/relative-path.js';
import { isForbiddenKey, isPlainObject } from '../json/shape.js';
import {
  MIN_KEY_BYTES,
  maxTokenLength,
  normalizeKey,
  signJson,
  verifyAndDecode,
} from './reference-token.js';
import type { JsonObject } from '../contracts/http.js';
import { JsailsError } from '../errors/jsails-error.js';
import { scanJson, type JsonViolation } from '../wire/json-scan.js';

/** Snapshot payload format version carried in the serialized JSON. */
const VERSION = 1;

/** HMAC key-derivation context for snapshot signatures. */
const SIGN_KEY_CONTEXT = 'jsails.snapshot.sign.v1';
/** HMAC key-derivation context for subject tags. */
const SUBJECT_KEY_CONTEXT = 'jsails.snapshot.subject.v1';

/** Default snapshot lifetime. */
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Default absolute lifetime from mount, across every sliding re-sign. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
/** Default cap on the serialized payload, in bytes. */
const DEFAULT_MAX_BYTES = 64 * 1024; // 64 KiB
/** Cap on the raw subject id fed to `subjectFor`, in UTF-8 bytes. */
const MAX_SUBJECT_ID_BYTES = 4096;
/**
 * Default allowance for clock disagreement between the instance that signed a
 * token and the one verifying it, applied to every time comparison in `sign`
 * and `verify`.
 */
export const DEFAULT_CLOCK_TOLERANCE_MS = 60_000;
/** Default sliding snapshot lifetime, renewed by every update. */
export const DEFAULT_SNAPSHOT_TTL_MS: number = DEFAULT_TTL_MS;

/** The page provenance a snapshot is bound to. */
export interface SnapshotPage {
  /** URL path relative to the origin; must start with `/` and carry no traversal. */
  readonly path: string;
  /** Route parameters, all string values. */
  readonly params: Readonly<Record<string, string>>;
}

/**
 * A verified snapshot record. `expiresAt` is assigned at sign time and
 * `issuedAt` at the first (mount) sign. A token carries no update counter: an
 * update that changes nothing hands the same token back, byte for byte.
 */
export interface SnapshotPayload {
  readonly v: 1;
  readonly component: string;
  readonly id: string;
  readonly state: JsonObject;
  readonly page: SnapshotPage;
  readonly origin: string;
  readonly subject: string | null;
  readonly expiresAt: number;
  /**
   * Epoch milliseconds of the mount-time sign, preserved across re-signs. The
   * built-in signer always returns it; a custom {@link ComponentSigner} may
   * omit it, and the runtime then passes `undefined` back to that signer's
   * `sign` on the next update (no absolute lifetime is known).
   */
  readonly issuedAt?: number;
}

/**
 * Everything a caller supplies to `sign`. `expiresAt` is computed by the
 * signer; `issuedAt` is stamped with the current time unless the caller passes
 * the verified snapshot's `issuedAt` through a re-sign.
 */
export type SnapshotPayloadWithoutExpiry = Omit<SnapshotPayload, 'expiresAt'>;

/** Optional expected-scope constraints handed to `verify`. */
export interface SnapshotVerifyOptions {
  readonly component?: string;
  readonly origin?: string;
  /** Expected subject tag, as returned by `subjectFor` under the current key. */
  readonly subject?: string | null;
  /**
   * Expected raw session/scope id. Preferred over `subject`: the signer derives
   * the tag under whichever key verified the token, so a token signed before a
   * key rotation still matches its subject. The returned snapshot carries the
   * tag under the current key.
   */
  readonly subjectId?: string | null;
}

/** Options for {@link HmacComponentSigner}. */
export interface SnapshotSignerOptions {
  /**
   * The signing key. A string is interpreted as UTF-8. Must be at least 32
   * bytes (256 bits). Never generated or defaulted — the caller supplies it.
   */
  readonly key: string | Uint8Array;
  /** Monotonic-ish time source returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Sliding snapshot lifetime in milliseconds. Must be a positive finite number. */
  readonly ttlMs?: number;
  /**
   * Absolute lifetime from the mount-time sign, in milliseconds, no matter how
   * often the snapshot is re-signed. Defaults to 24 hours.
   */
  readonly maxAgeMs?: number;
  /**
   * Retired keys still accepted for verification during a rotation (each at
   * least 32 bytes). Tokens are always signed with `key`.
   */
  readonly previousKeys?: readonly (string | Uint8Array)[];
  /** Cap on the serialized payload in bytes. Must be a positive integer. */
  readonly maxBytes?: number;
  /**
   * Milliseconds of clock disagreement between instances tolerated when a
   * token's `issuedAt` and `expiresAt` are compared with this instance's
   * clock, in both `sign` and `verify`. Defaults to 60 seconds; must be a
   * non-negative integer.
   */
  readonly clockToleranceMs?: number;
}

/**
 * A configured snapshot signer: binds a subject, signs a payload, and verifies
 * a token against expected scope. All methods are pure relative to the key and
 * options captured at construction; nothing here touches a network or a store.
 */
export interface ComponentSigner {
  /**
   * Derive the subject tag for a raw session/scope id. The raw id is never
   * serialized — only the derived tag should be placed in a payload's
   * `subject`. Returns `null` for a `null` id (anonymous scope).
   */
  subjectFor(sessionOrScopeId: string | null): string | null;
  /**
   * Every subject tag the id may carry in a token this signer still accepts:
   * the current key's first, then each retired key's. Optional; a signer
   * without key rotation omits it and only {@link subjectFor} is consulted.
   * Lets an upload or download reference minted before a rotation (which
   * carries the old tag) still match its own session.
   */
  subjectsFor?(sessionOrScopeId: string | null): readonly (string | null)[];
  /** Sign a snapshot payload (without `expiresAt`), returning the token. */
  sign(payload: SnapshotPayloadWithoutExpiry): string;
  /** Verify a token, returning the trusted snapshot record. Throws on any failure. */
  verify(token: string, options?: SnapshotVerifyOptions): SnapshotPayload;
  /**
   * True when a verified snapshot should be re-signed even though its state
   * did not change: more than half of its sliding lifetime is spent and a
   * re-sign would move its expiry forward (not past the absolute lifetime).
   * An update that changes nothing re-signs only then, so an idle poll hands
   * the same token back until the token needs renewing.
   */
  renewalDue(snapshot: SnapshotPayload): boolean;
}

/** Stable codes carried by a {@link SnapshotError}. */
export type SnapshotErrorCode =
  'invalid_options' | 'invalid_payload' | 'invalid_token' | 'unsupported_version' | 'too_large';

/** Raised for any invalid signer configuration, payload, or token. Value-free. */
export class SnapshotError extends JsailsError {
  constructor(
    readonly code: SnapshotErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

type Fail = (violation: JsonViolation) => never;

/**
 * Report the first violation `scanJson` finds in `root` through `fail`, so
 * the signer and the verifier judge state exactly as the update parser and
 * the browser controller do.
 */
function assertJsonValue(root: unknown, fail: Fail): void {
  const violation = scanJson(root);
  if (violation !== null) {
    fail(violation);
  }
}

/** The sign-side `fail`: value-free, field-naming messages (no values echoed). */
function signFail(violation: JsonViolation): never {
  const messages: Record<JsonViolation, string> = {
    depth: 'snapshot state exceeds the maximum nesting depth',
    'non-finite': 'snapshot state contains a non-finite number',
    'non-plain': 'snapshot state must contain only plain JSON values',
    'forbidden-key': 'snapshot state contains a forbidden key',
    circular: 'snapshot state must not contain circular references',
    'non-json': 'snapshot state must contain only JSON values',
  };
  throw new SnapshotError('invalid_payload', messages[violation]);
}

/** The verify-side `fail`: a single generic message, so failures are indistinguishable. */
function invalidToken(): never {
  throw new SnapshotError('invalid_token', 'invalid snapshot token');
}

function validateComponent(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SnapshotError('invalid_payload', 'component must be a non-empty string');
  }
  return value;
}

function validateId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SnapshotError('invalid_payload', 'id must be a non-empty string');
  }
  return value;
}

function validateState(value: unknown): JsonObject {
  if (!isPlainObject(value)) {
    throw new SnapshotError('invalid_payload', 'state must be a plain JSON object');
  }
  assertJsonValue(value, signFail);
  return value as unknown as JsonObject;
}

function validatePage(value: unknown): SnapshotPage {
  if (!isPlainObject(value)) {
    throw new SnapshotError('invalid_payload', 'page must be a plain object');
  }
  const { path, params: rawParams } = value;
  if (!isValidRelativePath(path)) {
    throw new SnapshotError('invalid_payload', 'page.path must be a relative URL path');
  }
  if (!isPlainObject(rawParams)) {
    throw new SnapshotError('invalid_payload', 'page.params must be a plain object');
  }
  const params: Record<string, string> = {};
  for (const [key, paramValue] of Object.entries(rawParams)) {
    if (isForbiddenKey(key)) {
      throw new SnapshotError('invalid_payload', 'page.params contains a forbidden key');
    }
    if (typeof paramValue !== 'string') {
      throw new SnapshotError('invalid_payload', 'page.params values must be strings');
    }
    params[key] = paramValue;
  }
  return { path, params };
}

function validateOrigin(value: unknown): string {
  if (!isHttpOrigin(value)) {
    throw new SnapshotError('invalid_payload', 'origin must be an http(s) origin');
  }
  return value;
}

function validateSubject(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new SnapshotError('invalid_payload', 'subject must be a string or null');
  }
  return value;
}

interface NormalizedPayload {
  readonly component: string;
  readonly id: string;
  readonly state: JsonObject;
  readonly page: SnapshotPage;
  readonly origin: string;
  readonly subject: string | null;
  readonly expiresAt: number;
  readonly issuedAt: number;
}

/**
 * True when `value` is a finite, acyclic, plain-JSON value with no forbidden
 * keys and bounded depth — exactly the structural check `sign` applies to
 * state. A pure traversal (no serialization or MAC), so the runtime can reject
 * an unsafe edit or action argument before any side effect cheaply.
 */
export function isJsonSafeValue(value: unknown): boolean {
  try {
    assertJsonValue(value, signFail);
    return true;
  } catch {
    return false;
  }
}

function serializePayload(payload: NormalizedPayload): string {
  const json: Record<string, unknown> = {
    v: VERSION,
    component: payload.component,
    id: payload.id,
    state: payload.state,
    page: { path: payload.page.path, params: payload.page.params },
    origin: payload.origin,
    subject: payload.subject,
    expiresAt: payload.expiresAt,
    issuedAt: payload.issuedAt,
  };
  return JSON.stringify(json);
}

/**
 * Build a verified snapshot record from an already-MAC-verified, parsed
 * payload. A token minted before `issuedAt` existed is treated as issued one
 * `ttlMs` before its expiry, the earliest moment it could have been signed.
 */
function parseVerifiedPayload(
  parsed: unknown,
  ttlMs: number,
): SnapshotPayload & { readonly issuedAt: number } {
  if (!isPlainObject(parsed)) {
    invalidToken();
  }
  if (parsed.v !== VERSION) {
    invalidToken();
  }

  const component = parsed.component;
  if (typeof component !== 'string' || component.trim() === '') {
    invalidToken();
  }
  const id = parsed.id;
  if (typeof id !== 'string' || id.trim() === '') {
    invalidToken();
  }
  const state = parsed.state;
  if (!isPlainObject(state)) {
    invalidToken();
  }

  const page = parsed.page;
  if (!isPlainObject(page)) {
    invalidToken();
  }
  const path = page.path;
  if (!isValidRelativePath(path)) {
    invalidToken();
  }
  const rawParams = page.params;
  if (!isPlainObject(rawParams)) {
    invalidToken();
  }
  const params: Record<string, string> = {};
  for (const [key, paramValue] of Object.entries(rawParams)) {
    if (isForbiddenKey(key)) {
      invalidToken();
    }
    if (typeof paramValue !== 'string') {
      invalidToken();
    }
    params[key] = paramValue;
  }

  const origin = parsed.origin;
  if (!isHttpOrigin(origin)) {
    invalidToken();
  }
  const subject = parsed.subject;
  if (subject !== null && (typeof subject !== 'string' || subject.length === 0)) {
    invalidToken();
  }
  const expiresAt = parsed.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    invalidToken();
  }
  const rawIssuedAt = parsed.issuedAt;
  if (
    rawIssuedAt !== undefined &&
    (typeof rawIssuedAt !== 'number' || !Number.isFinite(rawIssuedAt))
  ) {
    invalidToken();
  }
  const issuedAt = rawIssuedAt ?? expiresAt - ttlMs;

  return {
    v: VERSION,
    component,
    id,
    state: state as JsonObject,
    page: { path, params },
    origin,
    subject,
    expiresAt,
    issuedAt,
  };
}

function validateIssuedAt(value: unknown, now: number, toleranceMs: number): number {
  if (value === undefined) {
    return now;
  }
  // A token minted by an instance whose clock runs ahead carries an issuedAt
  // slightly in this instance's future; re-signing it must not fail.
  if (typeof value !== 'number' || !Number.isFinite(value) || value > now + toleranceMs) {
    throw new SnapshotError('invalid_payload', 'issuedAt must be a past epoch time when present');
  }
  return value;
}

/** Validate and normalize one signing key, value-free on failure. */
function normalizeSigningKey(key: string | Uint8Array): Buffer {
  const normalized = normalizeKey(key, () => {
    throw new SnapshotError('invalid_options', 'snapshot key must be a string or Uint8Array');
  });
  if (normalized.byteLength < MIN_KEY_BYTES) {
    throw new SnapshotError('invalid_options', 'snapshot key must be at least 32 bytes');
  }
  return normalized;
}

/** Purpose-separated keys derived from one master key. */
interface DerivedKeys {
  readonly sign: Buffer;
  readonly subject: Buffer;
}

function deriveKeys(key: Buffer): DerivedKeys {
  // The subject tag and the snapshot signature are HMACs under different
  // derived keys, so one can never stand in for the other.
  return {
    sign: createHmac('sha256', key).update(SIGN_KEY_CONTEXT).digest(),
    subject: createHmac('sha256', key).update(SUBJECT_KEY_CONTEXT).digest(),
  };
}

/**
 * A configured snapshot signer: binds a subject, signs a payload, and verifies
 * a token against expected scope. All methods are pure relative to the key and
 * options captured at construction; nothing here touches a network or a store.
 *
 * The key is required (never generated) and must be at least 32 bytes; `ttlMs`
 * (sliding), `maxAgeMs` (absolute), and `maxBytes` bound the snapshot's
 * lifetime and size. The key and any `previousKeys` are normalized and
 * validated eagerly at construction, then split into purpose-separated derived
 * HMAC keys held in `#private` fields.
 */
export class HmacComponentSigner implements ComponentSigner {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxAgeMs: number;
  readonly #maxBytes: number;
  readonly #toleranceMs: number;
  /** Current keys first, then retired keys accepted for verification only. */
  readonly #keys: readonly DerivedKeys[];
  readonly #maxTokenLength: number;

  constructor(options: SnapshotSignerOptions) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('HmacComponentSigner requires an options object');
    }
    const key = normalizeSigningKey(options.key);
    const previousKeys = options.previousKeys ?? [];
    if (!Array.isArray(previousKeys)) {
      throw new SnapshotError('invalid_options', 'previousKeys must be an array of keys');
    }

    const now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new SnapshotError('invalid_options', 'ttlMs must be a positive finite number');
    }
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      throw new SnapshotError('invalid_options', 'maxAgeMs must be a positive finite number');
    }

    const toleranceMs = options.clockToleranceMs ?? DEFAULT_CLOCK_TOLERANCE_MS;
    if (!Number.isSafeInteger(toleranceMs) || toleranceMs < 0) {
      throw new SnapshotError('invalid_options', 'clockToleranceMs must be a non-negative integer');
    }

    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new SnapshotError('invalid_options', 'maxBytes must be a positive integer');
    }

    this.#keys = [key, ...previousKeys.map(normalizeSigningKey)].map(deriveKeys);

    // Upper bound on the token string: base64url payload + separator + signature.
    this.#maxTokenLength = maxTokenLength(maxBytes);

    this.#now = now;
    this.#ttlMs = ttlMs;
    this.#maxAgeMs = maxAgeMs;
    this.#maxBytes = maxBytes;
    this.#toleranceMs = toleranceMs;
  }

  get #current(): DerivedKeys {
    return this.#keys[0]!;
  }

  subjectFor(sessionOrScopeId: string | null): string | null {
    return subjectTag(this.#current, sessionOrScopeId);
  }

  subjectsFor(sessionOrScopeId: string | null): readonly (string | null)[] {
    return this.#keys.map((keys) => subjectTag(keys, sessionOrScopeId));
  }

  sign(payload: SnapshotPayloadWithoutExpiry): string {
    if (!isPlainObject(payload)) {
      throw new SnapshotError('invalid_payload', 'snapshot payload must be an object');
    }
    if (payload.v !== VERSION) {
      throw new SnapshotError('unsupported_version', 'unsupported snapshot version');
    }
    const now = this.#now();
    if (!Number.isFinite(now)) {
      throw new SnapshotError('invalid_options', 'signer clock produced a non-finite time');
    }
    const issuedAt = validateIssuedAt(payload.issuedAt, now, this.#toleranceMs);
    // The sliding expiry never outlives the absolute lifetime from mount.
    const expiresAt = Math.min(now + this.#ttlMs, issuedAt + this.#maxAgeMs);
    if (expiresAt <= now) {
      throw new SnapshotError('invalid_payload', 'snapshot exceeded its maximum age');
    }
    const normalized: NormalizedPayload = {
      component: validateComponent(payload.component),
      id: validateId(payload.id),
      state: validateState(payload.state),
      page: validatePage(payload.page),
      origin: validateOrigin(payload.origin),
      subject: validateSubject(payload.subject),
      expiresAt,
      issuedAt,
    };

    const jsonBytes = Buffer.from(serializePayload(normalized), 'utf8');
    if (jsonBytes.byteLength > this.#maxBytes) {
      throw new SnapshotError('too_large', 'snapshot payload exceeds the maximum byte size');
    }
    return signJson(this.#current.sign, jsonBytes);
  }

  renewalDue(snapshot: SnapshotPayload): boolean {
    const now = this.#now();
    if (snapshot.expiresAt - now >= this.#ttlMs / 2) {
      return false;
    }
    const issuedAt = snapshot.issuedAt ?? snapshot.expiresAt - this.#ttlMs;
    return Math.min(now + this.#ttlMs, issuedAt + this.#maxAgeMs) > snapshot.expiresAt;
  }

  verify(token: string, options?: SnapshotVerifyOptions): SnapshotPayload {
    if (typeof token !== 'string') {
      invalidToken();
    }
    if (token.length > this.#maxTokenLength) {
      invalidToken();
    }
    const { keys, payloadBytes } = this.#verifyMac(token);

    // The payload is MAC-verified, so it was produced by `sign`, which already
    // bounded its size and depth; the structural re-check below is defense in
    // depth against prototype keys, not a parser guard.
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
      invalidToken();
    }
    assertJsonValue(parsed, () => invalidToken());
    const snapshot = parseVerifiedPayload(parsed, this.#ttlMs);

    const now = this.#now();
    const tolerance = this.#toleranceMs;
    if (snapshot.expiresAt + tolerance <= now) {
      invalidToken();
    }
    if (
      snapshot.issuedAt > now + tolerance ||
      now - snapshot.issuedAt >= this.#maxAgeMs + tolerance
    ) {
      invalidToken();
    }
    if (options?.component !== undefined && options.component !== snapshot.component) {
      invalidToken();
    }
    if (options?.origin !== undefined && options.origin !== snapshot.origin) {
      invalidToken();
    }
    if (options?.subjectId !== undefined) {
      assertSubjectMatches(snapshot.subject, subjectTag(keys, options.subjectId));
      // Re-signing moves a rotated token to the current key, so hand back the
      // subject tag the current key derives.
      if (keys !== this.#current) {
        return { ...snapshot, subject: subjectTag(this.#current, options.subjectId) };
      }
    } else if (options?.subject !== undefined) {
      assertSubjectMatches(snapshot.subject, options.subject);
    }

    return snapshot;
  }

  /** Verify the MAC under the current key, then each retired key. */
  #verifyMac(token: string): { keys: DerivedKeys; payloadBytes: Buffer } {
    for (const keys of this.#keys) {
      let payloadBytes: Buffer | undefined;
      try {
        payloadBytes = verifyAndDecode(token, keys.sign, this.#maxBytes, invalidToken);
      } catch (error) {
        if (!(error instanceof SnapshotError)) throw error;
      }
      if (payloadBytes !== undefined) {
        return { keys, payloadBytes };
      }
    }
    invalidToken();
  }
}

/** Derive the subject tag for a raw id under one key set. */
function subjectTag(keys: DerivedKeys, sessionOrScopeId: string | null): string | null {
  if (sessionOrScopeId === null) {
    return null;
  }
  if (typeof sessionOrScopeId !== 'string' || sessionOrScopeId.length === 0) {
    throw new SnapshotError('invalid_payload', 'subject id must be a non-empty string or null');
  }
  const idBuffer = Buffer.from(sessionOrScopeId, 'utf8');
  if (idBuffer.byteLength > MAX_SUBJECT_ID_BYTES) {
    throw new SnapshotError('too_large', 'subject id exceeds the maximum length');
  }
  // The raw id never leaves this function; only the derived tag is returned.
  return createHmac('sha256', keys.subject).update(idBuffer).digest('base64url');
}

function assertSubjectMatches(actual: string | null, expected: string | null): void {
  if (actual === null || expected === null) {
    if (actual !== expected) {
      invalidToken();
    }
  } else if (!safeEqualStrings(actual, expected)) {
    invalidToken();
  }
}
