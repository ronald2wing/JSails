/**
 * Pagination helper for server components: builds prev/next call-attribute maps
 * from a `Page` so component authors never hand-roll the pager buttons.
 *
 * The returned attribute maps spread onto a `call` trigger element, so a
 * component renders a pager with two spread elements rather than writing
 * `call` invocations with serialized numeric args.
 *
 * The implementation lives in the browser-safe `client/action-attrs.js` so a
 * client island can build the same markers; this module re-exports it to keep
 * the server-component surface unchanged.
 */

export { pagerAttrs, type ServerComponentPagerOptions } from '../client/action-attrs.js';
