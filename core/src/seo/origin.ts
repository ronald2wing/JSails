/**
 * Origin validation for the SEO layer (`jsails/seo`).
 *
 * Apart from the head renderer so the app config loader can validate
 * `seo.origin` and `server.origin` without loading unhead: a command that
 * reads a config never renders a head.
 */

import { SeoError } from './errors.js';

/**
 * Validate that a value is a usable origin, returning its normalized form
 * (scheme + host + port, no path). Throws a value-free {@link SeoError}.
 */
export function assertOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new SeoError('invalid_origin', 'the SEO origin must be a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SeoError('invalid_origin', 'the SEO origin must use the http or https scheme');
  }
  return url.origin;
}
