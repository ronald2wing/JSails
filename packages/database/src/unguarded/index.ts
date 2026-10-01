/**
 * `@jsails/database/unguarded`: raw SQL and a raw connection on a data
 * source, with no codecs, no tenant policy and no decoding. It is a subpath
 * of its own so every use is an explicit import that review can find.
 */

export { UNGUARDED_ORIGIN, unguarded, type Unguarded } from './unguarded.js';
