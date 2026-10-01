/**
 * Dotenv documents as the credentials commands rewrite them.
 *
 * `node:util`'s `parseEnv` returns keys sorted, so a command that changes one
 * value and writes the document back recovers the document order from the
 * raw text first. The rules are dotenv's own: a key starts a line after
 * optional whitespace and an optional `export `, is followed by `=` or `:`,
 * and a `#` starts a comment. Key-shaped text inside a multiline value is
 * filtered out by checking each candidate against the parsed map.
 */

import { CredentialsErrors } from './errors.js';

/** A key at the start of a line, outside a `#` comment. */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=|:)/;

/**
 * The keys of `parsed` in the order `raw` first assigns them, then any key
 * the scan missed in sorted order.
 */
export function keysInDocumentOrder(
  raw: string,
  parsed: Readonly<Record<string, string>>,
): readonly string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const stripped = line
      .replace(/\r$/, '')
      .replace(/^\s+/, '')
      .replace(/^export\s+/, '');
    if (stripped.length === 0 || stripped.startsWith('#')) continue;
    const key = KEY_LINE.exec(stripped)?.[1];
    if (key !== undefined && Object.hasOwn(parsed, key) && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  for (const key of Object.keys(parsed).sort()) {
    if (!seen.has(key)) keys.push(key);
  }
  return keys;
}

/**
 * Render `entries` as a dotenv document, one `KEY=value` line each, so that
 * `parseEnv` reads every value back exactly. Throws `credentials.invalid_value`
 * for a value no dotenv line can hold.
 */
export function renderDotenvDocument(entries: Iterable<readonly [string, string]>): string {
  const lines: string[] = [];
  for (const [name, value] of entries) lines.push(`${name}=${quoteValue(name, value)}`);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** A value `parseEnv` reads back unquoted. */
const BARE_VALUE = /^[A-Za-z0-9_./:@+,-]+$/;

/**
 * Quote a value only when it needs it. `parseEnv` has no escape sequences: a
 * quoted value ends at the first matching quote, and double quotes expand a
 * literal `\n`. So the value goes in the first of single quotes, backticks or
 * double quotes that it does not contain (double quotes only when it holds no
 * `\n` sequence); a value with NUL, or with every usable quote, is refused.
 */
function quoteValue(name: string, value: string): string {
  if (value.includes('\0')) {
    throw new CredentialsErrors.Error('invalid_value', { name, problem: 'contains NUL' });
  }
  if (BARE_VALUE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('`')) return `\`${value}\``;
  if (!value.includes('"') && !value.includes('\\n')) return `"${value}"`;
  throw new CredentialsErrors.Error('invalid_value', { name, problem: 'holds every quote' });
}
