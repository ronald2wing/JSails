/**
 * The one-shot carrier: flash data, validation errors, `clearHistory`, and
 * `preserveFragment` carried across a redirect in a sealed cookie.
 *
 * There is no server session, so what a mutation wants the next page to show
 * travels with the browser. The payload is JSON with an absolute expiry,
 * sealed through an {@link InertiaSealer} under the AAD
 * `jsails-inertia-carrier:v1`; nothing in the cookie is readable or forgeable
 * by the client, and a tampered, expired, or foreign token reads as empty.
 *
 * The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, with `Max-Age` 60 by
 * default; under https it is `Secure` and named with the `__Host-` prefix, so
 * a sibling subdomain cannot plant or shadow it. A value over 3 KiB is a
 * `carrier_too_large` error, or, with the `drop-flash` policy (the production
 * default), it degrades and the degradation is reported once: the flash is
 * dropped first; if the errors alone still overflow, each field keeps only its
 * first message, and then the longest leading run of fields, in the order the
 * issues reported them, that fits is kept. The flags always survive. Only when
 * not even the first field fits is it still an error, because a validation
 * failure that carries no error at all would look like a silent success.
 *
 * When the carrier is read and consumed is the engine's decision
 * (`resolveInertia`); this module only reads, writes, and clears.
 */

import type { InertiaErrorBags, InertiaErrors } from './error-bags.js';
import { InertiaError } from './inertia-error.js';
import type { JsonValue } from './page.js';
import { FORBIDDEN_KEYS, isPlainObject } from './plain-data.js';
import type { InertiaSealer } from './sealer.js';
import { BIGINT_MARKER } from './serialize-page.js';
import type { InertiaRequestFacts } from './visit.js';

/** The AAD every carrier token is sealed under. */
export const CARRIER_AAD = 'jsails-inertia-carrier:v1';

/** The carrier cookie name; `__Host-` is prefixed under https. */
export const CARRIER_COOKIE = 'jsails-inertia-carrier';

/** The largest carrier cookie (`name=value`) in bytes. */
export const CARRIER_MAX_BYTES = 3072;

/** Flash data: one-shot values for the client's `inertia:flash` event. */
export type InertiaFlash = Readonly<Record<string, JsonValue>>;

/** What the carrier holds; every field is optional and present only when set. */
export interface CarrierContents {
  readonly flash?: InertiaFlash;
  /** The `errors` prop, already shaped for the error bag of the failing request. */
  readonly errors?: InertiaErrors | InertiaErrorBags;
  readonly clearHistory?: true;
  /** Keep the fragment of the original visit on the page that follows the redirect. */
  readonly preserveFragment?: true;
}

/** Carrier configuration. */
export interface InertiaCarrierOptions {
  readonly sealer: InertiaSealer;
  /** Force the `Secure` attribute and `__Host-` name; defaults to the request scheme. */
  readonly secure?: boolean;
  /** Cookie and payload lifetime in seconds, 1 to 600. Defaults to 60. */
  readonly maxAgeSeconds?: number;
  /**
   * What happens when the cookie would exceed {@link CARRIER_MAX_BYTES}:
   * `throw` a `carrier_too_large` error, or degrade (drop the flash, then trim
   * the errors) and report. Defaults
   * to `drop-flash` when `NODE_ENV` is `production`, else `throw`.
   */
  readonly oversize?: 'throw' | 'drop-flash';
}

/** Validated carrier configuration. */
export interface ResolvedCarrier {
  readonly sealer: InertiaSealer;
  readonly secure: boolean | null;
  readonly maxAgeSeconds: number;
  readonly oversize: 'throw' | 'drop-flash';
}

/** The carrier as read from one request. */
export interface CarrierRead {
  /** A carrier cookie was sent, whether or not it opened. */
  readonly present: boolean;
  /** The opened contents, or `null` when absent, tampered, or expired. */
  readonly contents: CarrierContents | null;
  /** The payload expiry in epoch milliseconds, when it opened. */
  readonly expiresAt: number | null;
}

/** Reports a dropped flash; the engine routes it to its `report` hook. */
export type CarrierReporter = (error: InertiaError) => void;

