/**
 * Dotenv document rules the secrets loader needs beyond `node:util`'s
 * `parseEnv`, which returns keys sorted and silently drops a `__proto__` key:
 * the keys in document order, and the reserved-key check, both read from the
 * raw text with dotenv's own line rules (optional leading whitespace and
 * `export `, then `=` or `:`; `#` starts a comment). Key-shaped text inside a
 * multiline value is filtered out by the caller against the parsed map.
 */

/** A key at the start of a line, outside a `#` comment. */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=|:)/;

/** A reserved key at the start of a line, outside a `#` comment. */
const FORBIDDEN_KEY_LINE = /(?:^|\n)[\t ]*(__proto__|constructor|prototype)[\t ]*=/;

/** The keys of a dotenv document in document order, each listed once at its first position. */
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

/** True when `raw` assigns a reserved key at the start of a line. */
export function hasForbiddenKeyLine(raw: string): boolean {
  return FORBIDDEN_KEY_LINE.test(raw);
}
