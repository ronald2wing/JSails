/**
 * Response header rules shared by every Inertia outcome and the response
 * adapter: `Vary` is appended to, never overwritten, and outcomes carry their
 * headers as a plain list of pairs so they stay plain data.
 *
 * Both representations of one URL (the HTML document and the JSON page) and
 * the Precognition answers are told apart by caches only through `Vary`, so a
 * `Vary` another layer set (`Origin`, `Accept-Encoding`) must survive. A `*`
 * already varies on everything and is left alone.
 */

/** Response headers as plain `[name, value]` pairs; `set-cookie` may repeat. */
export type InertiaHeaderList = readonly (readonly [string, string])[];

/** The request headers every Inertia-aware response varies on. */
export const INERTIA_VARY: readonly string[] = Object.freeze(['X-Inertia', 'Precognition']);

/** Append `tokens` to the `Vary` header, skipping tokens already listed. */
export function appendVary(headers: Headers, tokens: readonly string[]): void {
  const current = headers.get('vary');
  const listed = (current ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '');
  if (listed.includes('*')) return;
  const known = new Set(listed.map((token) => token.toLowerCase()));
  for (const token of tokens) {
    if (known.has(token.toLowerCase())) continue;
    known.add(token.toLowerCase());
    listed.push(token);
  }
  if (listed.length > 0) headers.set('vary', listed.join(', '));
}

/** Freeze a `Headers` bag into a pair list, keeping each `set-cookie` separate. */
export function headerList(headers: Headers): InertiaHeaderList {
  const pairs: (readonly [string, string])[] = [];
  for (const [name, value] of headers) {
    if (name !== 'set-cookie') pairs.push(Object.freeze([name, value] as const));
  }
  for (const cookie of headers.getSetCookie()) {
    pairs.push(Object.freeze(['set-cookie', cookie] as const));
  }
  return Object.freeze(pairs);
}
