/**
 * URL schemes that an attribute value from a producer (rich text, a theme
 * template, a media reference) is never allowed to carry.
 *
 * Dependency-free and browser-safe.
 */

/** Script, data, and local-file schemes, matched ASCII case-insensitively. */
export const UNSAFE_URL_SCHEMES = /^(?:javascript|vbscript|data|file):/i;

/** True when `value` starts with one of {@link UNSAFE_URL_SCHEMES}. */
export function hasUnsafeScheme(value: string): boolean {
  return UNSAFE_URL_SCHEMES.test(value);
}
