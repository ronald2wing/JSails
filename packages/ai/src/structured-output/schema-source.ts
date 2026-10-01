/**
 * Schema sources: a Zod schema, or a structural contract carrying one.
 *
 * A contract is anything with a `name`, an optional `description`, and a Zod
 * `schema`, which a `jsails/data` contract satisfies. It is matched
 * structurally and imported by no module here, so the browser-safe entry never
 * pulls the data layer in.
 */

import type { z } from 'zod';

import { isZodSchema } from './schema-lowering.js';

/** A named contract with a Zod schema (a `jsails/data` contract fits). */
export interface AiStructuralContract<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description?: string;
  readonly schema: S;
}

/** A Zod schema or a structural contract. */
export type AiSchemaSource = z.ZodType | AiStructuralContract;

/** The parsed (output) type of a schema source. */
export type AiSchemaOutput<S> =
  S extends AiStructuralContract<infer Z> ? z.output<Z> : S extends z.ZodType ? z.output<S> : never;

/** A schema source resolved to its Zod schema and contract metadata. */
export interface ResolvedSchemaSource {
  readonly schema: z.ZodType;
  readonly name?: string;
  readonly description?: string;
}

/** Resolve `source`, or `undefined` when it is neither a Zod schema nor a contract. */
export function resolveSchemaSource(source: unknown): ResolvedSchemaSource | undefined {
  if (isZodSchema(source)) return { schema: source };
  if (typeof source !== 'object' || source === null) return undefined;
  const contract = source as Record<string, unknown>;
  if (!isZodSchema(contract.schema)) return undefined;
  return {
    schema: contract.schema,
    ...(typeof contract.name === 'string' ? { name: contract.name } : {}),
    ...(typeof contract.description === 'string' ? { description: contract.description } : {}),
  };
}