const DEFAULT_MAX_AGE_SECONDS = 60;
const MAX_MAX_AGE_SECONDS = 600;

const EMPTY_READ: CarrierRead = Object.freeze({ present: false, contents: null, expiresAt: null });

/** Validate carrier options once, at configuration time. */
export function resolveCarrierOptions(options: InertiaCarrierOptions): ResolvedCarrier {
  if (!isPlainObject(options)) throw new InertiaError('invalid_options');
  const { sealer, secure, maxAgeSeconds, oversize } = options;
  if (
    typeof sealer !== 'object' ||
    sealer === null ||
    typeof sealer.seal !== 'function' ||
    typeof sealer.open !== 'function'
  ) {
    throw new InertiaError('invalid_options');
  }
  if (secure !== undefined && typeof secure !== 'boolean')
    throw new InertiaError('invalid_options');
  const maxAge = maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > MAX_MAX_AGE_SECONDS) {
    throw new InertiaError('invalid_options');
  }
  if (oversize !== undefined && oversize !== 'throw' && oversize !== 'drop-flash') {
    throw new InertiaError('invalid_options');
  }
  return Object.freeze({
    sealer,
    secure: secure ?? null,
    maxAgeSeconds: maxAge,
    oversize: oversize ?? (process.env.NODE_ENV === 'production' ? 'drop-flash' : 'throw'),
  });
}

/** The carrier cookie name for a request. */
export function carrierCookieName(carrier: ResolvedCarrier, facts: InertiaRequestFacts): string {
  return isSecure(carrier, facts) ? `__Host-${CARRIER_COOKIE}` : CARRIER_COOKIE;
}

/** Read and open the carrier a request sent. */
export async function readCarrier(
  carrier: ResolvedCarrier,
  facts: InertiaRequestFacts,
  now: number,
): Promise<CarrierRead> {
  const tokens = cookieValues(facts.headers.get('cookie'), carrierCookieName(carrier, facts));
  if (tokens.length === 0) return EMPTY_READ;
  for (const token of tokens) {
    const plaintext = await carrier.sealer.open(token, CARRIER_AAD);
    if (plaintext === null) continue;
    const opened = parsePayload(plaintext, now);
    if (opened !== null) return Object.freeze({ present: true, ...opened });
  }
  return Object.freeze({ present: true, contents: null, expiresAt: null });
}

/**
 * Open one carrier cookie value: its contents, or `null` when the token does
 * not open under {@link CARRIER_AAD}, is malformed, or expired at `now`.
 */
export async function openCarrierToken(
  sealer: InertiaSealer,
  token: string,
  now: number,
): Promise<CarrierContents | null> {
  const plaintext = await sealer.open(token, CARRIER_AAD);
  if (plaintext === null) return null;
  return parsePayload(plaintext, now)?.contents ?? null;
}

/**
 * Seal `contents` into a `Set-Cookie` value expiring at `expiresAt`. Empty
 * contents clear the cookie instead.
 */
export async function writeCarrier(
  carrier: ResolvedCarrier,
  facts: InertiaRequestFacts,
  contents: CarrierContents,
  expiresAt: number,
  now: number,
  report: CarrierReporter,
): Promise<string> {
  if (isEmptyCarrier(contents)) return clearCarrier(carrier, facts);
  if (contents.flash !== undefined) assertFlash(contents.flash);
  const name = carrierCookieName(carrier, facts);
  const fits = async (candidate: CarrierContents): Promise<string | null> => {
    const token = await seal(carrier, candidate, expiresAt);
    return byteLength(`${name}=${token}`) > CARRIER_MAX_BYTES ? null : token;
  };
  let token = await fits(contents);
  if (token === null) {
    const overflow = new InertiaError('carrier_too_large');
    if (carrier.oversize === 'throw') throw overflow;
    const flags = carriedFlags(contents);
    if (
      isEmptyCarrier({
        ...flags,
        ...(contents.errors === undefined ? {} : { errors: contents.errors }),
      })
    ) {
      // Only flash was carried, and it is gone.
      report(overflow);
      return clearCarrier(carrier, facts);
    }
    token = await degrade(contents, flags, fits);
    if (token === null) throw overflow;
    report(overflow);
  }
  const maxAge = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  return `${name}=${token}${attributes(carrier, facts)}; Max-Age=${maxAge}`;
}

