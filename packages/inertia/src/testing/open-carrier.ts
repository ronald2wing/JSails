/**
 * Open the flash and errors carrier a response sets.
 *
 * {@link openCarrier} finds the carrier cookie among the response's
 * `Set-Cookie` headers (under either name, plain or `__Host-`), opens it with
 * the app's sealer, and returns what the next request would read: the flash,
 * the errors already shaped for their error bag, `clearHistory`, and
 * `preserveFragment`. It returns `null` when the response sets no carrier,
 * deletes it, or sets one that does not open or has expired at `now`.
 */

import { openCarrierToken, CARRIER_COOKIE } from '../carrier.js';
import type { CarrierContents } from '../carrier.js';
import type { InertiaSealer } from '../sealer.js';

/** Options for {@link openCarrier}. */
export interface OpenCarrierOptions {
  /** The time the carrier is read at, in epoch milliseconds. Defaults to now. */
  readonly now?: number;
}

const NAMES: ReadonlySet<string> = new Set([CARRIER_COOKIE, `__Host-${CARRIER_COOKIE}`]);

/** The carrier contents a response sets, or `null` when it sets none. */
export async function openCarrier(
  response: Response,
  sealer: InertiaSealer,
  options: OpenCarrierOptions = {},
): Promise<CarrierContents | null> {
  const now = options.now ?? Date.now();
  let opened: CarrierContents | null = null;
  for (const cookie of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = cookie.split(';');
    const separator = pair.indexOf('=');
    if (separator === -1 || !NAMES.has(pair.slice(0, separator).trim())) continue;
    const value = pair.slice(separator + 1).trim();
    const deleted = attributes.some((attribute) => /^\s*max-age\s*=\s*0\s*$/iu.test(attribute));
    opened = value === '' || deleted ? null : await openCarrierToken(sealer, value, now);
  }
  return opened;
}
