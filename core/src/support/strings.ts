/**
 * The `Str` namespace: case conversion, slugs, truncation, masking, pluralization, and the other string helpers.
 */

import {
  assertString,
  assertPositiveInteger,
  assertNonNegativeInteger,
  type ArgumentErrorFactory,
} from '../validation/primitives.js';
import {
  camelCase,
  constantCase,
  kebabCase,
  pascalCase,
  snakeCase,
  startCase,
} from 'es-toolkit/string';
import slugifyLib from 'slugify';

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

const STR_ERRORS = {
  expected_string: {
    kind: 'internal',
    message: '{operation}: expected a string',
    context: { operation: 'identifier' },
  },
  expected_positive_integer: {
    kind: 'internal',
    message: '{operation}: expected a positive integer',
    context: { operation: 'identifier' },
  },
  expected_non_negative_integer: {
    kind: 'internal',
    message: '{operation}: expected a non-negative integer',
    context: { operation: 'identifier' },
  },
  invalid_count: {
    kind: 'internal',
    message: 'Str.plural: expected a finite count',
  },
  invalid_mask_option: {
    kind: 'internal',
    message: 'Str.mask: {option} is invalid',
    context: { option: ['maskChar', 'revealLeading', 'revealTrailing'] },
    suggestion:
      'maskChar is a single character; revealLeading and revealTrailing are non-negative integers',
  },
} as const;

/**
 * The `Str` namespace's codes, `str.*`: an argument of the wrong type or
 * range. Every one is the calling code's bug, and none echoes the argument.
 *
 * @public
 */
export const StrErrors: ErrorRegistry<'str', typeof STR_ERRORS> = defineErrors('str', STR_ERRORS);

const strError: ArgumentErrorFactory = (problem, operation) =>
  new StrErrors.Error(problem, { operation });

// ---------------------------------------------------------------------------
// Wraps: es-toolkit/string
// ---------------------------------------------------------------------------

export function camel(value: string): string {
  assertString(value, 'Str.camel', strError);
  return camelCase(value);
}

export function pascal(value: string): string {
  assertString(value, 'Str.pascal', strError);
  return pascalCase(value);
}

export function snake(value: string): string {
  assertString(value, 'Str.snake', strError);
  return snakeCase(value);
}

export function kebab(value: string): string {
  assertString(value, 'Str.kebab', strError);
  return kebabCase(value);
}

export function constant(value: string): string {
  assertString(value, 'Str.constant', strError);
  return constantCase(value);
}

export function title(value: string): string {
  assertString(value, 'Str.title', strError);
  return startCase(value);
}

export function capitalize(value: string): string {
  assertString(value, 'Str.capitalize', strError);
  return value === '' ? '' : value.charAt(0).toUpperCase() + value.slice(1);
}

export function uncapitalize(value: string): string {
  assertString(value, 'Str.uncapitalize', strError);
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
  assertString(word, 'Str.plural', strError);
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new StrErrors.Error('invalid_count');
  }
  return count === 1 ? singularizeWord(word) : pluralizeWord(word);
}

export function singular(word: string): string {
  assertString(word, 'Str.singular', strError);
  return singularizeWord(word);
}

// ---------------------------------------------------------------------------
// Wraps: slugify
// ---------------------------------------------------------------------------

export function slug(value: string, options?: Record<string, unknown>): string {
  assertString(value, 'Str.slug', strError);
  return slugifyLib(value, options ?? {});
}

// ---------------------------------------------------------------------------
// Own: truncate
// ---------------------------------------------------------------------------

const DEFAULT_ELLIPSIS = '\u2026'; // …

export function truncate(value: string, length: number, options?: { ellipsis?: string }): string {
  assertString(value, 'Str.truncate', strError);
  assertPositiveInteger(length, 'Str.truncate', strError);

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
  assertString(value, 'Str.excerpt', strError);
  assertPositiveInteger(length, 'Str.excerpt', strError);

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
  assertString(value, 'Str.words', strError);
  return value.trim() === '' ? [] : value.trim().split(/\s+/);
}

