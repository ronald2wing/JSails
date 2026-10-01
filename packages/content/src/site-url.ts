/**
 * Site URL validation and normalization shared by the feed and sitemap
 * renderers and by the blog CMS.
 */

import { ABSOLUTE_URL_PATTERN } from 'jsails/plugin-sdk';

import { ContentError } from './errors.js';

/** Trim and validate an absolute `http(s)` site URL, failing value-free. */
export function requireSiteUrl(siteUrl: string): string {
  const trimmed = siteUrl.trim();
  if (trimmed.length === 0 || !ABSOLUTE_URL_PATTERN.test(trimmed)) {
    throw new ContentError('invalid_site_url', 'siteUrl must be an absolute http(s) URL');
  }
  return trimmed;
}

/** Drop trailing slashes so a path can be appended without doubling them. */
export function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}
