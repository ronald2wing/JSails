/**
 * Injection safety for text serialized verbatim into a `<style>` element.
 *
 * A theme token value and a theme stylesheet both reach the page as raw CSS,
 * so a control character or a `</style` sequence would let a manifest break
 * out of the style element. One predicate per shape keeps the token check and
 * the stylesheet check from drifting apart.
 */

import { CONTROL_CHARS } from 'jsails/support';

/** `</style` closes the element the CSS is injected into. */
const STYLE_BREAK = /<\/style/i;

/** Control characters other than the whitespace a stylesheet legitimately holds (tab, LF, CR). */
const NON_WHITESPACE_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** True when one token value can be injected into a CSS declaration. */
export function isSafeCssValue(value: string): boolean {
  return !CONTROL_CHARS.test(value) && !STYLE_BREAK.test(value);
}

/** True when a whole stylesheet, line breaks included, can be injected. */
export function isSafeStylesheet(css: string): boolean {
  return !NON_WHITESPACE_CONTROL_CHARS.test(css) && !STYLE_BREAK.test(css);
}
