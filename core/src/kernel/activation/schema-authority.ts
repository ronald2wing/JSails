/**
 * The schema authority: the capability to change a plugin's tables at
 * runtime.
 *
 * In locked mode, plugin schema goes through `jsails db:push` like app
 * schema, and no authority exists. In managed mode the plugin resolver mints
 * one, from the mode sealed in code config, and puts it on the plugin graph
 * for the managed source. The data layer's owner-scoped schema entry point
 * takes it by type import and refuses a call without one.
 *
 * The brand is checked at runtime ({@link isSchemaAuthority}), because a
 * type-only brand can be forged by a cast. Only `resolve-plugins.ts` imports
 * {@link mintSchemaAuthority}; a structure test holds that, so no module
 * reachable from the state store or an admin route can construct one.
 */

declare const SCHEMA_AUTHORITY: unique symbol;

/**
 * An opaque capability, minted by the kernel only in managed mode.
 *
 * @public
 */
export interface SchemaAuthority {
  readonly [SCHEMA_AUTHORITY]: true;
}

const AUTHORITIES = new WeakSet<object>();

/** Mint a schema authority. Imported only by the plugin resolver, in managed mode. */
export function mintSchemaAuthority(): SchemaAuthority {
  const authority = Object.freeze(Object.create(null) as object);
  AUTHORITIES.add(authority);
  return authority as SchemaAuthority;
}

/**
 * Whether `value` is an authority the kernel minted.
 *
 * @public
 */
export function isSchemaAuthority(value: unknown): value is SchemaAuthority {
  return typeof value === 'object' && value !== null && AUTHORITIES.has(value);
}
