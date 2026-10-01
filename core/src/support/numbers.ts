/**
 * The `Num` namespace: locale-aware number, currency, percent, unit, and byte formatting plus parsing, rounding, and clamping.
 */

import { assertString, type ArgumentErrorFactory } from '../validation/primitives.js';
import { formatBytes } from './bytes.js';
import {
  dinero,
  add as dineroAdd,
  subtract as dineroSubtract,
  compare as dineroCompare,
  toSnapshot,
  type Dinero,
  type DineroCurrency,
} from 'dinero.js';
import * as allCurrencies from 'dinero.js/currencies';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

// ---------------------------------------------------------------------------
// Currency lookup (built once at module load)
// ---------------------------------------------------------------------------

type CurrencyObject = DineroCurrency<number, string>;

const currencyByCode: Record<string, CurrencyObject> = {};

for (const [key, value] of Object.entries(allCurrencies)) {
  if (
    value !== null &&
    typeof value === 'object' &&
    'code' in value &&
    'exponent' in value &&
    typeof (value as Record<string, unknown>).code === 'string'
  ) {
    currencyByCode[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const NUM_ERRORS = {
  expected_string: {
    kind: 'internal',
    message: '{operation}: expected a string',
    context: { operation: 'identifier' },
  },
  expected_finite_number: {
    kind: 'internal',
    message: 'Num: expected a finite number',
  },
  unknown_currency: {
    kind: 'internal',
    message: 'Num: unknown currency code',
    suggestion: 'pass an ISO 4217 currency code, such as USD or EUR',
  },
  expected_integer: {
    kind: 'internal',
    message: 'Num.ordinal: expected an integer',
  },
  inverted_range: {
    kind: 'internal',
    message: 'Num.clamp: min must not exceed max',
  },
  invalid_precision: {
    kind: 'internal',
    message: 'Num.round: precision must be a non-negative integer',
  },
  empty_input: {
    kind: 'invalid',
    message: 'Num.parse: cannot parse an empty string as a number',
  },
  not_a_number: {
    kind: 'invalid',
    message: 'Num.parse: cannot parse the value as a finite number',
  },
  missing_currency: {
    kind: 'internal',
    message: 'Num.formatMoney: a currency option is required for non-Money input',
  },
  invalid_minor_units: {
    kind: 'internal',
    message: 'Num.formatMoney: minorUnits must be a non-negative integer',
  },
} as const;

/**
 * The `Num` namespace's codes, `num.*`: an argument of the wrong type or range
 * (`internal`, the calling code's bug) and input `Num.parse` cannot read
 * (`invalid`). None echoes the value.
 *
 * @public
 */
export const NumErrors: ErrorRegistry<'num', typeof NUM_ERRORS> = defineErrors('num', NUM_ERRORS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertNumber(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new NumErrors.Error('expected_finite_number');
  }
}

const numError: ArgumentErrorFactory<'expected_string'> = (problem, operation) =>
  new NumErrors.Error(problem, { operation });

function isDinero(value: unknown): value is Dinero<number> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getCurrencyExponent(currencyCode: string): number {
  const descriptor = currencyByCode[currencyCode];
  if (!descriptor) {
    throw new NumErrors.Error('unknown_currency');
  }
  return descriptor.exponent;
}

// ---------------------------------------------------------------------------
// Native Intl wrappers
// ---------------------------------------------------------------------------

export function format(value: number, options?: Intl.NumberFormatOptions, locale?: string): string {
  assertNumber(value);
  return new Intl.NumberFormat(locale, options).format(value);
}

export function compact(value: number, locale?: string): string {
  assertNumber(value);
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    compactDisplay: 'short',
  }).format(value);
}

export function currency(value: number, currencyCode: string, locale?: string): string {
  assertNumber(value);
  assertString(currencyCode, 'Num.currency', numError);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
  }).format(value);
}

export function percent(
  value: number,
  options?: Intl.NumberFormatOptions,
  locale?: string,
): string {
  assertNumber(value);
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    ...options,
  }).format(value);
}

export function unit(
  value: number,
  unitName: string,
  options?: Intl.NumberFormatOptions,
  locale?: string,
): string {
  assertNumber(value);
  assertString(unitName, 'Num.unit', numError);
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: unitName,
    ...options,
  }).format(value);
}

// ---------------------------------------------------------------------------
// Own: byte formatting
// ---------------------------------------------------------------------------

export function bytes(value: number, options?: { binary?: boolean }): string {
  assertNumber(value);
  return formatBytes(value, options);
}

// ---------------------------------------------------------------------------
// Intl.PluralRules wrapper
// ---------------------------------------------------------------------------

