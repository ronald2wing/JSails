/**
 * Building a Messages API request from a neutral {@link AiProviderRequest}.
 *
 * - Instructions become the top-level `system` array; a mid-conversation
 *   `system` message stays a `role: 'system'` message (the operator channel).
 * - An assistant message whose raw content came from Anthropic is replayed
 *   from that raw content, byte for byte and whatever model produced it
 *   (thinking blocks with their signatures, citations, fallback and
 *   server-tool blocks, and block types this adapter does not know). The API
 *   itself drops, unbilled, a thinking block the current model cannot read;
 *   dropping it here would be a history edit that preserved thinking
 *   rejects. An assistant message from another provider is rebuilt from its
 *   neutral parts, without its reasoning.
 * - Tool results stay grouped in the user message after the calls. Tool-call
 *   ids from another provider are mapped to ids the API accepts.
 * - Sampling parameters (`temperature`, `top_p`, `top_k`) and forced
 *   `tool_choice` are never sent: current models reject them. `toolChoice:
 *   'none'` and `disable_parallel_tool_use` are sent when asked for.
 * - With `cache: 'auto'`, the request sets the top-level automatic cache
 *   breakpoint and honors the earliest explicit `cache` marks (instructions,
 *   then messages) up to the API's limit of four breakpoints in all; the
 *   automatic one already covers the growing tail, so explicit marks are kept
 *   for the stable prefix. With `cache: 'off'` no breakpoint is sent.
 * - Tools are sent in declared order with canonically ordered schema
 *   keywords, so identical options always produce an identical body.
 */

import { AiError } from '../errors/ai-error.js';
import type { AiMessage, AiPart, AiToolOutput } from '../content/types.js';
import type { AiProviderRequest, AiToolSpec } from '../provider/contract.js';
import { canonicalSchema, decodeBase64Text, fitToolCallId } from '../provider/wire-format.js';
import { FALLBACK_BETA, readAnthropicOptions } from './anthropic-options.js';
import type {
  AnthropicAssistantBlock,
  AnthropicCacheControl,
  AnthropicCountTokensRequest,
  AnthropicImageBlock,
  AnthropicTextBlock,
  AnthropicUserBlock,
  AnthropicWireMessage,
  AnthropicWireRequest,
  AnthropicWireTool,
} from './anthropic-wire.js';

/** The provider id; native content tagged with it is replayed verbatim. */
export const ANTHROPIC_PROVIDER_ID = 'anthropic';

/** The most cache breakpoints one request may carry. */
export const MAX_CACHE_BREAKPOINTS = 4;

/** The longest tool-call id the adapter sends. */
const MAX_TOOL_ID_LENGTH = 64;

/** How the provider was configured, as the request builder needs it. */
export interface AnthropicRequestConfig {
  readonly cacheTtl: '5m' | '1h' | undefined;
  readonly eagerInputStreaming: boolean;
}

/** A built request: the body and the extra headers it needs. */
export interface AnthropicBuiltRequest<B> {
  readonly body: B;
  readonly headers: Readonly<Record<string, string>>;
}

/** Hands out cache breakpoints in render order until the budget is spent. */
class BreakpointBudget {
  #remaining: number;
  readonly #control: AnthropicCacheControl | undefined;

  constructor(enabled: boolean, explicit: number, ttl: '5m' | '1h' | undefined) {
    this.#remaining = enabled ? explicit : 0;
    this.#control = enabled
      ? ttl === undefined
        ? { type: 'ephemeral' }
        : { type: 'ephemeral', ttl }
      : undefined;
  }

