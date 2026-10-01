/**
 * Server-component directive marker builders for the HotView directive
 * system: pure attribute-map builders that return records for spreading onto
 * Preact elements inside a component's `render`.
 *
 * The implementations live in the browser-safe `client/action-attrs.js` so a
 * client island can build the same markers without importing the server
 * runtime. This module re-exports them to keep the server-component surface
 * unchanged.
 */

export {
  confirmAttrs,
  ignoreAttrs,
  intersectAttrs,
  loadingTargetAttrs,
  refAttrs,
  showAttrs,
  sortAttrs,
  textAttrs,
} from '../client/action-attrs.js';
