/**
 * Project a named data contract to the AI tool wire shape.
 *
 * The data contract remains the source of truth for validation. The tool
 * validates every model argument through the same schema before calling the
 * handler, and exposes the input JSON Schema as `parameters`.
 */

import { z } from 'zod';

import type { AnyDataContract, DataContract, DataJsonSchemaOptions } from 'jsails/data';
import { AiError, type AiTool } from './contracts.js';

/** Provider-safe tool names (OpenAI/Anthropic-compatible). */
const AI_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Options for {@link aiTool}. */
export interface AiToolFromDataOptions<P extends z.ZodRawShape> {
  /** Tool name; defaults to the data contract name. */
  readonly name?: string;
  /** Tool description; defaults to the data contract description. */
  readonly description?: string;
  /** Options forwarded to Zod's JSON Schema generator. */
  readonly jsonSchema?: DataJsonSchemaOptions;
  /** Optional output contract; the handler result is validated through it. */
  readonly returns?: AnyDataContract;
  /** The handler receives already-validated, typed input. */
  readonly call: (input: z.infer<z.ZodObject<P>>) => unknown;
}

/**
 * Build an `AiTool` from a data contract. The input JSON Schema is generated
 * with `io: 'input'`; unrepresentable schemas fail loudly by default.
 */
export function aiTool<P extends z.ZodRawShape>(
  contract: DataContract<P>,
  options: AiToolFromDataOptions<P>,
): AiTool {
  if (
    contract === null ||
    typeof contract !== 'object' ||
    typeof contract.schema?.parse !== 'function' ||
    typeof options !== 'object'
  ) {
    throw new AiError('invalid_tool', 'aiTool requires a data contract and options');
  }
  if (
    options.returns !== undefined &&
    (options.returns === null ||
      typeof options.returns !== 'object' ||
      typeof options.returns.schema?.parse !== 'function')
  ) {
    throw new AiError('invalid_tool', 'aiTool returns must be a data contract');
  }
  if (typeof options.call !== 'function') {
    throw new AiError('invalid_tool', 'aiTool requires a call function');
  }

  const name = options.name ?? contract.name;
  if (typeof name !== 'string' || !AI_TOOL_NAME_PATTERN.test(name)) {
    throw new AiError('invalid_tool', 'AI tool name is invalid');
  }
  const description = options.description ?? contract.description;
  if (typeof description !== 'string' || description.trim() === '') {
    throw new AiError('invalid_tool', 'AI tool description is required');
  }

  let parameters: Record<string, unknown>;
  try {
    parameters =
      options.jsonSchema === undefined
        ? contract.jsonSchema
        : z.toJSONSchema(contract.schema, {
            unrepresentable: 'throw',
            ...options.jsonSchema,
            io: 'input',
          });
  } catch {
    throw new AiError('invalid_tool', 'AI tool input schema cannot be represented');
  }

  return Object.freeze({
    name,
    description,
    parameters,
    call: async (args: Record<string, unknown>) => {
      let input: z.infer<z.ZodObject<P>>;
      try {
        input = contract.schema.parse(args);
      } catch {
        throw new AiError(
          'invalid_tool_arguments',
          'AI tool arguments do not match the data contract',
        );
      }
      const result = await options.call(input);
      if (options.returns === undefined) return result;
      try {
        return options.returns.schema.parse(result);
      } catch {
        throw new AiError(
          'invalid_tool_result',
          'AI tool result does not match the return contract',
        );
      }
    },
  });
}
