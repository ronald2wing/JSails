/**
 * Canonical serialization of parsed publication params (docs/design/live.md §4.7).
 *
 * {@link canonicalParams} turns the Zod-parsed params object into the stable
 * string that forms the middle of the live service's fan-out key. It must be
 * deterministic across key insertion order and nested structure, or two equal
 * param sets fail to share a driver and fan-out degrades to one membership
 * probe per subscription. `Encoding.canonicalJson` supplies that determinism;
 * the output is prefixed with the JSON's length because the fan-out key joins
 * it with `:` and the JSON itself may contain `:`.
 *
 * {@link userFingerprint} applies the same treatment to a resolved user, whose
 * every claim may feed `authorize` and `query`: two users are interchangeable
 * for fan-out, and a revalidated user is unchanged, only when every claim is.
 */

import type { LiveUser } from 'jsails/live';
import { Encoding } from 'jsails/support';

/** Serialize parsed params to a deterministic, unambiguous fan-out key segment. */
export function canonicalParams(params: unknown): string {
  const serialized = Encoding.canonicalJson(params);
  return `${serialized.length}:${serialized}`;
}

/** The fingerprint of an anonymous connection; no serialized user can equal it. */
const ANONYMOUS = 'anonymous';

/**
 * A deterministic string over every claim of `user`, as its JSON form carries
 * it (a `Date` as its ISO string, a `bigint` as its digits). Returns
 * `undefined` for a user JSON cannot represent (a cycle), which a caller must
 * treat as a mismatch rather than as equal to anything.
 */
export function userFingerprint(user: LiveUser | null): string | undefined {
  if (user === null) {
    return ANONYMOUS;
  }
  let plain: unknown;
  try {
    plain = JSON.parse(
      JSON.stringify(user, (_key, value: unknown) =>
        typeof value === 'bigint' ? `${value}n` : value,
      ),
    );
  } catch {
    return undefined;
  }
  const serialized = Encoding.canonicalJson(plain);
  return `${serialized.length}:${serialized}`;
}