  /** The breakpoint for a part marked `cache`, while the budget lasts. */
  take(marked: boolean | undefined): { cache_control?: AnthropicCacheControl } {
    if (marked !== true || this.#control === undefined || this.#remaining === 0) return {};
    this.#remaining -= 1;
    return { cache_control: { ...this.#control } };
  }

  /** The top-level automatic breakpoint, or nothing when caching is off. */
  automatic(): { cache_control?: AnthropicCacheControl } {
    return this.#control === undefined ? {} : { cache_control: { ...this.#control } };
  }
}

function unsupported(capability: string): AiError {
  return new AiError('unsupported_capability', 'the provider cannot take this content', {
    context: { provider: ANTHROPIC_PROVIDER_ID, capability },
  });
}

function toolId(id: string): string {
  return fitToolCallId(id, MAX_TOOL_ID_LENGTH);
}

function toolResultContent(output: AiToolOutput): AnthropicToolResultBlock['content'] {
  if (typeof output === 'string') return output;
  return output.map((item): AnthropicTextBlock | AnthropicImageBlock =>
    item.type === 'text'
      ? { type: 'text', text: item.text }
      : {
          type: 'image',
          source:
            item.source.kind === 'base64'
              ? {
                  type: 'base64',
                  media_type: item.source.mediaType as AnthropicImageMediaType,
                  data: item.source.data,
                }
              : { type: 'url', url: item.source.url },
        },
  );
}

type AnthropicImageMediaType = Extract<
  AnthropicImageBlock['source'],
  { type: 'base64' }
>['media_type'];
type AnthropicToolResultBlock = Extract<AnthropicUserBlock, { type: 'tool_result' }>;

function userBlock(part: AiPart, budget: BreakpointBudget): AnthropicUserBlock | undefined {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text, ...budget.take(part.cache) };
    case 'image':
      return {
        type: 'image',
        source:
          part.source.kind === 'base64'
            ? {
                type: 'base64',
                media_type: part.source.mediaType as AnthropicImageMediaType,
                data: part.source.data,
              }
            : { type: 'url', url: part.source.url },
        ...budget.take(part.cache),
      };
    case 'file': {
      let source: Extract<AnthropicUserBlock, { type: 'document' }>['source'];
      if (part.mediaType === 'application/pdf') {
        source =
          part.source.kind === 'base64'
            ? { type: 'base64', media_type: 'application/pdf', data: part.source.data }
            : { type: 'url', url: part.source.url };
      } else {
        if (part.source.kind !== 'base64') throw unsupported('text_file_url');
        source = {
          type: 'text',
          media_type: 'text/plain',
          data: decodeBase64Text(part.source.data),
        };
      }
      return {
        type: 'document',
        source,
        ...(part.title === undefined ? {} : { title: part.title }),
        ...budget.take(part.cache),
      };
    }
    case 'tool-result':
      return {
        type: 'tool_result',
        tool_use_id: toolId(part.id),
        content: toolResultContent(part.output),
        ...(part.isError ? { is_error: true as const } : {}),
        ...budget.take(part.cache),
      };
    default:
      return undefined;
  }
}

function assistantContent(message: AiMessage, budget: BreakpointBudget): AnthropicAssistantBlock[] {
  if (message.native?.provider === ANTHROPIC_PROVIDER_ID) {
    // Verbatim replay: the stored raw blocks, unchanged and in order.
    return [...message.native.content] as AnthropicAssistantBlock[];
  }
  const blocks: AnthropicAssistantBlock[] = [];
  for (const part of message.parts) {
    if (part.type === 'text' && part.text.length > 0) {
      blocks.push({ type: 'text', text: part.text, ...budget.take(part.cache) });
    } else if (part.type === 'tool-call') {
      blocks.push({ type: 'tool_use', id: toolId(part.id), name: part.name, input: part.input });
    }
  }
  return blocks;
}

function wireMessages(
  messages: readonly AiMessage[],
  budget: BreakpointBudget,
): AnthropicWireMessage[] {
  const wire: AnthropicWireMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const content = assistantContent(message, budget);
      // An assistant turn with nothing replayable (an empty reply, or only
      // another provider's reasoning) is left out: the API rejects empty
      // content, and consecutive turns of one role are merged by the API.
      if (content.length > 0) wire.push({ role: 'assistant', content });
    } else if (message.role === 'system') {
      const content: AnthropicTextBlock[] = [];
      for (const part of message.parts) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text, ...budget.take(part.cache) });
        }
      }
      wire.push({ role: 'system', content });
    } else {
      const content: AnthropicUserBlock[] = [];
      for (const part of message.parts) {
        const block = userBlock(part, budget);
        if (block !== undefined) content.push(block);
      }
      wire.push({ role: 'user', content });
    }
  }
  return wire;
}

