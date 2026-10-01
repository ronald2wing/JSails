/**
 * Structured output: schema sources, per-provider JSON Schema lowering with
 * its inverse restore, and generateObject.
 */

export {
  AI_SCHEMA_PROFILES,
  isZodSchema,
  lowerJsonSchema,
  lowerZodSchema,
  zodInputJsonSchema,
  type AiLoweredSchema,
  type AiSchemaProfile,
} from './schema-lowering.js';
export { matchesLowered, type JsonSchema } from './schema-restore.js';
export {
  resolveSchemaSource,
  type AiSchemaOutput,
  type AiSchemaSource,
  type AiStructuralContract,
  type ResolvedSchemaSource,
} from './schema-source.js';
export {
  generateObject,
  type AiObjectResult,
  type GenerateObjectOptions,
} from './generate-object.js';
