/**
 * Physical names of the model layer: the property-to-column rule and the
 * derived names of indexes and foreign keys. A physical name is a lowercase
 * snake_case identifier of at most 63 characters (PostgreSQL's limit, under
 * MariaDB's 64), so it needs no case folding anywhere; a derived name that
 * would be longer keeps a readable prefix and ends in a hash of the full
 * name, so two long names never truncate to the same one.
 */

/** A physical table, column or index name. */
export const PHYSICAL_NAME: RegExp = /^[a-z][a-z0-9_]{0,62}$/;
/** A property name: an identifier of letters and digits. */
export const PROPERTY_NAME: RegExp = /^[A-Za-z][A-Za-z0-9]*$/;

const MAX_NAME = 63;

/** `authorId` to `author_id`, `htmlURL` to `html_url`, `URLPath` to `url_path`. */
export function snakeCase(property: string): string {
  return property
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** 32-bit FNV-1a, as eight hex digits. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** `parts` joined by `_`, shortened with a hash suffix past 63 characters. */
export function derivedName(...parts: readonly string[]): string {
  const full = parts.join('_');
  if (full.length <= MAX_NAME) return full;
  return `${full.slice(0, MAX_NAME - 9).replace(/_+$/, '')}_${fnv1a(full)}`;
}

/** The derived name of an index over physical `columns`. */
export function indexName(table: string, columns: readonly string[], unique: boolean): string {
  return derivedName(table, ...columns, unique ? 'key' : 'idx');
}

/** The derived name of a foreign-key constraint over physical `columns`. */
export function foreignKeyName(table: string, columns: readonly string[]): string {
  return derivedName(table, ...columns, 'fkey');
}
