/**
 * The static attribute values Prettier's `vue` printer rewrites, in one
 * canonical form, so a template renders the same bytes before and after
 * `npm run format` (docs/design/sfc.md §5.1, §5.2).
 *
 * Prettier reprints the value of a static `class`, `style`, `srcset` (on
 * `<img>` and `<source>`) and `allow` (on `<iframe>`) attribute, and breaks
 * a long one across lines indented to the element's depth. The template
 * parser hands each such value through `printedAttributeValue`, which
 * reduces it to a form the original and every printing of it share, so what
 * a template renders does not depend on whether its file was formatted:
 *
 * - `class`: trimmed, each whitespace run one space (Prettier's own rule,
 *   whose whitespace is JavaScript's `\s`, so a U+00A0 inside a class name
 *   splits it, after formatting and here alike).
 * - `allow`: directives split at `;` and HTML whitespace, written `a b; c`.
 * - `srcset`: candidates read with the HTML standard's algorithm, which
 *   Prettier uses, written `url descriptor, url descriptor`, a number
 *   descriptor as JavaScript prints its value. A `0x` density is dropped, as
 *   Prettier drops it.
 * - `style`: declarations `property: value` joined by `; `, comments dropped,
 *   property and function names, units, hexadecimal colours and CSS-wide
 *   keywords lower-cased (custom property names keep their case), numbers
 *   as JavaScript prints their value, strings re-quoted, and whitespace
 *   canonical: one space between component values and around `*`, `+` and
 *   `-`, none inside brackets, around `/` or before a comma.
 *
 * Every rewrite keeps what the browser reads. Prettier's CSS printer is not
 * so careful with some constructs: it glues or splits words around a
 * backslash escape outside a string, around an `!important` that does not
 * end its declaration and inside a `url(` whose argument is not one string,
 * and next to a call (`a/f(x)`, `f(x)/a`) when `/` is not spaced on both
 * sides, and it turns a `+`-signed number into an addition. A `style` value holding
 * one of those, or anything else that is not a declaration list of plain
 * values (`{}`, an at-keyword, a stray delimiter, an operator outside a math
 * function), has no stable form and is reported `unstable`.
 *
 * `printed-attributes.test.ts` formats a seeded sweep of values with the
 * installed Prettier at several widths, depths and quote styles and checks
 * that each output reduces to its input's form.
 */

/** A static value as a template renders it. */
export interface PrintedValue {
  readonly value: string;
  /**
   * Prettier would change what the value means, so no form survives
   * formatting (a `style` outside the stable subset).
   */
  readonly unstable: boolean;
}

const HTML_SPACE = /[ \t\n\f\r]+/;
const HTML_SPACE_EDGES = /^[ \t\n\f\r]+|[ \t\n\f\r]+$/g;

/** The value a static attribute renders. */
export function printedAttributeValue(tag: string, name: string, value: string): PrintedValue {
  switch (name) {
    case 'class':
      return stable(value.trim().replace(/\s+/g, ' '));
    case 'style':
      return canonicalStyle(value);
    case 'srcset':
      return stable(tag === 'img' || tag === 'source' ? canonicalSrcset(value) : value);
    case 'allow':
      return stable(tag === 'iframe' ? canonicalAllow(value) : value);
    default:
      return stable(value);
  }
}

function stable(value: string): PrintedValue {
  return { value, unstable: false };
}

function canonicalAllow(value: string): string {
  return value
    .split(';')
    .map((directive) => directive.replace(HTML_SPACE_EDGES, ''))
    .filter((directive) => directive !== '')
    .map((directive) => directive.split(HTML_SPACE).join(' '))
    .join('; ');
}

/** A number as JavaScript prints its value; `-0` is `0`. */
function canonicalNumber(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw.toLowerCase();
  return String(value === 0 ? 0 : value);
}

// ------------------------------------------------------------------ srcset

