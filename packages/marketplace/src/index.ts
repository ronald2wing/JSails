/**
 * `@jsails/marketplace`: the trust primitives of the plugin marketplace, pure
 * and free of I/O. The archive reader turns a bundle's gzip-compressed tar into
 * files under a strict path rule; `openBundle` finds its single root manifest;
 * release statements, publishers, delegations and catalogs decide, with
 * Ed25519 signatures over canonical JSON, whether this site trusts a release
 * and whether these are its bytes. Nothing here downloads, stores or loads a
 * plugin.
 */

export * from './archive/index.js';
export * from './catalog/index.js';
export * from './intake/index.js';
export * from './trust/index.js';
