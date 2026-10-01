/**
 * Injection safety for text serialized verbatim into a `<style>` element.
 *
 * A theme token value and a theme stylesheet both reach the page as raw CSS,
 * so a control character or a `</style` sequence would let a manifest break
 * out of the style element. A token value is stricter still: it must stay one
 * declaration value, so it may not carry `;`, `{`, `}` (which would end the
 * declaration or block and start arbitrary rules), `<`, `\`, `@`, or a comment
 * opener. Token and theme names are interpolated as a property name and an
 * attribute-selector string, so each has a fixed safe alphabet. One predicate
 * per shape keeps the serializer and the manifest parser from drifting apart.
 */

import { CONTROL_CHARS } from 'jsails/support';

/** `</style` closes the element the CSS is injected into. */
const STYLE_BREAK = /<\/style/i;

/** Control characters other than the whitespace a stylesheet legitimately holds (tab, LF, CR). */
const NON_WHITESPACE_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Characters that would let a value leave its declaration or the style element. */
const DECLARATION_BREAK = /[;{}<\\@]|\/\*/;

/** A custom property name: `--` plus letters, digits, `-`, or `_`. */
const TOKEN_NAME = /^--[A-Za-z0-9_-]+$/;

/** A theme name: safe inside `[data-theme="<name>"]` and an HTML attribute. */
const THEME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when one token value can be injected into a CSS declaration. */
export function isSafeCssValue(value: string): boolean {
  return !CONTROL_CHARS.test(value) && !STYLE_BREAK.test(value) && !DECLARATION_BREAK.test(value);
}

/** True when a token name can be emitted as a custom property name. */
export function isSafeCssTokenName(name: string): boolean {
  return TOKEN_NAME.test(name);
}

/** True when a theme name can be emitted inside a `[data-theme="…"]` selector. */
export function isSafeThemeName(name: string): boolean {
  return THEME_NAME.test(name);
}

/** True when a whole stylesheet, line breaks included, can be injected. */
export function isSafeStylesheet(css: string): boolean {
  return !NON_WHITESPACE_CONTROL_CHARS.test(css) && !STYLE_BREAK.test(css);
}
