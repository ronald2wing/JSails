/**
 * Ambient request locale, server-only (`node:async_hooks`).
 *
 * A request's locale is resolved by its claim (`server/request-frame.ts`)
 * once its route is known, and settled on the request's one execution context
 * under {@link localeKey} (no second context entry); {@link withLocale}
 * shadows it for a callback, in a request or outside one. The
 * {@link I18nService} reads the current locale via {@link currentLocale},
 * falling back to the plugin's default when no locale is set (e.g. outside a
 * request).
 *
 * The locale is a propagated key of the execution context (`jsails/context`),
 * so a job dispatched from a request runs in the request's locale. A carried
 * locale is input from a queue: it is restored only when it has the shape of
 * a language tag, and only such a locale is carried, so a job never fails over
 * the locale its request resolved.
 */

import {
  createContextKey,
  getContext,
  withContext,
  type ContextKey,
} from '../context/execution-context.js';

/** A BCP 47-shaped tag: letters, then `-` or `_` separated alphanumeric subtags. */
const LOCALE_TAG = /^[A-Za-z]{1,8}(?:[-_][A-Za-z0-9]{1,8}){0,7}$/;

/** The execution-context key of the request locale. */
export const localeKey: ContextKey<string> = createContextKey<string>('jsails.locale', {
  propagate: {
    encode: (locale) => (LOCALE_TAG.test(locale) ? locale : undefined),
    decode: (text) => (LOCALE_TAG.test(text) ? text : undefined),
  },
});

/**
 * Run `fn` with the given request locale ambient. The locale is active for the
 * synchronous body and every async continuation it awaits, and is restored on
 * return/throw. Nested calls shadow the outer locale.
 */
export function withLocale<T>(locale: string, fn: () => T): T {
  return withContext(localeKey, locale, fn);
}

/**
 * The current request locale, or `undefined` when no locale has been set
 * (outside a request, before the request's route resolved it, or when the
 * plugin is absent).
 */
export function currentLocale(): string | undefined {
  return getContext(localeKey);
}
