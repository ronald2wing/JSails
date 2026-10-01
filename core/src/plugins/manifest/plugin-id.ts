/**
 * The plugin identifier rule, apart from the manifest schema so a caller that
 * only checks an id (the `plugins` command's argument parsing, enablement)
 * does not load Zod.
 */

/**
 * Plugin identifiers: a lowercase letter or digit, then lowercase letters,
 * digits, `.`, `_`, or `-`. The id is the key for dedupe, enablement, and
 * stored state.
 *
 * @public
 */
export const PLUGIN_ID_PATTERN: RegExp = /^[a-z0-9][a-z0-9._-]*$/;
