/**
 * Dotenv document helpers shared by the credentials command and Jamal secrets.
 *
 * `node:util`'s `parseEnv` is the parser everywhere in JSails, but it returns
 * keys **sorted** (its backing store is ordered) and drops a `__proto__` key
 * outright. Both facts matter to a caller that has to preserve or impose an
 * order, or that must reject a reserved name the parser cannot surface. This
 * module recovers the document order and the reserved-name check from the raw
 * text, so the two callers share one implementation of dotenv's line rules.
 *
 * The rules are dotenv's own: a key starts a line after optional whitespace and
 * an optional `export `, is followed by `=` or `:`, and a `#` starts a comment.
 * Key-shaped text inside a multiline value is filtered out by the caller
 * checking each candidate against the parsed map.
 */

import { isForbiddenKey } from './json/shape.js';

/** A key that can become an environment variable name. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A key at the start of a line, outside a `#` comment. */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=|:)/;

/** A reserved key at the start of a line, outside a `#` comment. */
const FORBIDDEN_KEY_LINE = /(?:^|\n)[\t ]*(__proto__|constructor|prototype)[\t ]*=/;

/**
 * The keys of a dotenv document in document order. A key that appears more than
 * once is listed once, at its first position.
 */
export function dotenvKeysInDocumentOrder(raw: string): readonly string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const stripped = line
      .replace(/\r$/, '')
      .replace(/^\s+/, '')
      .replace(/^export\s+/, '');
    if (stripped.length === 0 || stripped.startsWith('#')) {
      continue;
    }
    const key = KEY_LINE.exec(stripped)?.[1];
    if (key !== undefined && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * True when `raw` assigns a reserved key at the start of a line. `parseEnv`
 * cannot surface `__proto__` (its result is null-prototype and DROPS it), so a
 * forbidden name that would otherwise vanish silently is caught from the text.
 */
export function hasForbiddenKeyLine(raw: string): boolean {
  return FORBIDDEN_KEY_LINE.test(raw);
}

/** True when `key` is a valid environment variable name and not reserved. */
export function isEnvKey(key: string): boolean {
  return ENV_KEY.test(key) && !isForbiddenKey(key);
}
