/**
 * Emit a JavaScript string literal with single quotes.
 *
 * The compiler emits generated modules by textual assembly, so any caller that
 * inlines a runtime string needs exactly one escaping rule. Backslashes are
 * escaped first, then single quotes, so the result is a valid `'…'` literal for
 * any input — no other escaping (newlines, control characters) is attempted
 * because callers only inline identifiers, symbol names, and specifiers.
 */
export function quoteJsString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