// ---------------------------------------------------------------------------
// Own: limit (hard cut, no ellipsis)
// ---------------------------------------------------------------------------

export function limit(value: string, length: number): string {
  assertString(value, 'Str.limit', strError);
  assertPositiveInteger(length, 'Str.limit', strError);
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
 * drifting between the CLI, plugin, and `@jsails/jamal` validators.
 */
export const CONTROL_CHARS: RegExp = /[\u0000-\u001F\u007F]/;

/** Collapse every run of whitespace to one space and trim the ends. */
export function squish(value: string): string {
  assertString(value, 'Str.squish', strError);
  return value.trim().replace(/\s+/g, ' ');
}

/** Normalize CRLF and CR line endings to LF. */
export function normalizeNewlines(value: string): string {
  assertString(value, 'Str.normalizeNewlines', strError);
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
  assertString(value, 'Str.stripTags', strError);
  return value.replace(/<[^>]*>/g, '');
}

/**
 * Turn an identifier into a human label: `'post_id'` becomes `'Post id'`.
 *
 * Separators become spaces, camel-case boundaries are split, and the rest is
 * lowercased so only the first letter is capitalized.
 */
export function humanize(value: string): string {
  assertString(value, 'Str.humanize', strError);
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
  assertString(value, 'Str.wrap', strError);
  assertPositiveInteger(width, 'Str.wrap', strError);
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
  assertString(value, 'Str.escapeHtml', strError);
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
  assertString(value, 'Str.unescapeHtml', strError);
  return value.replace(UNESCAPE_RE, (entity) => UNESCAPE_MAP[entity] ?? entity);
}

// ---------------------------------------------------------------------------
// Own: random (crypto.getRandomValues)
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const DEFAULT_RANDOM_LENGTH = 16;

export function random(length?: number): string {
  if (length === undefined) length = DEFAULT_RANDOM_LENGTH;
  assertNonNegativeInteger(length, 'Str.random', strError);

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
  assertString(value, 'Str.mask', strError);

  const maskChar = options?.maskChar ?? DEFAULT_MASK_CHAR;
  const revealLeading = options?.revealLeading ?? 0;
  const revealTrailing = options?.revealTrailing ?? 0;

  if (typeof maskChar !== 'string' || maskChar.length !== 1) {
    throw new StrErrors.Error('invalid_mask_option', { option: 'maskChar' });
  }
  if (typeof revealLeading !== 'number' || !Number.isInteger(revealLeading) || revealLeading < 0) {
    throw new StrErrors.Error('invalid_mask_option', { option: 'revealLeading' });
  }
  if (
    typeof revealTrailing !== 'number' ||
    !Number.isInteger(revealTrailing) ||
    revealTrailing < 0
  ) {
    throw new StrErrors.Error('invalid_mask_option', { option: 'revealTrailing' });
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

export const Str: Readonly<{
  camel: typeof camel;
  pascal: typeof pascal;
  snake: typeof snake;
  kebab: typeof kebab;
  constant: typeof constant;
  title: typeof title;
  capitalize: typeof capitalize;
  uncapitalize: typeof uncapitalize;
  slug: typeof slug;
  plural: typeof plural;
  singular: typeof singular;
  truncate: typeof truncate;
  excerpt: typeof excerpt;
  words: typeof words;
  limit: typeof limit;
  squish: typeof squish;
  normalizeNewlines: typeof normalizeNewlines;
  stripTags: typeof stripTags;
  humanize: typeof humanize;
  wrap: typeof wrap;
  isBlank: typeof isBlank;
  isPresent: typeof isPresent;
  escapeHtml: typeof escapeHtml;
  unescapeHtml: typeof unescapeHtml;
  CONTROL_CHARS: typeof CONTROL_CHARS;
  random: typeof random;
  mask: typeof mask;
}> = Object.freeze({
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
