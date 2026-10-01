/**
 * {@link generateObject}: one model call whose answer is a value of a schema.
 *
 * The schema is lowered for the provider's profile and sent as a native
 * response format when the provider has one, or as a single tool the model is
 * asked to call when it does not (forced tool choice is rejected by current
 * Claude models, so the fallback steers through instructions). A refusal is
 * `refused`, a cut-off answer is `output_truncated`, and anything that does
 * not parse, restore, and pass the full Zod schema is `output_invalid`. A
 * schema whose root is not an object is wrapped in `{ value }` on the wire
 * (both strict modes need an object root) and unwrapped before validation.
 * The root property `INVALID_JSON` is reserved, as for tool inputs. A deadline
 * or abort settles the call even when the provider ignores its signal.
 */

import { AiError, isAiError } from '../errors/ai-error.js';
import { isPlainObject } from '../content/json-value.js';
import { textOf } from '../content/messages.js';
import type { AiEffort, AiMessage } from '../content/types.js';
import { toolCallsOf, validateMessages } from '../content/validate-messages.js';
import type {
  AiInstruction,
  AiModel,
  AiProviderOptions,
  AiProviderRequest,
  AiProviderResponse,
} from '../provider/contract.js';
import { checkProviderResponse, readResponseMessage } from '../provider/provider-response.js';
import { INVALID_JSON_KEY, isUnparsedInput } from '../provider/wire-format.js';
import {
  readCacheMode,
  readEffort,
  readHeaders,
  readInstructions,
  readMaxOutputTokens,
  readModel,
  readReasoning,
  readTimeout,
} from '../provider/request-fields.js';
import { costMicroUsd, type AiPricing } from '../usage/pricing.js';
import type { AiUsage } from '../usage/usage.js';
import { lowerZodSchema, type AiLoweredSchema, type AiSchemaProfile } from './schema-lowering.js';
import type { JsonSchema } from './schema-restore.js';
import { resolveSchemaSource, type AiSchemaOutput, type AiSchemaSource } from './schema-source.js';

/** Options for {@link generateObject}. */
export interface GenerateObjectOptions<S extends AiSchemaSource> {
  readonly model: AiModel;
  readonly instructions?: string | readonly AiInstruction[];
  readonly messages: readonly AiMessage[];
  readonly schema: S;
  /** The output name the provider sees (default: the contract name, else `output`). */
  readonly name?: string;
  /** Default 16 000. */
  readonly maxOutputTokens?: number;
  readonly effort?: AiEffort;
  readonly reasoning?: 'omitted' | 'summarized';
  /** Prompt caching (default `auto`). */
  readonly cache?: 'auto' | 'off';
  readonly signal?: AbortSignal;
  /** A deadline for the call in milliseconds; 0 or absent means none. */
  readonly timeoutMs?: number;
  /** Propagation headers (traceparent, baggage) forwarded to the provider. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly providerOptions?: AiProviderOptions;
  readonly pricing?: AiPricing;
}

/** The value and the response it came from. */
export interface AiObjectResult<T> {
  readonly object: T;
  readonly response: AiProviderResponse;
  readonly usage: AiUsage;
  /** Present when `pricing` was given. */
  readonly costMicroUsd?: number;
}

const OUTPUT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function invalidOptions(reason: string): AiError {
  return new AiError('invalid_options', 'the generateObject options are invalid', {
    context: { reason },
  });
}

function invalidOutput(reason: string): AiError {
  return new AiError('output_invalid', 'the model output does not match the schema', {
    context: { reason },
  });
}

/** A lowered schema made fit for the wire: an object root, wrapping when needed. */
interface WireSchema {
  readonly schema: JsonSchema;
  readonly wrapped: boolean;
  readonly lowered: AiLoweredSchema;
}

const wireCache = new WeakMap<AiLoweredSchema, WireSchema>();

function wireSchema(lowered: AiLoweredSchema): WireSchema {
  const cached = wireCache.get(lowered);
  if (cached !== undefined) return cached;
  const root = lowered.schema;
  let wire: WireSchema;
  if (root.type === 'object' && root.anyOf === undefined && root.oneOf === undefined) {
    wire = { schema: root, wrapped: false, lowered };
  } else {
    if (JSON.stringify(root).includes('"$ref":"#"')) {
      throw new AiError(
        'unsupported_capability',
        'a recursive non-object output schema is not supported',
      );
    }
    const value: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(root)) {
      if (key !== '$defs' && key !== 'definitions') value[key] = entry;
    }
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: { value },
      required: ['value'],
      additionalProperties: false,
    };
    if (root.$defs !== undefined) schema.$defs = root.$defs;
    wire = { schema: Object.freeze(schema), wrapped: true, lowered };
  }
  wireCache.set(lowered, wire);
  return wire;
}

function extractRaw(message: AiMessage, mode: 'native' | 'tool', name: string): unknown {
  if (mode === 'tool') {
    const call = toolCallsOf(message).find((part) => part.name === name);
    if (call === undefined) throw invalidOutput('no_tool_call');
    // The adapter wraps an input that was not a JSON object; it is never an answer.
    if (isUnparsedInput(call.input)) throw invalidOutput('json');
    return call.input;
  }
  const text = textOf(message).trim();
  if (text.length === 0) throw invalidOutput('empty');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidOutput('json');
  }
}

