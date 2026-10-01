/**
 * Fixtures for the outcome-layer tests: a configured engine with a fixed
 * clock and a real Web Crypto sealer, request facts, and readers for outcome
 * headers and the carrier cookie a response sets.
 */

import {
  defineInertia,
  webCryptoSealer,
  type InertiaConfig,
  type InertiaOptions,
  type InertiaOutcome,
  type InertiaRequestFacts,
  type InertiaSealer,
} from '../../src/index.js';

/** A fixed 32-byte test key. */
export const TEST_KEY = new Uint8Array(32).map((_, index) => index + 1);

/** A sealer over {@link TEST_KEY}. */
export const TEST_SEALER: InertiaSealer = webCryptoSealer(TEST_KEY);

/** A clock tests can move. */
export class TestClock {
  current = Date.UTC(2026, 10, 19, 12, 0, 0);
  readonly now = (): number => this.current;
  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

/** An engine config with version `v1`, a carrier, and `clock`. */
export function engine(
  clock: TestClock = new TestClock(),
  overrides: Partial<InertiaOptions> = {},
): InertiaConfig {
  return defineInertia({
    version: 'v1',
    carrier: { sealer: TEST_SEALER, oversize: 'throw' },
    now: clock.now,
    ...overrides,
  });
}

/** Request facts for `path` on `origin`. */
export function facts(
  path: string,
  headers: Readonly<Record<string, string>> = {},
  options: {
    readonly method?: string;
    readonly signal?: AbortSignal;
    readonly origin?: string;
  } = {},
): InertiaRequestFacts {
  return {
    method: options.method ?? 'GET',
    url: new URL(path, options.origin ?? 'https://example.test'),
    headers: new Headers(headers),
    signal: options.signal ?? new AbortController().signal,
  };
}

/** Headers of an Inertia visit on version `v1`. */
export function inertiaHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { 'X-Inertia': 'true', 'X-Inertia-Version': 'v1', ...extra };
}

/** One header of an outcome, joined like `Headers.get`, or `null`. */
export function header(outcome: InertiaOutcome, name: string): string | null {
  const values = outcome.headers
    .filter(([key]) => key === name.toLowerCase())
    .map(([, value]) => value);
  return values.length === 0 ? null : values.join(', ');
}

/** The `Set-Cookie` values of an outcome. */
export function setCookies(outcome: InertiaOutcome): string[] {
  return outcome.headers.filter(([key]) => key === 'set-cookie').map(([, value]) => value);
}

/**
 * The `Cookie` request header a browser would send after `outcome`: the
 * cookie's `name=value`, or `null` when the outcome deleted it or set none.
 */
export function cookieAfter(outcome: InertiaOutcome): string | null {
  const cookie = setCookies(outcome)[0];
  if (cookie === undefined || cookie.includes('Max-Age=0')) return null;
  return cookie.split(';', 1)[0] ?? null;
}

/** Parse the JSON body of a page outcome. */
export function jsonBody(outcome: InertiaOutcome): Record<string, unknown> {
  if (outcome.body === null) throw new Error('outcome has no body');
  const parsed: unknown = JSON.parse(outcome.body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** A seeded pseudo-random generator (mulberry32). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
