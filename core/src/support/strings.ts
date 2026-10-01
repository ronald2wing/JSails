import { isNonNegativeInteger, isPositiveInteger, isString } from '../internal/primitive-guards.js';
import {
  camelCase,
  constantCase,
  kebabCase,
  pascalCase,
  snakeCase,
  startCase,
} from 'es-toolkit/string';
import slugifyLib from 'slugify';

import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export class StrError extends SupportError {
  readonly code = 'invalid_argument';
}

// ---------------------------------------------------------------------------
// Validation helpers (value-free — never echo the offending value)
// ---------------------------------------------------------------------------

function assertString(value: unknown, operation: string): asserts value is string {
  if (!isString(value)) {
    throw new StrError(`Str.${operation}: expected a string`);
  }
}

function assertPositiveInteger(value: unknown, operation: string): asserts value is number {
  if (!isPositiveInteger(value)) {
    throw new StrError(`Str.${operation}: expected a positive integer`);
  }
}

function assertNonNegativeInteger(value: unknown, operation: string): asserts value is number {
  if (!isNonNegativeInteger(value)) {
    throw new StrError(`Str.${operation}: expected a non-negative integer`);
  }
}

// ---------------------------------------------------------------------------
// Wraps: es-toolkit/string
// ---------------------------------------------------------------------------

export function camel(value: string): string {
  assertString(value, 'camel');
  return camelCase(value);
}

export function pascal(value: string): string {
  assertString(value, 'pascal');
  return pascalCase(value);
}

export function snake(value: string): string {
  assertString(value, 'snake');
  return snakeCase(value);
}

export function kebab(value: string): string {
  assertString(value, 'kebab');
  return kebabCase(value);
}

export function constant(value: string): string {
  assertString(value, 'constant');
  return constantCase(value);
}

export function title(value: string): string {
  assertString(value, 'title');
  return startCase(value);
}

export function capitalize(value: string): string {
  assertString(value, 'capitalize');
  return value === '' ? '' : value.charAt(0).toUpperCase() + value.slice(1);
}

export function uncapitalize(value: string): string {
  assertString(value, 'uncapitalize');
  return value === '' ? '' : value.charAt(0).toLowerCase() + value.slice(1);
}

// ---------------------------------------------------------------------------
// Own: English pluralization
// ---------------------------------------------------------------------------

const IRREGULAR_PLURALS: Readonly<Record<string, string>> = Object.freeze({
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
  tooth: 'teeth',
  foot: 'feet',
  mouse: 'mice',
  goose: 'geese',
  ox: 'oxen',
});

const IRREGULAR_SINGULARS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(IRREGULAR_PLURALS).map(([one, many]) => [many, one])),
);

// Words that are spelled the same in both numbers.
const INVARIANT_WORDS = new Set([
  'aircraft',
  'deer',
  'equipment',
  'fish',
  'information',
  'money',
  'news',
  'rice',
  'series',
  'sheep',
  'species',
]);

// -f/-fe words that take -ves. Everything else ending in f/fe takes -s.
const F_TO_VES = new Set([
  'calf',
  'dwarf',
  'elf',
  'half',
  'knife',
  'leaf',
  'life',
  'loaf',
  'scarf',
  'self',
  'sheaf',
  'shelf',
  'thief',
  'wife',
  'wolf',
]);

const VES_TO_SINGULAR: Readonly<Record<string, string>> = Object.freeze({
  calves: 'calf',
  dwarves: 'dwarf',
  elves: 'elf',
  halves: 'half',
  knives: 'knife',
  leaves: 'leaf',
  lives: 'life',
  loaves: 'loaf',
  scarves: 'scarf',
  selves: 'self',
  sheaves: 'sheaf',
  shelves: 'shelf',
  thieves: 'thief',
  wives: 'wife',
  wolves: 'wolf',
});

// Singular words ending in -s that must not be mistaken for plurals.
const SINGULAR_S_WORDS = new Set(['gas']);

function isVowel(char: string): boolean {
  return 'aeiou'.includes(char);
}

function matchFirstLetterCase(source: string, result: string): string {
  const first = source.charAt(0);
  if (first !== '' && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return result.charAt(0).toUpperCase() + result.slice(1);
  }
  return result;
}

function isAlreadyPlural(lower: string): boolean {
  if (INVARIANT_WORDS.has(lower)) return true;
  if (Object.hasOwn(IRREGULAR_SINGULARS, lower)) return true;
  if (!lower.endsWith('s')) return false;
  if (lower.endsWith('ss') || lower.endsWith('us') || lower.endsWith('is')) return false;
  if (SINGULAR_S_WORDS.has(lower)) return false;
  if (lower.endsWith('ies') || lower.endsWith('ves')) return true;
  if (lower.endsWith('es')) {
    const stem = lower.slice(0, -2);
    return /(?:s|x|z|ch|sh)$/.test(stem);
  }
  return true;
}