/** The flags of `contents`, which every degradation keeps. */
function carriedFlags(contents: CarrierContents): CarrierContents {
  return {
    ...(contents.clearHistory === true ? { clearHistory: true as const } : {}),
    ...(contents.preserveFragment === true ? { preserveFragment: true as const } : {}),
  };
}

/**
 * The `drop-flash` ladder: the token of the first candidate that fits, or
 * `null` when not even one error field does.
 */
async function degrade(
  contents: CarrierContents,
  flags: CarrierContents,
  fits: (candidate: CarrierContents) => Promise<string | null>,
): Promise<string | null> {
  const errors = contents.errors;
  if (errors === undefined || Object.keys(errors).length === 0) return fits(flags);
  if (contents.flash !== undefined) {
    const withoutFlash = await fits({ ...flags, errors });
    if (withoutFlash !== null) return withoutFlash;
  }
  const fields = errorFields(errors).map((field) => ({ ...field, messages: firstOnly(field) }));
  const keep = (count: number): CarrierContents => ({
    ...flags,
    errors: rebuildErrors(fields.slice(0, count)),
  });
  const whole = await fits(keep(fields.length));
  if (whole !== null) return whole;
  // Binary search for the longest leading run that fits: a longer run has a
  // longer plaintext, so whether it fits is monotonic in the run length.
  let low = 0;
  let high = fields.length - 1;
  let best: string | null = null;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const token = await fits(keep(middle));
    if (token === null) high = middle - 1;
    else {
      low = middle;
      best = token;
    }
  }
  return best;
}

/** One field of the `errors` prop, with the bag it sits in when the errors are wrapped. */
interface ErrorField {
  readonly bag: string | null;
  readonly field: string;
  readonly messages: string | readonly string[];
}

function errorFields(errors: InertiaErrors | InertiaErrorBags): ErrorField[] {
  const fields: ErrorField[] = [];
  for (const [key, entry] of Object.entries<unknown>(errors)) {
    if (isMessages(entry)) fields.push({ bag: null, field: key, messages: entry });
    else if (isPlainObject(entry)) {
      for (const [field, messages] of Object.entries(entry)) {
        if (isMessages(messages)) fields.push({ bag: key, field, messages });
      }
    }
  }
  return fields;
}

function firstOnly(field: ErrorField): string | readonly string[] {
  return typeof field.messages === 'string' ? field.messages : field.messages.slice(0, 1);
}

/** Rebuild the `errors` prop; the fields are all unwrapped or all in bags, never mixed. */
function rebuildErrors(fields: readonly ErrorField[]): InertiaErrors | InertiaErrorBags {
  // Maps, not object literals: a bag name comes from a request header, and
  // `toString` or `hasOwnProperty` must not resolve to an inherited member.
  const top = new Map<string, string | readonly string[]>();
  const bags = new Map<string, Map<string, string | readonly string[]>>();
  for (const { bag, field, messages } of fields) {
    if (bag === null) top.set(field, messages);
    else {
      const entries = bags.get(bag) ?? new Map<string, string | readonly string[]>();
      entries.set(field, messages);
      bags.set(bag, entries);
    }
  }
  if (bags.size === 0) return Object.fromEntries(top);
  return Object.fromEntries([...bags].map(([bag, entries]) => [bag, Object.fromEntries(entries)]));
}

/** A `Set-Cookie` value that deletes the carrier cookie. */
export function clearCarrier(carrier: ResolvedCarrier, facts: InertiaRequestFacts): string {
  return `${carrierCookieName(carrier, facts)}=${attributes(carrier, facts)}; Max-Age=0`;
}

/** Whether `contents` holds nothing worth carrying. */
export function isEmptyCarrier(contents: CarrierContents): boolean {
  return (
    (contents.flash === undefined || Object.keys(contents.flash).length === 0) &&
    (contents.errors === undefined || Object.keys(contents.errors).length === 0) &&
    contents.clearHistory !== true &&
    contents.preserveFragment !== true
  );
}

