/**
 * The i18n service contract: {@link i18nToken}, the {@link I18nService} it
 * names, and the locale decision types the request pipeline settles. Kept
 * apart from the `i18n` plugin so the `I18n` facade (`jsails/i18n/server`)
 * and the pipeline name the service without loading the plugin and its
 * options schema.
 */

import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import type { LocalizeOptions } from './localize.js';
import type { TranslationOptions, TranslationParams, Translator } from './translator.js';

/**
 * Opaque token for the application {@link I18nService}. Defined once here and
 * shared by the provider (the `i18n` plugin) and any consumer (e.g. an extension's
 * `requires`).
 */
export const i18nToken: ServiceToken<I18nService> = createServiceToken<I18nService>('i18n');

/** A locale a `resolveLocale` callback chose, with what it read to choose it. */
export interface ResolvedLocale {
  readonly locale: string;
  /** The request headers the choice depended on (e.g. `['Accept-Language']`). */
  readonly vary?: readonly string[];
  /** True when the choice read a cookie. */
  readonly cookie?: boolean;
}

/**
 * How a request's locale was decided. `source` is `path` for a configured
 * `/{locale}` prefix, `negotiated` for the `resolveLocale` callback's
 * choice, and `default` when nothing chose one (no callback, or one that
 * returned nothing usable). `vary` lists the request headers the decision
 * read and `cookie` says whether it read a cookie; a negotiated default keeps
 * them, because the request still decided it.
 */
export interface LocaleDecision {
  readonly locale: string;
  readonly source: 'path' | 'default' | 'negotiated';
  readonly vary: readonly string[];
  readonly cookie: boolean;
}

/** The ambient i18n service backed by a loader and per-locale translator cache. */
export interface I18nService {
  t(key: string, arg?: TranslationParams | TranslationOptions): string;
  t(keys: readonly string[], options?: TranslationOptions): string[];
  tChoice(key: string, count: number, arg?: TranslationParams | TranslationOptions): string;
  exists(key: string, options?: Pick<TranslationOptions, 'scope'>): boolean;
  localize(value: Date | number, options?: LocalizeOptions): string;
  /** Alias of {@link localize}. */
  l(value: Date | number, options?: LocalizeOptions): string;
  /** The resolved locale for the current request (or the default). */
  locale(): string;
  /** The configured fallback locale. */
  fallbackLocale(): string;
  /** Return a translator pinned to an explicit locale (bypasses the ambient scope). */
  withLocale(locale: string): Translator;
  /** Locales the loader can serve. */
  availableLocales(): readonly string[];
  /**
   * Decide the request locale from the incoming Request and its route's URL
   * and params. Uses the plugin's configured `resolveLocale` callback and
   * negotiates its answer against the served locales; falls back to the
   * default locale when no callback is configured, when it throws or
   * rejects, or when it names no served locale. Never throws: a misbehaving
   * resolver yields the default, not an error.
   */
  resolveRequestLocale(
    request: Request,
    context: { readonly url: URL; readonly params: Record<string, string> },
  ): Promise<LocaleDecision>;
}