function wireTool(spec: AiToolSpec, eager: boolean): AnthropicWireTool {
  const schema = canonicalSchema(spec.inputSchema);
  if (schema.type !== 'object') {
    throw new AiError('invalid_tool', 'a tool input schema must describe an object', {
      context: { provider: ANTHROPIC_PROVIDER_ID },
    });
  }
  return {
    name: spec.name,
    description: spec.description,
    input_schema: schema as AnthropicWireTool['input_schema'],
    ...(spec.strict ? { strict: true as const } : {}),
    ...(eager ? { eager_input_streaming: true as const } : {}),
  };
}

function countBody(
  request: AiProviderRequest,
  config: AnthropicRequestConfig,
  speed: 'fast' | undefined,
): AnthropicCountTokensRequest {
  const budget = new BreakpointBudget(
    request.cache === 'auto',
    MAX_CACHE_BREAKPOINTS - 1,
    config.cacheTtl,
  );
  const system = request.instructions.map((block): AnthropicTextBlock => ({
    type: 'text',
    text: block.text,
    ...budget.take(block.cache),
  }));
  const messages = wireMessages(request.messages, budget);
  const tools = request.tools.map((spec) => wireTool(spec, config.eagerInputStreaming));
  let toolChoice: AnthropicCountTokensRequest['tool_choice'];
  if (tools.length > 0) {
    if (request.toolChoice === 'none') toolChoice = { type: 'none' };
    else if (!request.parallelToolCalls)
      toolChoice = { type: 'auto', disable_parallel_tool_use: true };
  }
  const outputConfig: NonNullable<AnthropicCountTokensRequest['output_config']> = {
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    ...(request.output === undefined
      ? {}
      : {
          format: {
            type: 'json_schema' as const,
            schema: canonicalSchema(request.output.schema),
          },
        }),
  };
  return {
    model: request.model,
    ...(system.length === 0 ? {} : { system }),
    messages,
    ...(tools.length === 0 ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(request.reasoning === undefined
      ? {}
      : { thinking: { type: 'adaptive' as const, display: request.reasoning } }),
    ...(Object.keys(outputConfig).length === 0 ? {} : { output_config: outputConfig }),
    ...budget.automatic(),
    ...(speed === undefined ? {} : { speed }),
  };
}

function betaHeaders(betas: readonly string[]): Readonly<Record<string, string>> {
  const unique = [...new Set(betas)];
  return unique.length === 0 ? {} : { 'anthropic-beta': unique.join(',') };
}

/**
 * The streaming Messages API request for `request`. Throws
 * `AiError('invalid_options')` for bad `providerOptions.anthropic`,
 * `invalid_tool` for a non-object tool schema, and `unsupported_capability`
 * for content the API cannot take (a plain-text file by URL).
 */
export function buildAnthropicRequest(
  request: AiProviderRequest,
  config: AnthropicRequestConfig,
): AnthropicBuiltRequest<AnthropicWireRequest> {
  const extras = readAnthropicOptions(request.providerOptions);
  const shared = countBody(request, config, extras.speed);
  const body: AnthropicWireRequest = {
    ...shared,
    max_tokens: request.maxOutputTokens,
    ...(request.stopSequences === undefined ? {} : { stop_sequences: [...request.stopSequences] }),
    ...(extras.inferenceGeo === undefined ? {} : { inference_geo: extras.inferenceGeo }),
    ...(extras.userId === undefined ? {} : { metadata: { user_id: extras.userId } }),
    ...(extras.fallbacks === undefined
      ? {}
      : {
          fallbacks:
            extras.fallbacks === 'default'
              ? ('default' as const)
              : extras.fallbacks.map((entry) => ({ model: entry.model })),
        }),
    stream: true,
  };
  const betas = extras.fallbacks === undefined ? extras.betas : [...extras.betas, FALLBACK_BETA];
  return { body, headers: betaHeaders(betas) };
}

/** The token-count request for `request` (the fields `count_tokens` accepts). */
export function buildAnthropicCountRequest(
  request: AiProviderRequest,
  config: AnthropicRequestConfig,
): AnthropicBuiltRequest<AnthropicCountTokensRequest> {
  const extras = readAnthropicOptions(request.providerOptions);
  return { body: countBody(request, config, extras.speed), headers: betaHeaders(extras.betas) };
}