/**
 * Check that flash data is plain JSON: the carrier seals it as JSON and the
 * page serializer later sends it, so a `Date`, `bigint`, or class instance
 * would change shape or fail on the next request instead of this one.
 */
export function assertFlash(flash: unknown): asserts flash is InertiaFlash {
  if (!isPlainObject(flash)) throw new InertiaError('unserializable_prop', { path: 'flash' });
  assertJson(flash, 'flash', new Set());
}

function assertJson(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new InertiaError('unserializable_prop', { path });
  }
  ancestors.add(value);
  if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) {
    value.forEach((item: unknown, index) => assertJson(item, `${path}.${index}`, ancestors));
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key) || key === BIGINT_MARKER) {
        throw new InertiaError('unserializable_prop', { path: `${path}.${key}` });
      }
      assertJson(value[key], `${path}.${key}`, ancestors);
    }
  } else {
    throw new InertiaError('unserializable_prop', { path });
  }
  ancestors.delete(value);
}

function seal(
  carrier: ResolvedCarrier,
  contents: CarrierContents,
  expiresAt: number,
): Promise<string> {
  return carrier.sealer.seal(
    JSON.stringify({
      v: 1,
      exp: expiresAt,
      ...(contents.flash === undefined ? {} : { flash: contents.flash }),
      ...(contents.errors === undefined ? {} : { errors: contents.errors }),
      ...(contents.clearHistory === true ? { clearHistory: true } : {}),
      ...(contents.preserveFragment === true ? { preserveFragment: true } : {}),
    }),
    CARRIER_AAD,
  );
}

function parsePayload(
  plaintext: string,
  now: number,
): { readonly contents: CarrierContents; readonly expiresAt: number } | null {
  let payload: unknown;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!isPlainObject(payload) || payload.v !== 1) return null;
  const { exp, flash, errors, clearHistory, preserveFragment } = payload;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= now) return null;
  if (flash !== undefined && !isJsonObject(flash)) return null;
  if (errors !== undefined && !isErrorsProp(errors)) return null;
  if (clearHistory !== undefined && clearHistory !== true) return null;
  if (preserveFragment !== undefined && preserveFragment !== true) return null;
  return {
    expiresAt: exp,
    contents: Object.freeze({
      ...(flash === undefined ? {} : { flash }),
      ...(errors === undefined ? {} : { errors }),
      ...(clearHistory === true ? { clearHistory: true as const } : {}),
      ...(preserveFragment === true ? { preserveFragment: true as const } : {}),
    }),
  };
}

function isJsonObject(value: unknown): value is InertiaFlash {
  if (!isPlainObject(value)) return false;
  try {
    assertJson(value, 'flash', new Set());
    return true;
  } catch {
    return false;
  }
}

function isMessages(value: unknown): value is string | readonly string[] {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((item: unknown) => typeof item === 'string'))
  );
}

/**
 * Whether `value` is an `errors` prop: field messages, or bags of them. The
 * shaping rule produces one form or the other, never a mix of the two.
 */
function isErrorsProp(value: unknown): value is InertiaErrors | InertiaErrorBags {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.some(([key]) => FORBIDDEN_KEYS.has(key))) return false;
  const isField = ([, entry]: readonly [string, unknown]): boolean => isMessages(entry);
  const isBag = ([, entry]: readonly [string, unknown]): boolean =>
    isPlainObject(entry) &&
    Object.keys(entry).every((field) => !FORBIDDEN_KEYS.has(field) && isMessages(entry[field]));
  return entries.every(isField) || entries.every(isBag);
}

function isSecure(carrier: ResolvedCarrier, facts: InertiaRequestFacts): boolean {
  return carrier.secure ?? facts.url.protocol === 'https:';
}

function attributes(carrier: ResolvedCarrier, facts: InertiaRequestFacts): string {
  return `; Path=/; HttpOnly; SameSite=Lax${isSecure(carrier, facts) ? '; Secure' : ''}`;
}

function cookieValues(header: string | null, name: string): string[] {
  if (header === null) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (value !== '') values.push(value);
  }
  return values;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