const SRCSET_SEPARATOR = /^[, \t\n\r\f]+/;
const SRCSET_URL = /^[^ \t\n\r\f]+/;
const SRCSET_SPACE = /^[ \t\n\r\f]+/;
const SRCSET_INTEGER = /^\d+$/;
const SRCSET_FLOAT = /^-?(?:[0-9]+|[0-9]*\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

const isHtmlSpace = (char: string): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\f' || char === '\r';

/** The candidates of a srcset (HTML standard), each as its URL and descriptor tokens. */
function srcsetCandidates(value: string): { url: string; descriptors: string[] }[] {
  const candidates: { url: string; descriptors: string[] }[] = [];
  let at = 0;
  const take = (pattern: RegExp): string => {
    const match = pattern.exec(value.slice(at));
    if (match === null) return '';
    at += match[0].length;
    return match[0];
  };
  for (;;) {
    take(SRCSET_SEPARATOR);
    if (at >= value.length) return candidates;
    const url = take(SRCSET_URL);
    const descriptors: string[] = [];
    candidates.push({ url: url.replace(/,+$/, ''), descriptors });
    if (url.endsWith(',')) continue;
    take(SRCSET_SPACE);
    let current = '';
    let inParens = false;
    for (; at < value.length; at += 1) {
      const char = value.charAt(at);
      if (inParens) {
        current += char;
        if (char === ')') inParens = false;
      } else if (isHtmlSpace(char)) {
        if (current !== '') descriptors.push(current);
        current = '';
      } else if (char === ',') {
        at += 1;
        break;
      } else {
        current += char;
        if (char === '(') inParens = true;
      }
    }
    if (current !== '') descriptors.push(current);
  }
}

/** A descriptor with its number as JavaScript prints it, or as written when it is not one. */
function canonicalDescriptor(descriptor: string): string | undefined {
  const suffix = descriptor.slice(-1);
  const number = descriptor.slice(0, -1);
  if ((suffix === 'w' || suffix === 'h') && SRCSET_INTEGER.test(number)) {
    return `${Number.parseInt(number, 10)}${suffix}`;
  }
  if (suffix === 'x' && SRCSET_FLOAT.test(number)) {
    const density = Number.parseFloat(number);
    // Prettier keeps a density only when it is truthy, so `0x` prints bare.
    return density === 0 ? undefined : `${canonicalNumber(number)}x`;
  }
  return descriptor;
}

function canonicalSrcset(value: string): string {
  return srcsetCandidates(value)
    .map(({ url, descriptors }) =>
      [url, ...descriptors.map(canonicalDescriptor)]
        .filter((part): part is string => part !== undefined)
        .join(' '),
    )
    .join(', ');
}

// ------------------------------------------------------------------- style

type CssToken =
  | { readonly kind: 'ident'; readonly text: string }
  | { readonly kind: 'function'; readonly name: string }
  | { readonly kind: 'url'; readonly name: string; readonly url: string }
  | { readonly kind: 'string'; readonly content: string }
  | { readonly kind: 'number'; readonly number: string; readonly unit: string }
  | { readonly kind: 'hash'; readonly text: string }
  | { readonly kind: 'open'; readonly char: '(' | '[' }
  | { readonly kind: 'close'; readonly char: ')' | ']' }
  | { readonly kind: 'comma' | 'colon' | 'semicolon' }
  | { readonly kind: 'delim'; readonly char: string };

/** A token with whether whitespace or a comment came before it. */
type Spaced = CssToken & { readonly spaced: boolean };

/** Thrown inside the style reader at a construct with no stable form. */
class UnstableStyle extends Error {}

const CSS_WIDE_KEYWORDS = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** The math functions, inside which `+`, `-` and `*` are operators. */
const MATH_FUNCTIONS = new Set([
  'calc',
  'min',
  'max',
  'clamp',
  'round',
  'mod',
  'rem',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'pow',
  'sqrt',
  'hypot',
  'log',
  'exp',
  'abs',
  'sign',
]);

const isDigit = (char: string | undefined): boolean =>
  char !== undefined && char >= '0' && char <= '9';
const isCssSpace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
const isNameStart = (char: string | undefined): boolean =>
  char !== undefined && (/^[A-Za-z_]$/.test(char) || char.charCodeAt(0) >= 0x80);
const isNameChar = (char: string | undefined): boolean =>
  isNameStart(char) || isDigit(char) || char === '-';

/**
 * The tokens of a style value (CSS Syntax 3), comments read as whitespace.
 * A backslash outside a string or a URL, an unterminated string and the
 * tokens no plain declaration holds (`{}`, an at-keyword) throw.
 */
function tokenizeStyle(text: string): Spaced[] {
  const tokens: Spaced[] = [];
  let at = 0;
  let spaced = false;
  const push = (token: CssToken): void => {
    tokens.push({ ...token, spaced });
    spaced = false;
  };
  const identStart = (index: number): boolean =>
    text[index] === '-'
      ? isNameStart(text[index + 1]) || text[index + 1] === '-'
      : isNameStart(text[index]);
  const consumeName = (): string => {
    const from = at;
    while (isNameChar(text[at])) at += 1;
    if (text[at] === '\\') throw new UnstableStyle();
    return text.slice(from, at);
  };

  while (at < text.length) {
    const char = text[at] as string;
    const next = text[at + 1];
    if (isCssSpace(char)) {
      while (isCssSpace(text[at])) at += 1;
      spaced = true;
    } else if (char === '/' && next === '*') {
      const close = text.indexOf('*/', at + 2);
      at = close === -1 ? text.length : close + 2;
      spaced = true;
    } else if (char === '"' || char === "'") {
      at += 1;
      let content = '';
      for (;;) {
        const inner = text[at];
        if (inner === undefined || inner === '\n') throw new UnstableStyle();
        at += 1;
        if (inner === char) break;
        if (inner === '\\') {
          const escaped = text[at];
          if (escaped === undefined) throw new UnstableStyle();
          content += inner + escaped;
          at += 1;
        } else {
          content += inner;
        }
      }
      push({ kind: 'string', content });
    } else if (
      isDigit(char) ||
      (char === '.' && isDigit(next)) ||
      ((char === '+' || char === '-') && (isDigit(next) || (next === '.' && isDigit(text[at + 2]))))
    ) {
      const from = at;
      if (char === '+' || char === '-') at += 1;
      while (isDigit(text[at])) at += 1;
      if (text[at] === '.' && isDigit(text[at + 1])) {
        at += 1;
        while (isDigit(text[at])) at += 1;
      }
      const exponent = text[at];
      const sign = text[at + 1];
      if (
        (exponent === 'e' || exponent === 'E') &&
        (isDigit(sign) || ((sign === '+' || sign === '-') && isDigit(text[at + 2])))
      ) {
        at += 2;
        while (isDigit(text[at])) at += 1;
      }
      const number = text.slice(from, at);
      let unit = '';
      if (identStart(at)) unit = consumeName().toLowerCase();
      else if (text[at] === '%') {
        unit = '%';
        at += 1;
      } else if (text[at] === '\\') throw new UnstableStyle();
      push({ kind: 'number', number, unit });
    } else if (identStart(at)) {
      const name = consumeName();
      if (text[at] !== '(') {
        push({ kind: 'ident', text: name });
        continue;
      }
      at += 1;
      let lookahead = at;
      while (isCssSpace(text[lookahead])) lookahead += 1;
      const quoted = text[lookahead] === '"' || text[lookahead] === "'";
      if (name.toLowerCase() !== 'url' || quoted) {
        push({ kind: 'function', name });
        continue;
      }
      const close = text.indexOf(')', lookahead);
      if (close === -1) throw new UnstableStyle();
      const url = text.slice(lookahead, close).replace(/[ \t\n\r\f]+$/, '');
      if (/[ \t\n\r\f"'(]/.test(url)) throw new UnstableStyle();
      at = close + 1;
      push({ kind: 'url', name, url });
    } else if (char === '#' && (isNameChar(next) || next === '\\')) {
      at += 1;
      push({ kind: 'hash', text: `#${consumeName()}` });
    } else if (char === '(' || char === '[') {
      at += 1;
      push({ kind: 'open', char });
    } else if (char === ')' || char === ']') {
      at += 1;
      push({ kind: 'close', char });
    } else if (char === ',') {
      at += 1;
      push({ kind: 'comma' });
    } else if (char === ':') {
      at += 1;
      push({ kind: 'colon' });
    } else if (char === ';') {
      at += 1;
      push({ kind: 'semicolon' });
    } else if (char === '!' || char === '/' || char === '*' || char === '+' || char === '-') {
      at += 1;
      push({ kind: 'delim', char });
    } else {
      throw new UnstableStyle();
    }
  }
  return tokens;
}

/**
 * A string's canonical spelling: escaped quotes unescaped, then quoted with
 * the quote that occurs less (`'` on a tie), which is escaped inside.
 */
function canonicalString(content: string): string {
  let unescaped = '';
  let singles = 0;
  let doubles = 0;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] as string;
    if (char === '\\') {
      const escaped = content[index + 1] as string;
      index += 1;
      if (escaped !== '"' && escaped !== "'") {
        unescaped += char + escaped;
        continue;
      }
      unescaped += escaped;
      if (escaped === "'") singles += 1;
      else doubles += 1;
    } else {
      unescaped += char;
      if (char === "'") singles += 1;
      else if (char === '"') doubles += 1;
    }
  }
  const quote = singles > doubles ? '"' : "'";
  let out = quote;
  for (let index = 0; index < unescaped.length; index += 1) {
    const char = unescaped[index] as string;
    if (char === '\\') {
      out += char + (unescaped[index + 1] as string);
      index += 1;
    } else {
      out += char === quote ? `\\${char}` : char;
    }
  }
  return out + quote;
}

/** A token that ends a call or a parenthesized group. */
function closesCall(token: Spaced | undefined): boolean {
  return token?.kind === 'url' || (token?.kind === 'close' && token.char === ')');
}

/** A token that starts a call or a parenthesized group. */
function opensCall(token: Spaced | undefined): boolean {
  return (
    token?.kind === 'url' ||
    token?.kind === 'function' ||
    (token?.kind === 'open' && token.char === '(')
  );
}

/** A token of a value as the canonical form writes it, with how it joins. */
interface Piece {
  readonly text: string;
  readonly role: 'word' | 'open' | 'close' | 'comma' | 'operator' | 'slash' | 'important';
}

/** The text between two pieces of a canonical value. */
function separator(previous: Piece, next: Piece): string {
  if (next.role === 'comma' || previous.role === 'open' || next.role === 'close') return '';
  if (previous.role === 'slash' || next.role === 'slash') return '';
  return ' ';
}

/**
 * The canonical text of one declaration's value, checked against the stable
 * subset as it is read.
 */
function canonicalValue(tokens: readonly Spaced[]): string {
  const pieces: Piece[] = [];
  /** For each open bracket, whether it is (inside) a math function. */
  const math: boolean[] = [];
  const inMath = (): boolean => math[math.length - 1] === true;
  const last = (): Piece | undefined => pieces[pieces.length - 1];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Spaced;
    switch (token.kind) {
      case 'ident': {
        const lower = token.text.toLowerCase();
        pieces.push({ text: CSS_WIDE_KEYWORDS.has(lower) ? lower : token.text, role: 'word' });
        break;
      }
      case 'number': {
        // Prettier turns a `+` sign, or an exponent's, into an addition.
        if (token.number.includes('+')) throw new UnstableStyle();
        const previous = last();
        if (
          token.number.startsWith('-') &&
          inMath() &&
          previous !== undefined &&
          (previous.role === 'word' || previous.role === 'close')
        ) {
          throw new UnstableStyle();
        }
        pieces.push({ text: canonicalNumber(token.number) + token.unit, role: 'word' });
        break;
      }
      case 'string':
        pieces.push({ text: canonicalString(token.content), role: 'word' });
        break;
      case 'url':
        pieces.push({ text: `url(${token.url})`, role: 'word' });
        break;
      case 'hash':
        pieces.push({
          text: HEX_COLOR.test(token.text) ? token.text.toLowerCase() : token.text,
          role: 'word',
        });
        break;
      case 'function': {
        const name = token.name.toLowerCase();
        if (name === 'url') {
          const string = tokens[index + 1];
          const close = tokens[index + 2];
          if (string?.kind !== 'string' || close?.kind !== 'close' || close.char !== ')') {
            throw new UnstableStyle();
          }
        }
        math.push(MATH_FUNCTIONS.has(name));
        pieces.push({ text: `${name}(`, role: 'open' });
        break;
      }
      case 'open':
        math.push(token.char === '(' && inMath());
        pieces.push({ text: token.char, role: 'open' });
        break;
      case 'close':
        if (math.pop() === undefined) throw new UnstableStyle();
        pieces.push({ text: token.char, role: 'close' });
        break;
      case 'comma':
        pieces.push({ text: ',', role: 'comma' });
        break;
      case 'delim':
        if (token.char === '/') {
          const before = tokens[index - 1];
          const after = tokens[index + 1];
          // Prettier reads `a/f(x)` as the word `a/f` before a group, and
          // drops one of two lopsided spaces around a `/` next to a call.
          if (
            (closesCall(before) || opensCall(after)) &&
            (!token.spaced || after?.spaced !== true)
          ) {
            throw new UnstableStyle();
          }
          pieces.push({ text: '/', role: 'slash' });
        } else if (token.char === '!') {
          const important = tokens[index + 1];
          if (
            important?.kind !== 'ident' ||
            important.text.toLowerCase() !== 'important' ||
            index + 2 !== tokens.length
          ) {
            throw new UnstableStyle();
          }
          pieces.push({ text: '!important', role: 'important' });
          index += 1;
        } else {
          if (!inMath()) throw new UnstableStyle();
          const after = tokens[index + 1];
          if (token.char !== '*' && (!token.spaced || after?.spaced !== true)) {
            throw new UnstableStyle();
          }
          pieces.push({ text: token.char, role: 'operator' });
        }
        break;
      default:
        throw new UnstableStyle();
    }
  }
  if (math.length > 0) throw new UnstableStyle();
  let out = '';
  pieces.forEach((piece, index) => {
    if (index > 0) out += separator(pieces[index - 1] as Piece, piece);
    out += piece.text;
  });
  return out;
}

