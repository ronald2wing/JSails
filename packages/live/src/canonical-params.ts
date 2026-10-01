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
 */

import { Encoding } from 'jsails/support';

/** Serialize parsed params to a deterministic, unambiguous fan-out key segment. */
export function canonicalParams(params: unknown): string {
  const serialized = Encoding.canonicalJson(params);
  return `${serialized.length}:${serialized}`;
}
