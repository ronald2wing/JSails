/**
 * The root-relative URL path shape accepted for redirects, media references,
 * and navigation targets.
 *
 * Dependency-free, so the browser-safe `jsails/client` bundle and server
 * modules can both import it.
 */

/**
 * True for a root-relative path of the form `/seg/seg`:
 * starts with `/`, is not protocol-relative (`//`), contains no backslash,
 * NUL, control character, or `..` segment.
 */
export function isValidRelativePath(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length === 0 || value[0] !== '/') {
    return false;
  }
  // Reject protocol-relative paths that would escape the origin.
  if (value.startsWith('//')) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    // backslash, NUL, and control characters are filesystem/URL hazards
    if (code === 0x5c || code === 0x00 || code < 0x20) {
      return false;
    }
  }
  if (value.split('/').some((segment) => segment === '..')) {
    return false;
  }
  return true;
}