/**
 * `call()`, settled early when `signal` fires: a provider that ignores its
 * signal is abandoned rather than awaited, so a deadline or abort always ends
 * the call.
 */
function settleWithin<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stopped = (): void => reject(new AiError('aborted', 'the call was aborted'));
    if (signal.aborted) {
      stopped();
      return;
    }
    signal.addEventListener('abort', stopped, { once: true });
    Promise.resolve()
      .then(call)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stopped));
  });
}

/**
 * Ask the model for a value of `schema`. See the module comment for the
 * error mapping; every failure is a value-free {@link AiError}.
 */
export async function generateObject<S extends AiSchemaSource>(
  options: GenerateObjectOptions<S>,
): Promise<AiObjectResult<AiSchemaOutput<S>>> {
  if (typeof options !== 'object' || options === null) throw invalidOptions('options');
  const model = readModel(options.model, invalidOptions);
  const provider = model.provider;
  const source = resolveSchemaSource(options.schema);
  if (source === undefined) throw invalidOptions('schema');
  const name =
    options.name ??
    (source.name !== undefined && OUTPUT_NAME_PATTERN.test(source.name) ? source.name : 'output');
  if (!OUTPUT_NAME_PATTERN.test(name)) throw invalidOptions('name');
  const maxOutputTokens = readMaxOutputTokens(options.maxOutputTokens, invalidOptions);
  const effort = readEffort(options.effort, invalidOptions);
  const reasoning = readReasoning(options.reasoning, invalidOptions);
  const cache = readCacheMode(options.cache, invalidOptions);
  const timeoutMs = readTimeout(options.timeoutMs, 0, 'timeout', invalidOptions);
  const headers = readHeaders(options.headers, invalidOptions);
  const messages = validateMessages(options.messages);
  const instructions = readInstructions(options.instructions, invalidOptions);

  const capabilities = provider.capabilities;
  const mode = capabilities.structuredOutput;
  if (mode === 'none') {
    throw new AiError('unsupported_capability', 'the provider does not support structured output');
  }
  const profile: AiSchemaProfile =
    mode === 'native' || capabilities.strictTools ? capabilities.schemaProfile : 'loose';
  const wire = wireSchema(lowerZodSchema(source.schema, profile, 'invalid_options'));
  const wireProperties = wire.schema.properties;
  if (isPlainObject(wireProperties) && Object.hasOwn(wireProperties, INVALID_JSON_KEY)) {
    throw invalidOptions('reserved_property');
  }

  const request: AiProviderRequest =
    mode === 'native'
      ? {
          model: model.id,
          instructions,
          messages,
          tools: [],
          toolChoice: 'none',
          parallelToolCalls: false,
          maxOutputTokens,
          output: { name, schema: wire.schema },
          cache,
          ...(effort === undefined ? {} : { effort }),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(options.providerOptions === undefined
            ? {}
            : { providerOptions: options.providerOptions }),
        }
      : {
          model: model.id,
          instructions: [
            ...instructions,
            { text: `Answer only by calling the ${name} tool exactly once with the final answer.` },
          ],
          messages,
          tools: [
            {
              name,
              description: 'Submit the final answer.',
              inputSchema: wire.schema,
              strict: profile !== 'loose',
            },
          ],
          toolChoice: 'auto',
          parallelToolCalls: false,
          maxOutputTokens,
          cache,
          ...(effort === undefined ? {} : { effort }),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(options.providerOptions === undefined
            ? {}
            : { providerOptions: options.providerOptions }),
        };

  const controller = new AbortController();
  const external = options.signal;
  let timedOut = false;
  const onAbort = (): void => controller.abort();
  if (external?.aborted === true) throw new AiError('aborted', 'the call was aborted');
  external?.addEventListener('abort', onAbort, { once: true });
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  let response: AiProviderResponse;
  try {
    response = checkProviderResponse(
      await settleWithin(
        () => provider.generate(request, { signal: controller.signal, headers }),
        controller.signal,
      ),
    );
  } catch (error) {
    if (timedOut) throw new AiError('timed_out', 'the call timed out');
    if (controller.signal.aborted) throw new AiError('aborted', 'the call was aborted');
    if (isAiError(error)) throw error;
    throw new AiError('provider_failed', 'the provider call failed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  }

  switch (response.finishReason) {
    case 'refusal':
    case 'content-filter':
      throw new AiError('refused', 'the model declined to answer');
    case 'length':
      throw new AiError('output_truncated', 'the model output was cut off at the token limit', {
        suggestion: 'Raise maxOutputTokens.',
      });
    case 'pause':
      throw invalidOutput('incomplete');
    default:
      break;
  }

  let raw = extractRaw(readResponseMessage(response, provider.id, 0), mode, name);
  if (wire.wrapped) {
    if (!isPlainObject(raw) || !Object.hasOwn(raw, 'value')) throw invalidOutput('shape');
    raw = raw.value;
  }
  const parsed = source.schema.safeParse(wire.lowered.restore(raw));
  if (!parsed.success) throw invalidOutput('schema');
  const result: AiObjectResult<AiSchemaOutput<S>> = {
    object: parsed.data as AiSchemaOutput<S>,
    response,
    usage: response.usage,
    ...(options.pricing === undefined
      ? {}
      : { costMicroUsd: costMicroUsd(response.iterations, options.pricing) }),
  };
  return Object.freeze(result);
}