function isAlreadySingular(lower: string): boolean {
  if (INVARIANT_WORDS.has(lower)) return true;
  if (Object.hasOwn(IRREGULAR_PLURALS, lower)) return true;
  if (Object.hasOwn(IRREGULAR_SINGULARS, lower)) return false;
  if (!lower.endsWith('s')) return true;
  if (lower.endsWith('ss') || lower.endsWith('us') || lower.endsWith('is')) return true;
  if (SINGULAR_S_WORDS.has(lower)) return true;
  return false;
}

function pluralizeWord(word: string): string {
  if (word === '') return '';
  const lower = word.toLowerCase();
  if (isAlreadyPlural(lower)) return word;

  const irregular = IRREGULAR_PLURALS[lower];
  if (irregular !== undefined) return matchFirstLetterCase(word, irregular);

  if (lower.endsWith('y') && lower.length > 1 && !isVowel(lower.charAt(lower.length - 2))) {
    return word.slice(0, -1) + 'ies';
  }
  if (/(?:s|x|z|ch|sh)$/.test(lower)) return word + 'es';
  if (lower.endsWith('fe') && F_TO_VES.has(lower)) {
    return word.slice(0, -2) + 'ves';
  }
  if (lower.endsWith('f') && F_TO_VES.has(lower)) {
    return word.slice(0, -1) + 'ves';
  }
  return word + 's';
}

function singularizeWord(word: string): string {
  if (word === '') return '';
  const lower = word.toLowerCase();
  if (isAlreadySingular(lower)) return word;

  const irregular = IRREGULAR_SINGULARS[lower];
  if (irregular !== undefined) return matchFirstLetterCase(word, irregular);

  const ves = VES_TO_SINGULAR[lower];
  if (ves !== undefined) return matchFirstLetterCase(word, ves);

  if (lower.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (lower.endsWith('es')) {
    const stem = lower.slice(0, -2);
    if (/(?:s|x|z|ch|sh)$/.test(stem)) return word.slice(0, -2);
  }
  if (lower.endsWith('s')) return word.slice(0, -1);
  return word;
}

/**
 * Pluralize (or singularize, when `count` is `1`) an English word.
 *
 * `count` defaults to `2`, so `plural('post')` is `'posts'` and
 * `plural('post', 1)` is `'post'`.
 */
export function plural(word: string, count = 2): string {
  assertString(word, 'plural');
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new StrError('Str.plural: expected a finite count');
  }
  return count === 1 ? singularizeWord(word) : pluralizeWord(word);
}

export function singular(word: string): string {
  assertString(word, 'singular');
  return singularizeWord(word);
}

// ---------------------------------------------------------------------------
// Wraps: slugify
// ---------------------------------------------------------------------------

export function slug(value: string, options?: Record<string, unknown>): string {
  assertString(value, 'slug');
  return slugifyLib(value, options ?? {});
}

// ---------------------------------------------------------------------------
// Own: truncate
// ---------------------------------------------------------------------------

const DEFAULT_ELLIPSIS = '\u2026'; // …

export function truncate(value: string, length: number, options?: { ellipsis?: string }): string {
  assertString(value, 'truncate');
  assertPositiveInteger(length, 'truncate');

  const ellipsis = options?.ellipsis ?? DEFAULT_ELLIPSIS;

  if (value.length <= length) return value;

  const keepLength = length - ellipsis.length;
  if (keepLength <= 0) return ellipsis.slice(0, length);

  return value.slice(0, keepLength) + ellipsis;
}

// ---------------------------------------------------------------------------
// Own: excerpt (word-boundary-aware truncation)
// ---------------------------------------------------------------------------

export function excerpt(value: string, length: number): string {
  assertString(value, 'excerpt');
  assertPositiveInteger(length, 'excerpt');

  if (value.length <= length) return value;

  // Find the last whitespace at or before the limit.
  const slice = value.slice(0, length);
  const lastSpace = /\s(?=\S*$)/.exec(slice);

  if (!lastSpace || lastSpace.index === 0) {
    // No word boundary found — hard cut.
    return value.slice(0, length) + '...';
  }

  return value.slice(0, lastSpace.index) + '...';
}

// ---------------------------------------------------------------------------
// Own: words
// ---------------------------------------------------------------------------

export function words(value: string): string[] {
  assertString(value, 'words');
  return value.trim() === '' ? [] : value.trim().split(/\s+/);
}

// ---------------------------------------------------------------------------
// Own: limit (hard cut, no ellipsis)
// ---------------------------------------------------------------------------

export function limit(value: string, length: number): string {
  assertString(value, 'limit');
  assertPositiveInteger(length, 'limit');
  return value.slice(0, length);
}

// ---------------------------------------------------------------------------
// Own: text hygiene
// ---------------------------------------------------------------------------

/**
 * C0 control characters plus DEL. Every place that accepts a path, host, tag,
 * image reference, or header name from configuration must reject these: they
 * are invisible, they break log and terminal output, and in a header or path
 * they are a request-splitting vector. One shared pattern keeps the check from
 * drifting between the CLI, deploy, jamal, and plugin validators.
 */
