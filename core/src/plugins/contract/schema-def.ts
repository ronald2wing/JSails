/**
 * Reading a Zod v4 schema's structure: the definition fields the plugin
 * contract walks, and the part of an issue path the schema itself declares.
 *
 * Imports no Zod at runtime. The contract walks a schema for two reasons:
 * the options rule (`checkOptionSchema`) visits every node, and an options
 * failure reports only the path segments that come from the schema, never a
 * key that came from the input (an unknown key, a record key), so an issue
 * path cannot carry a value.
 */

/** The Zod v4 definition fields the contract reads. */
export interface SchemaDef {
  readonly type?: string;
  readonly shape?: Readonly<Record<string, object>>;
  readonly catchall?: object;
  readonly element?: object;
  readonly items?: readonly object[];
  readonly rest?: object | null;
  readonly options?: readonly object[];
  readonly left?: object;
  readonly right?: object;
  readonly keyType?: object;
  readonly valueType?: object;
  readonly innerType?: object;
  readonly in?: object;
  readonly out?: object;
  readonly getter?: () => object;
}

/** The definition of a Zod v4 schema, or `undefined` for anything else. */
export function schemaDef(node: unknown): SchemaDef | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  return (node as { readonly _zod?: { readonly def?: SchemaDef } })._zod?.def;
}

/** Wrappers whose value is their inner schema's value. */
const WRAPPERS = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'nonoptional',
  'catch',
  'readonly',
]);

/** See through wrappers, pipes and lazy schemas to the node that holds the value's shape. */
function unwrap(node: object | undefined): object | undefined {
  let current = node;
  for (let depth = 0; depth < 64 && current !== undefined; depth += 1) {
    const def = schemaDef(current);
    if (def?.type !== undefined && WRAPPERS.has(def.type)) current = def.innerType;
    else if (def?.type === 'pipe') current = def.in;
    else if (def?.type === 'lazy' && typeof def.getter === 'function') current = def.getter();
    else return current;
  }
  return current;
}

/**
 * The leading part of `path` that `schema` declares: an object key its shape
 * names, or an index into an array or tuple. The path stops at the first
 * segment that came from the input instead (an unknown key, a record key, a
 * key inside a union whose branch is unknown).
 */
export function declaredPath(
  schema: object,
  path: readonly (string | number)[],
): readonly (string | number)[] {
  const kept: (string | number)[] = [];
  let node: object | undefined = schema;
  for (const segment of path) {
    const def = schemaDef(unwrap(node));
    if (def?.type === 'object' && typeof segment === 'string') {
      const child = def.shape !== undefined && Object.hasOwn(def.shape, segment);
      if (!child) break;
      kept.push(segment);
      node = def.shape?.[segment];
    } else if (def?.type === 'array' && typeof segment === 'number') {
      kept.push(segment);
      node = def.element;
    } else if (def?.type === 'tuple' && typeof segment === 'number') {
      kept.push(segment);
      node = def.items?.[segment] ?? def.rest ?? undefined;
    } else {
      break;
    }
  }
  return Object.freeze(kept);
}
