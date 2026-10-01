/**
 * Named data contracts: a plain, frozen descriptor over a set of Zod fields.
 *
 * The user defines properties, not a class and not `z.object(...)`:
 *
 * ```ts
 * const CreateUser = defineData({
 *   name: 'CreateUser',
 *   description: 'Create a user.',
 *   properties: {
 *     email: z.email(),
 *     name: z.string(),
 *   },
 * });
 * ```
 *
 * The descriptor holds metadata, the field schemas, the generated strict Zod
 * object, and lazy input/output JSON Schemas. The parsed value is a plain object.
 */

import { z } from 'zod';

/** A JSON Schema document produced by Zod. */
export type DataJsonSchema = z.core.JSONSchema.BaseSchema;

/** Options forwarded to Zod's native JSON Schema generator. */
export type DataJsonSchemaOptions = Omit<z.core.ToJSONSchemaParams, 'io'>;

/** Raised for a malformed data contract. Value-free. */
export class DataContractError extends Error {
  readonly code = 'invalid_contract';

  constructor(message: string) {
    super(message);
    this.name = 'DataContractError';
  }
}

/** Input accepted by {@link defineData}. */
export interface DataContractInput<P extends z.ZodRawShape> {
  /** Stable name used for diagnostics and as the default AI tool name. */
  readonly name: string;
  /** Optional human description; also the default AI tool description. */
  readonly description?: string;
  /** The field schemas, in declaration order. */
  readonly properties: P;
  /** Options used when the lazy JSON Schema properties are first read. */
  readonly jsonSchema?: DataJsonSchemaOptions;
}

/** A reusable named data contract. */
export interface DataContract<P extends z.ZodRawShape> {
  readonly name: string;
  readonly description?: string;
  /** The field schemas, in declaration order. */
  readonly properties: P;
  /** The generated strict Zod object schema. */
  readonly schema: z.ZodObject<P>;
  /** The input JSON Schema, derived lazily from `schema`. */
  readonly jsonSchema: DataJsonSchema;
  /** The output JSON Schema, derived lazily from `schema`. */
  readonly outputJsonSchema: DataJsonSchema;
}

/** Attach the lazy input/output JSON Schema views to a contract descriptor. */
function attachJsonSchemas(
  target: object,
  schema: z.ZodType,
  options: DataJsonSchemaOptions | undefined,
): void {
  for (const [property, io] of [
    ['jsonSchema', 'input'],
    ['outputJsonSchema', 'output'],
  ] as const) {
    let cached: DataJsonSchema | undefined;
    Object.defineProperty(target, property, {
      enumerable: true,
      get() {
        if (cached === undefined) {
          try {
            cached = z.toJSONSchema(schema, {
              unrepresentable: 'throw',
              ...options,
              io,
            });
          } catch {
            throw new DataContractError(`data ${io} JSON schema cannot be generated`);
          }
        }
        return cached;
      },
    });
  }
}

/**
 * Build a named data contract from property schemas.
 *
 * `properties` is an ordinary object of Zod schemas. `defineData` builds a
 * strict object schema, rejects malformed contracts value-free, and exposes lazy
 * `jsonSchema`/`outputJsonSchema` properties. Validation remains
 * `contract.schema.parse(input)`.
 */
export function defineData<const P extends z.ZodRawShape>(
  input: DataContractInput<P>,
): DataContract<P> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DataContractError('defineData requires a contract input object');
  }
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new DataContractError('data contract name must be a non-empty string');
  }
  if (
    input.description !== undefined &&
    (typeof input.description !== 'string' || input.description.trim() === '')
  ) {
    throw new DataContractError('data contract description must be a non-empty string');
  }
  if (
    input.properties === null ||
    typeof input.properties !== 'object' ||
    Array.isArray(input.properties)
  ) {
    throw new DataContractError('data contract properties must be an object of Zod schemas');
  }

  let schema: z.ZodObject<P>;
  try {
    schema = z
      .object(input.properties)
      .strict()
      .meta({
        title: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
      });
  } catch {
    throw new DataContractError('data contract properties must be an object of Zod schemas');
  }

  const contract = {
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    properties: { ...input.properties },
    schema,
  } as DataContract<P>;
  attachJsonSchemas(contract, schema, input.jsonSchema);

  return Object.freeze(contract);
}

/** Options for {@link defineDataList}. */
export interface DataListContractOptions {
  /** Stable name; defaults to `<item name>List`. */
  readonly name?: string;
  /** Optional human description. */
  readonly description?: string;
  /** Options used when the lazy JSON Schema properties are first read. */
  readonly jsonSchema?: DataJsonSchemaOptions;
}

/** A reusable list of a data contract. */
export interface DataListContract<P extends z.ZodRawShape> {
  readonly name: string;
  readonly description?: string;
  /** The element contract. */
  readonly item: DataContract<P>;
  readonly schema: z.ZodArray<z.ZodObject<P>>;
  readonly jsonSchema: DataJsonSchema;
  readonly outputJsonSchema: DataJsonSchema;
}

/** Any data contract accepted by the model decorator. */
export type AnyDataContract = DataContract<z.ZodRawShape> | DataListContract<z.ZodRawShape>;

/** The TypeScript value of a data object or data list contract. */
export type DataValue<D> =
  D extends DataContract<infer P>
    ? z.infer<z.ZodObject<P>>
    : D extends DataListContract<infer P>
      ? z.infer<z.ZodArray<z.ZodObject<P>>>
      : never;

/** Build a list contract from an object data contract. */
export function defineDataList<P extends z.ZodRawShape>(
  item: DataContract<P>,
  options: DataListContractOptions = {},
): DataListContract<P> {
  if (item === null || typeof item !== 'object' || !(item.schema instanceof z.ZodObject)) {
    throw new DataContractError('defineDataList requires a defineData contract');
  }
  const name = options.name ?? `${item.name}List`;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new DataContractError('data list contract name must be a non-empty string');
  }
  if (
    options.description !== undefined &&
    (typeof options.description !== 'string' || options.description.trim() === '')
  ) {
    throw new DataContractError('data list contract description must be a non-empty string');
  }

  const schema = z.array(item.schema).meta({
    title: name,
    ...(options.description === undefined ? {} : { description: options.description }),
  });
  const contract = {
    name,
    ...(options.description === undefined ? {} : { description: options.description }),
    item,
    schema,
  } as DataListContract<P>;
  attachJsonSchemas(contract, schema, options.jsonSchema);

  return Object.freeze(contract);
}
