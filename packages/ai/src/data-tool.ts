/**
 * Project a named data contract to the AI tool wire shape.
 *
 * The data contract remains the source of truth for validation. The tool
 * validates every model argument through the same schema before calling the
 * handler, and exposes the input JSON Schema as `parameters`.
 */

import type { AnyDataContract, DataContract, DataJsonSchemaOptions } from 'jsails/data';
import { isRecord } from 'jsails/plugin-sdk';
import { z } from 'zod';
import { AiError, type AiTool } from './contracts.js';

/** Provider-safe tool names (OpenAI/Anthropic-compatible). */
const AI_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Options for {@link aiTool}. */
export interface AiToolOptions<P extends z.ZodRawShape> {
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

/** Whether `value` has a data contract's `schema.parse`. */
function isDataContract(value: unknown): value is AnyDataContract {
  return isRecord(value) && isRecord(value.schema) && typeof value.schema.parse === 'function';
}

/**
 * Create an {@link AiTool} from a data contract. The input JSON Schema is
 * generated with `io: 'input'`; a contract that cannot be represented fails
 * at construction with `AiError('invalid_tool')` rather than sending a
 * partial schema.
 */
export function aiTool<P extends z.ZodRawShape>(
  contract: DataContract<P>,
  options: AiToolOptions<P>,
): AiTool {
  if (!isDataContract(contract)) {
    throw new TypeError('aiTool requires a data contract');
  }
  const raw: unknown = options;
  if (!isRecord(raw)) {
    throw new TypeError('aiTool requires an options object');
  }
  if (options.returns !== undefined && !isDataContract(options.returns)) {
    throw new TypeError('aiTool.returns must be a data contract');
  }
  if (typeof options.call !== 'function') {
    throw new TypeError('aiTool.call must be a function');
  }

  const name = options.name ?? contract.name;
  if (typeof name !== 'string' || !AI_TOOL_NAME_PATTERN.test(name)) {
    throw new AiError('invalid_tool', 'the AI tool name is invalid');
  }
  const description = options.description ?? contract.description;
  if (typeof description !== 'string' || description.trim() === '') {
    throw new AiError('invalid_tool', 'an AI tool description is required');
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
    throw new AiError('invalid_tool', 'the AI tool input schema cannot be represented');
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
          'the AI tool arguments do not match the data contract',
        );
      }
      const result = await options.call(input);
      if (options.returns === undefined) {
        return result;
      }
      try {
        return options.returns.schema.parse(result);
      } catch {
        throw new AiError(
          'invalid_tool_result',
          'the AI tool result does not match the return contract',
        );
      }
    },
  });
}
