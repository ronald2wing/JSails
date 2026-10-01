/**
 * Well-formed text: a string with no lone UTF-16 surrogate, so it has exactly
 * one UTF-8 encoding. Paths, canonical JSON and catalog text all require it.
 */

/** With the `u` flag a paired surrogate is one code point, so only a lone one matches. */
const LONE_SURROGATE = /\p{Cs}/u;

/** Whether `text` holds no lone surrogate. */
export function isWellFormedText(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}
