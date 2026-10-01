/**
 * Absolute `http(s)` URL shape shared by SEO and content validation.
 *
 * The same shape guards a sitemap `<loc>`, a robots `Sitemap:` value, and a
 * feed's `siteUrl`. Rejecting whitespace, angle brackets, quotes, braces pipes,
 * backslashes, carets, and backticks keeps a value from breaking out of XML or
 * an HTTP header.
 */

export const ABSOLUTE_URL_PATTERN = /^https?:\/\/[^\s<>"'{}|\\^`]+$/;
