/**
 * Rich-text data contract (`jsails/rich-text`).
 *
 * The persisted schema is framework-owned and intentionally independent of the
 * optional `@jsails/editor` UI package: a model, API, or renderer can use the
 * contract without installing the editor UI. The editor package consumes this
 * subpath.
 */

export * from './document.js';
export * from './editor.js';
