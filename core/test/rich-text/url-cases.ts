/**
 * The URL table of the rich-text model: every string the link and embed
 * predicates are specified against, with the verdict of each. `url.test.ts`
 * checks the predicates against it, and `versioning.test.ts` requires the
 * committed version 2 corpus to hold every case on its accept or reject side,
 * so the table, the predicates and the pinned corpus cannot drift apart.
 */

/** One table row: the string and whether each predicate accepts it. */
export interface UrlCase {
  readonly value: string;
  readonly link: boolean;
  readonly embed: boolean;
}

const LONGEST_PATH = `/${'a'.repeat(2047)}`;

export const URL_CASES: readonly UrlCase[] = [
  // Same-origin paths and fragments: links, never embeds.
  { value: '/', link: true, embed: false },
  { value: '/pricing', link: true, embed: false },
  { value: '/a/b?c=d&e=f#g', link: true, embed: false },
  { value: '/%2F%2Fevil.example', link: true, embed: false },
  { value: '#top', link: true, embed: false },
  { value: LONGEST_PATH, link: true, embed: false },
  // Absolute web URLs.
  { value: 'https://example.com', link: true, embed: true },
  { value: 'https://example.com/path?q=1#frag', link: true, embed: true },
  { value: 'https://xn--r8jz45g.jp/', link: true, embed: true },
  { value: 'https://例え.jp/パス', link: true, embed: true },
  { value: 'https://[::1]:8443/x', link: true, embed: true },
  { value: 'https://www.youtube.com/embed/dQw4w9WgXcQ', link: true, embed: true },
  { value: 'http://example.org/', link: true, embed: false },
  { value: 'http://www.youtube.com/embed/x', link: true, embed: false },
  // Mail and phone links.
  { value: 'mailto:team@example.com', link: true, embed: false },
  { value: 'mailto:a@b.c?subject=hi', link: true, embed: false },
  { value: 'tel:+1-555-0100', link: true, embed: false },
  { value: 'tel:0800(123)456', link: true, embed: false },
  // Script and data schemes, in any spelling.
  { value: 'javascript:alert(1)', link: false, embed: false },
  { value: 'JavaScript:alert(1)', link: false, embed: false },
  { value: 'java\tscript:alert(1)', link: false, embed: false },
  { value: 'data:text/html,<script>alert(1)</script>', link: false, embed: false },
  { value: 'vbscript:msgbox(1)', link: false, embed: false },
  { value: 'blob:https://example.com/1', link: false, embed: false },
  // Another origin without a scheme.
  { value: '//evil.example/', link: false, embed: false },
  { value: '///evil.example', link: false, embed: false },
  { value: '/\\evil.example', link: false, embed: false },
  { value: '\\\\evil.example', link: false, embed: false },
  // Userinfo that disguises the host.
  { value: 'https://trusted.example@evil.example/', link: false, embed: false },
  { value: 'https://user:pass@example.com/', link: false, embed: false },
  // One spelling only: lower-case scheme with its `//` authority.
  { value: 'HTTPS://example.com', link: false, embed: false },
  { value: 'Https://example.com', link: false, embed: false },
  { value: 'https:example.com', link: false, embed: false },
  { value: 'https:/example.com', link: false, embed: false },
  { value: 'https://', link: false, embed: false },
  { value: 'http://', link: false, embed: false },
  // Whitespace, controls, bidi controls and lone surrogates anywhere.
  { value: ' https://example.com', link: false, embed: false },
  { value: 'https://example.com ', link: false, embed: false },
  { value: 'https://exa mple.com', link: false, embed: false },
  { value: 'https://example.com/\u202e', link: false, embed: false },
  { value: 'https://example.com/\u2066', link: false, embed: false },
  { value: 'https://example.com/\u0000', link: false, embed: false },
  { value: 'https://example.com/\u0085', link: false, embed: false },
  { value: '/a\ud800', link: false, embed: false },
  { value: '/a\udc00b', link: false, embed: false },
  // Relative references whose target depends on the page.
  { value: 'relative/path', link: false, embed: false },
  { value: './x', link: false, embed: false },
  { value: '../x', link: false, embed: false },
  { value: '?q=1', link: false, embed: false },
  // Other schemes.
  { value: 'ftp://example.com/', link: false, embed: false },
  { value: 'file:///etc/passwd', link: false, embed: false },
  { value: 'ws://example.com/', link: false, embed: false },
  // Empty or malformed mail and phone links.
  { value: 'mailto:', link: false, embed: false },
  { value: 'mailto:?subject=x', link: false, embed: false },
  { value: 'tel:', link: false, embed: false },
  { value: 'tel:+', link: false, embed: false },
  { value: 'tel:call-me', link: false, embed: false },
  // Length.
  { value: '', link: false, embed: false },
  { value: `${LONGEST_PATH}a`, link: false, embed: false },
];