/** Split `tokens` at each token of `kind` outside brackets, into at most `limit` parts. */
function splitTopLevel(
  tokens: readonly Spaced[],
  kind: 'colon' | 'semicolon',
  limit: number,
): Spaced[][] {
  const parts: Spaced[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'open' || token.kind === 'function') depth += 1;
    else if (token.kind === 'close' && depth > 0) depth -= 1;
    if (token.kind === kind && depth === 0 && parts.length < limit) parts.push([]);
    else (parts[parts.length - 1] as Spaced[]).push(token);
  }
  return parts;
}

function canonicalStyle(value: string): PrintedValue {
  try {
    const declarations = splitTopLevel(tokenizeStyle(value), 'semicolon', Infinity)
      .filter((declaration) => declaration.length > 0)
      .map((declaration) => {
        const [name, valueTokens] = splitTopLevel(declaration, 'colon', 2);
        const property = name?.length === 1 ? name[0] : undefined;
        if (property?.kind !== 'ident' || valueTokens === undefined) throw new UnstableStyle();
        const text = canonicalValue(valueTokens);
        const prop = property.text.startsWith('--') ? property.text : property.text.toLowerCase();
        return text === '' ? `${prop}:` : `${prop}: ${text}`;
      });
    return stable(declarations.join('; '));
  } catch (error) {
    if (error instanceof UnstableStyle) return { value, unstable: true };
    throw error;
  }
}
