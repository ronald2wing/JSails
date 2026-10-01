/**
 * The URL slug transform shared by heading anchors and taxonomy terms.
 *
 * Lowercases, turns every run of non-alphanumeric characters into one dash,
 * and trims leading and trailing dashes, so `Node.js / TypeScript` becomes
 * `node-js-typescript`. `Str.slug` from `jsails/support` is not used because it
 * deletes punctuation inside a word (`nodejs`) and transliterates non-ASCII
 * letters, which would change existing anchors and term URLs.
 */

/** The URL-safe slug of `text`; empty when `text` has no alphanumeric character. */
export function toUrlSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
