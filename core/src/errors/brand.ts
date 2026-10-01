/**
 * The identity mark of a framework error.
 *
 * Errors are recognized by a `Symbol.for('jsails.error')` brand on their
 * prototype rather than by `instanceof`, so an error raised by a second copy of
 * `jsails` (a plugin that bundled its own, a test that loaded both the source
 * and the build) is still recognized at every boundary. `Symbol.for` returns
 * the same symbol in every copy and every realm of one process.
 *
 * Browser-safe: no runtime imports.
 */

/**
 * The brand every framework error's prototype carries, set to `true`.
 *
 * @public
 */
export const ERROR_BRAND: unique symbol = Symbol.for('jsails.error');
