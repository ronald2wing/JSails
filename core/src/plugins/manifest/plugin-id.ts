/**
 * The plugin identifier rule, apart from the manifest schema so a caller that
 * only checks an id (a catalog, a release statement) does not load Zod.
 */

/**
 * Plugin identifiers: a lowercase letter or digit, then lowercase letters,
 * digits, `.`, `_`, or `-`. The id is the key for dedupe, dependencies,
 * and publisher namespaces.
 *
 * @public
 */
export const PLUGIN_ID_PATTERN: RegExp = /^[a-z0-9][a-z0-9._-]*$/;
