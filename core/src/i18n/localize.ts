/**
 * Value localisation: date, time, datetime, number, currency, and percent
 * formatting built on `Intl` (dependency-free, browser-safe).
 *
 * The translator's `localize`/`l` methods delegate to a localizer built once
 * in the constructor. Callers that need a standalone formatter call
 * `createLocalizer(locale)` directly.
 *
 * Deliberate limit: no `strftime`-style format strings — expose `Intl` option
 * fields instead.
 */

import { I18nError, type I18nErrorCode } from './translator.js';

/** What kind of value is being localised. */
export type LocalizeKind = 'date' | 'time' | 'datetime' | 'number' | 'currency' | 'percent';

/** Options accepted by a localizer call. */
export interface LocalizeOptions {
  /** The value kind. Defaults to `'date'` for a `Date`, `'number'` for a number. */
  readonly kind?: LocalizeKind;
  /** ISO 4217 code, required when `kind: 'currency'`. */
  readonly currency?: string;
  /** BCP-47 locale override; defaults to the translator's active locale. */
  readonly locale?: string;
  /** `Intl.DateTimeFormat` options, passed through. */
  readonly dateStyle?: 'full' | 'long' | 'medium' | 'short';
  readonly timeStyle?: 'full' | 'long' | 'medium' | 'short';
  /** `Intl.NumberFormat` options, passed through. */
  readonly minimumFractionDigits?: number;
  readonly maximumFractionDigits?: number;
  readonly timeZone?: string;
}

/** The error a locale check raises: `invalid_locale` at construction, `invalid_localize_options` for a per-call override. */
interface LocaleFailure {
  readonly code: I18nErrorCode;
  readonly message: string;
}

const INVALID_LOCALE: LocaleFailure = Object.freeze({
  code: 'invalid_locale',
  message: 'invalid locale',
});

const INVALID_OVERRIDE_LOCALE: LocaleFailure = Object.freeze({
  code: 'invalid_localize_options',
  message: 'invalid localize options',
});

/**
 * Upper bound on cached formatters and validated override locales. The option
 * space a page uses is tiny, so a few hundred entries cover it; the bound
 * keeps a request-controlled locale override from growing the caches forever.
 */
const CACHE_LIMIT = 256;

/** Constructing an `Intl` formatter costs ~50x a format call, so formatters are reused. */
const formatters = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();

/** Override locales that already passed {@link assertValidLocale}. */
const validatedOverrides = new Set<string>();

/** Insert into a bounded insertion-ordered cache, evicting the oldest entry. */
function remember<K, V>(cache: Map<K, V>, key: K, value: V): V {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, value);
  return value;
}

/** A cached formatter for `key`, built (and validated) once by `build`. */
function formatter<T extends Intl.DateTimeFormat | Intl.NumberFormat>(
  key: string,
  build: () => T,
): T {
  const cached = formatters.get(key);
  if (cached !== undefined) return cached as T;
  let built: T;
  try {
    built = build();
  } catch {
    throw new I18nError('invalid_localize_options', 'invalid localize options');
  }
  remember(formatters, key, built);
  return built;
}

/**
 * Validate a BCP-47 locale through `Intl.PluralRules`, mirroring the
 * constructor-level check in `MessageTranslator`.
 */
function assertValidLocale(locale: string, failure: LocaleFailure = INVALID_LOCALE): void {
  if (typeof locale !== 'string' || locale.length === 0) {
    throw new I18nError(failure.code, failure.message);
  }
  try {
    // PluralRules is the strictest Intl check: it throws a RangeError for a
    // malformed or empty tag and never falls back silently.
    void new Intl.PluralRules(locale);
  } catch {
    throw new I18nError(failure.code, failure.message);
  }
}

/**
 * Build a locale-bound localizer. The returned function is pure and performs
 * no I/O — every call resolves through `Intl` formatters.
 */
export function createLocalizer(
  locale: string,
): (value: Date | number, options?: LocalizeOptions) => string {
  assertValidLocale(locale);
  return (value: Date | number, options?: LocalizeOptions): string => {
    const kind = options?.kind ?? (value instanceof Date ? 'date' : 'number');
    const effectiveLocale = options?.locale ?? locale;

    // Validate the effective locale when it differs from the constructed one,
    // once per distinct override.
    if (
      options?.locale !== undefined &&
      options.locale !== locale &&
      !validatedOverrides.has(options.locale)
    ) {
      assertValidLocale(options.locale, INVALID_OVERRIDE_LOCALE);
      if (validatedOverrides.size >= CACHE_LIMIT) validatedOverrides.clear();
      validatedOverrides.add(options.locale);
    }

    switch (kind) {
      case 'date':
      case 'time':
      case 'datetime': {
        const formatOptions: Intl.DateTimeFormatOptions = {};
        if (options?.timeZone !== undefined) {
          formatOptions.timeZone = options.timeZone;
        }
        if (kind === 'datetime') {
          formatOptions.dateStyle = options?.dateStyle ?? 'long';
          formatOptions.timeStyle = options?.timeStyle ?? 'short';
        } else if (kind === 'date') {
          formatOptions.dateStyle = options?.dateStyle ?? 'long';
        } else {
          formatOptions.timeStyle = options?.timeStyle ?? 'short';
        }
        const key = JSON.stringify([
          'dt',
          effectiveLocale,
          formatOptions.dateStyle,
          formatOptions.timeStyle,
          formatOptions.timeZone,
        ]);
        const format = formatter(
          key,
          () => new Intl.DateTimeFormat(effectiveLocale, formatOptions),
        );
        try {
          return format.format(value);
        } catch {
          throw new I18nError('invalid_localize_options', 'invalid localize options');
        }
      }

      case 'currency': {
        if (options?.currency === undefined || options.currency.length === 0) {
          throw new I18nError('missing_currency', 'currency code required');
        }
        const currency = options.currency;
        return formatNumber(effectiveLocale, value, {
          style: 'currency',
          currency,
          minimumFractionDigits: options.minimumFractionDigits,
          maximumFractionDigits: options.maximumFractionDigits,
        });
      }

      case 'percent':
        return formatNumber(effectiveLocale, value, {
          style: 'percent',
          minimumFractionDigits: options?.minimumFractionDigits,
          maximumFractionDigits: options?.maximumFractionDigits,
        });

      case 'number':
        return formatNumber(effectiveLocale, value, {
          minimumFractionDigits: options?.minimumFractionDigits,
          maximumFractionDigits: options?.maximumFractionDigits,
        });

      default:
        throw new I18nError('invalid_localize_options', 'invalid localize options');
    }
  };
}

/** Format a number through a cached `Intl.NumberFormat` keyed by locale and options. */
function formatNumber(
  locale: string,
  value: Date | number,
  options: Intl.NumberFormatOptions,
): string {
  const key = JSON.stringify([
    'n',
    locale,
    options.style,
    options.currency,
    options.minimumFractionDigits,
    options.maximumFractionDigits,
  ]);
  const format = formatter(key, () => new Intl.NumberFormat(locale, options));
  try {
    return format.format(value as number);
  } catch {
    throw new I18nError('invalid_localize_options', 'invalid localize options');
  }
}
