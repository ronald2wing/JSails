/**
 * The flat key encoding of repeater and formset items: `name[i].sub`.
 *
 * Item inputs submit under flat keys so a plain urlencoded form can carry a
 * bounded list; the schema builder lifts them back into arrays, the form
 * renderer counts and renumbers them, and the intent handler removes one. All
 * of those read the same encoding, defined here once.
 */

/** Upper bound on a submitted item index, so a hostile key cannot size a loop. */
const MAX_REPEATER_INDEX = 1000;

/** The flat key of one item field (`name[i].sub`). */
export function repeaterItemKey(fieldName: string, index: number, itemName: string): string {
  return `${fieldName}[${index}].${itemName}`;
}

/**
 * Parse a flat key's item index (`name[i].sub` -> `i`); `undefined` for a key
 * outside the field, a non-digit index, or an index past the bound.
 */
export function repeaterKeyIndex(fieldName: string, key: string): number | undefined {
  const prefix = `${fieldName}[`;
  if (!key.startsWith(prefix)) return undefined;
  const rest = key.slice(prefix.length);
  const close = rest.indexOf(']');
  if (close <= 0) return undefined;
  const digits = rest.slice(0, close);
  if (!/^\d+$/.test(digits)) return undefined;
  const index = Number(digits);
  return Number.isSafeInteger(index) && index < MAX_REPEATER_INDEX ? index : undefined;
}

/** The number of items present in a flat values map (0 when absent). */
export function rawRepeaterItemCount(
  fieldName: string,
  values: Readonly<Record<string, unknown>>,
): number {
  let maxIndex = -1;
  for (const key of Object.keys(values)) {
    const index = repeaterKeyIndex(fieldName, key);
    if (index !== undefined && index > maxIndex) maxIndex = index;
  }
  return maxIndex + 1;
}

/** Rewrite a flat key's item index in place (`name[i].sub` -> `name[j].sub`). */
export function renumberRepeaterKey(key: string, index: number): string {
  const open = key.indexOf('[');
  const close = key.indexOf(']');
  if (open < 0 || close <= open) return key;
  return `${key.slice(0, open)}[${index}]${key.slice(close + 1)}`;
}