export const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** Collapse every run of whitespace to one space and trim the ends. */
export function squish(value: string): string {
  assertString(value, 'squish');
  return value.trim().replace(/\s+/g, ' ');
}

/** Normalize CRLF and CR line endings to LF. */
export function normalizeNewlines(value: string): string {
  assertString(value, 'normalizeNewlines');
  return value.replace(/\r\n?/g, '\n');
}

/**
 * Remove simple HTML tags, leaving text entities untouched.
 *
 * This is a string operation, not an HTML parser: script/style content is
 * text to it, and malformed markup may not strip as expected. Use a real
 * parser when the input is hostile.
 */
export function stripTags(value: string): string {
  assertString(value, 'stripTags');
  return value.replace(/<[^>]*>/g, '');
}

/**
 * Turn an identifier into a human label: `'post_id'` becomes `'Post id'`.
 *
 * Separators become spaces, camel-case boundaries are split, and the rest is
 * lowercased so only the first letter is capitalized.
 */
export function humanize(value: string): string {
  assertString(value, 'humanize');
  const spaced = value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/\s+/g, ' ');
  if (spaced === '') return '';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Wrap a block of text at word boundaries, preserving existing newlines.
 *
 * A word longer than `width` is kept intact rather than split.
 */
export function wrap(value: string, width: number): string {
  assertString(value, 'wrap');
  assertPositiveInteger(width, 'wrap');
  return value
    .split('\n')
    .map((line) => wrapLine(line, width))
    .join('\n');
}

function wrapLine(line: string, width: number): string {
  if (line.length <= width) return line;

  const lines: string[] = [];
  let current = '';

  for (const word of line.split(/\s+/).filter(Boolean)) {
    if (current === '') {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current !== '') lines.push(current);
  return lines.join('\n');
}

/**
 * True when a value is `null`, `undefined`, or a whitespace-only string.
 *
 * Every other value (including `0`, `false`, and empty arrays) is present.
 */
export function isBlank(value: unknown): boolean {
  return (
    value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
  );
}

export function isPresent(value: unknown): boolean {
  return !isBlank(value);
}

// ---------------------------------------------------------------------------
// Own: escapeHtml / unescapeHtml (exactly five entities)
// ---------------------------------------------------------------------------

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const ESCAPE_RE = /[&<>"']/g;

export function escapeHtml(value: string): string {
  assertString(value, 'escapeHtml');
  return value.replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]!);
}

const UNESCAPE_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
};

const UNESCAPE_RE = /&(?:amp|lt|gt|quot|#39|#x27|apos);/g;

export function unescapeHtml(value: string): string {
  assertString(value, 'unescapeHtml');
  return value.replace(UNESCAPE_RE, (entity) => UNESCAPE_MAP[entity] ?? entity);
}

// ---------------------------------------------------------------------------
// Own: random (crypto.getRandomValues)
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const DEFAULT_RANDOM_LENGTH = 16;

export function random(length?: number): string {
  if (length === undefined) length = DEFAULT_RANDOM_LENGTH;
  assertNonNegativeInteger(length, 'random');

  if (length === 0) return '';

  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);

  let result = '';
  for (let i = 0; i < length; i++) {
    result += ALPHABET[bytes[i]! % ALPHABET.length]!;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Own: mask
// ---------------------------------------------------------------------------

const DEFAULT_MASK_CHAR = '*';

export function mask(
  value: string,
  options?: { maskChar?: string; revealLeading?: number; revealTrailing?: number },
): string {
  assertString(value, 'mask');

  const maskChar = options?.maskChar ?? DEFAULT_MASK_CHAR;
  const revealLeading = options?.revealLeading ?? 0;
  const revealTrailing = options?.revealTrailing ?? 0;

  if (typeof maskChar !== 'string' || maskChar.length !== 1) {
    throw new StrError('Str.mask: maskChar must be a single character');
  }
  if (typeof revealLeading !== 'number' || !Number.isInteger(revealLeading) || revealLeading < 0) {
    throw new StrError('Str.mask: revealLeading must be a non-negative integer');
  }
  if (
    typeof revealTrailing !== 'number' ||
    !Number.isInteger(revealTrailing) ||
    revealTrailing < 0
  ) {
    throw new StrError('Str.mask: revealTrailing must be a non-negative integer');
  }

  if (value.length === 0) return '';

  if (revealLeading + revealTrailing >= value.length) return value;

  const lead = value.slice(0, revealLeading);
  const trail = value.slice(-revealTrailing || value.length);
  const masked = maskChar.repeat(value.length - revealLeading - revealTrailing);

  return lead + masked + trail;
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Str = Object.freeze({
  camel,
  pascal,
  snake,
  kebab,
  constant,
  title,
  capitalize,
  uncapitalize,
  slug,
  plural,
  singular,
  truncate,
  excerpt,
  words,
  limit,
  squish,
  normalizeNewlines,
  stripTags,
  humanize,
  wrap,
  isBlank,
  isPresent,
  escapeHtml,
  unescapeHtml,
  CONTROL_CHARS,
  random,
  mask,
});