export function ordinal(value: number, locale?: string): string {
  assertNumber(value);
  if (!Number.isInteger(value)) {
    throw new NumErrors.Error('expected_integer');
  }
  const rules = new Intl.PluralRules(locale ?? 'en', { type: 'ordinal' });
  const suffix = rules.select(value);
  return `${value}${getOrdinalSuffix(locale ?? 'en', value, suffix)}`;
}

function getOrdinalSuffix(locale: string, _value: number, category: string): string {
  // For most locales we can use the CLDR-derived ordinal patterns.
  // English is the common case — map plural categories to suffixes.
  if (locale.startsWith('en')) {
    switch (category) {
      case 'one':
        return 'st';
      case 'two':
        return 'nd';
      case 'few':
        return 'rd';
      default:
        return 'th';
    }
  }
  // Intl exposes plural categories but not ordinal suffix text, so other
  // locales get a trailing dot, the most widespread ordinal mark.
  return '.';
}

// ---------------------------------------------------------------------------
// Own helpers
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  assertNumber(value);
  assertNumber(min);
  assertNumber(max);
  if (min > max) {
    throw new NumErrors.Error('inverted_range');
  }
  return Math.min(Math.max(value, min), max);
}

export function round(value: number, precision?: number): number {
  assertNumber(value);
  const p = precision ?? 0;
  if (!Number.isInteger(p) || p < 0) {
    throw new NumErrors.Error('invalid_precision');
  }
  const factor = 10 ** p;
  return Math.round(value * factor) / factor;
}

export function parse(input: string): number {
  assertString(input, 'Num.parse', numError);
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new NumErrors.Error('empty_input');
  }
  const result = Number(trimmed);
  if (!Number.isFinite(result)) {
    throw new NumErrors.Error('not_a_number');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Money arithmetic (dinero.js)
// ---------------------------------------------------------------------------

export function money(amount: number | string, currencyCode: string): Dinero<number> {
  const exponent = getCurrencyExponent(currencyCode);
  const numeric = typeof amount === 'string' ? parse(amount) : amount;
  assertNumber(numeric);

  const minorUnits = Math.round(numeric * 10 ** exponent);
  const currencyObj = currencyByCode[currencyCode]!;

  return dinero({
    amount: minorUnits,
    currency: currencyObj,
  });
}

// Arithmetic on `money` values, re-exported so callers compose through `Num`
// without importing `dinero.js` directly (sovereign-surface rule, design §1.1).
export const add: typeof dineroAdd = dineroAdd;
export const subtract: typeof dineroSubtract = dineroSubtract;
export const compare: typeof dineroCompare = dineroCompare;

// ---------------------------------------------------------------------------
// Money display (Intl.NumberFormat + accounting/minor-unit gaps)
// ---------------------------------------------------------------------------

export interface FormatMoneyOptions {
  readonly locale?: string;
  readonly accounting?: boolean;
  readonly minorUnits?: number;
  readonly currency?: string;
}

export function formatMoney(
  amount: Dinero<number> | number | string,
  options: FormatMoneyOptions,
): string {
  let numericValue: number;
  let currencyCode: string;
  let exponent: number;

  if (isDinero(amount)) {
    const snap = toSnapshot(amount);
    exponent = options.minorUnits ?? snap.currency.exponent;
    numericValue = snap.amount / 10 ** snap.currency.exponent;
    currencyCode = snap.currency.code;
  } else {
    numericValue = typeof amount === 'string' ? parse(amount) : amount;
    assertNumber(numericValue);
    if (!options.currency) {
      throw new NumErrors.Error('missing_currency');
    }
    currencyCode = options.currency;
    exponent = options.minorUnits ?? getCurrencyExponent(currencyCode);
  }

  if (!Number.isFinite(exponent) || exponent < 0) {
    throw new NumErrors.Error('invalid_minor_units');
  }

  const formatOptions: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  };

  if (options.accounting) {
    formatOptions.currencySign = 'accounting';
  }

  return new Intl.NumberFormat(options.locale, formatOptions).format(numericValue);
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Num: Readonly<{
  format: typeof format;
  compact: typeof compact;
  currency: typeof currency;
  percent: typeof percent;
  unit: typeof unit;
  bytes: typeof bytes;
  ordinal: typeof ordinal;
  clamp: typeof clamp;
  round: typeof round;
  parse: typeof parse;
  money: typeof money;
  add: typeof add;
  subtract: typeof subtract;
  compare: typeof compare;
  formatMoney: typeof formatMoney;
}> = Object.freeze({
  format,
  compact,
  currency,
  percent,
  unit,
  bytes,
  ordinal,
  clamp,
  round,
  parse,
  money,
  add,
  subtract,
  compare,
  formatMoney,
});
