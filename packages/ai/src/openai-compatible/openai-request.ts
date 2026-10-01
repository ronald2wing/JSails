/**
 * Building a Chat Completions request from a neutral
 * {@link AiProviderRequest}.
 *
 * - Instructions become one message in the configured role (`system` or
 *   `developer`); a mid-conversation `system` message is sent in that role
 *   too.
 * - The neutral user message that answers tool calls is split: one
 *   `role: 'tool'` message per result (Chat Completions has no error flag,
 *   so an error result is sent as its fixed error text), then a user message
 *   with any images the tools returned (a tool message carries text only)
 *   and the rest of the user's parts.
 * - Assistant messages are rebuilt from their neutral parts. Reasoning is not
 *   replayable over Chat Completions and is dropped; no provider's raw
 *   content is sent.
 * - Images, PDFs, tools, and structured output are sent only when the server
 *   supports them; otherwise the request fails with `unsupported_capability`
 *   instead of being silently degraded. Tool-call ids are mapped to ids of at
 *   most 40 characters.
 * - Tools are sent in declared order with canonically ordered schema
 *   keywords, so identical options produce an identical body (prefix caching).
 */

import { AiError } from '../errors/ai-error.js';
import { AI_EFFORTS, type AiEffort, type AiMessage, type AiPart } from '../content/types.js';
import type { AiProviderRequest, AiToolSpec } from '../provider/contract.js';
import { canonicalSchema, decodeBase64Text, fitToolCallId } from '../provider/wire-format.js';
import { readOpenAICompatibleOptions, type OpenAICompatibleConfig } from './openai-options.js';
import type {
  OpenAIContentPart,
  OpenAIToolCall,
  OpenAIWireMessage,
  OpenAIWireRequest,
  OpenAIWireTool,
} from './openai-wire.js';

/** The longest tool-call id the adapter sends (the OpenAI limit). */
export const MAX_OPENAI_TOOL_ID_LENGTH = 40;

function unsupported(config: OpenAICompatibleConfig, capability: string): AiError {
  return new AiError('unsupported_capability', 'the provider cannot take this content', {
    context: { provider: config.id, capability },
  });
}

function wireId(id: string): string {
  return fitToolCallId(id, MAX_OPENAI_TOOL_ID_LENGTH);
}

function mediaPart(part: AiPart, config: OpenAICompatibleConfig): OpenAIContentPart | undefined {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      if (!config.capabilities.images) throw unsupported(config, 'images');
      return {
        type: 'image_url',
        image_url: {
          url:
            part.source.kind === 'base64'
              ? `data:${part.source.mediaType};base64,${part.source.data}`
              : part.source.url,
        },
      };
    case 'file':
      if (part.source.kind !== 'base64') throw unsupported(config, 'file_url');
      if (part.mediaType === 'text/plain') {
        return { type: 'text', text: decodeBase64Text(part.source.data) };
      }
      if (!config.capabilities.pdf) throw unsupported(config, 'pdf');
      return {
        type: 'file',
        file: {
          file_data: `data:application/pdf;base64,${part.source.data}`,
          filename: part.title ?? 'document.pdf',
        },
      };
    default:
      return undefined;
  }
}

function userMessages(message: AiMessage, config: OpenAICompatibleConfig): OpenAIWireMessage[] {
  const out: OpenAIWireMessage[] = [];
  const content: OpenAIContentPart[] = [];
  for (const part of message.parts) {
    if (part.type !== 'tool-result') continue;
    let text: string;
    if (typeof part.output === 'string') {
      text = part.output;
    } else {
      const texts: string[] = [];
      for (const item of part.output) {
        if (item.type === 'text') {
          texts.push(item.text);
        } else {
          const image = mediaPart({ type: 'image', source: item.source }, config);
          if (image !== undefined) content.push(image);
        }
      }
      text = texts.join('\n\n');
    }
    out.push({ role: 'tool', tool_call_id: wireId(part.id), content: text });
  }
  for (const part of message.parts) {
    const media = mediaPart(part, config);
    if (media !== undefined) content.push(media);
  }
  if (content.length === 1 && content[0]?.type === 'text') {
    out.push({ role: 'user', content: content[0].text });
  } else if (content.length > 0) {
    out.push({ role: 'user', content });
  }
  return out;
}

function assistantMessage(message: AiMessage): OpenAIWireMessage | undefined {
  let text = '';
  const calls: OpenAIToolCall[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') text += part.text;
    else if (part.type === 'tool-call') {
      calls.push({
        id: wireId(part.id),
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.input) },
      });
    }
  }
  if (text.length === 0 && calls.length === 0) return undefined;
  return {
    role: 'assistant',
    content: text.length > 0 ? text : null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
  };
}

function operatorMessage(text: string, config: OpenAICompatibleConfig): OpenAIWireMessage {
  return config.instructionsRole === 'developer'
    ? { role: 'developer', content: text }
    : { role: 'system', content: text };
}

function wireTool(spec: AiToolSpec): OpenAIWireTool {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: canonicalSchema(spec.inputSchema),
      ...(spec.strict ? { strict: true as const } : {}),
    },
  };
}

function clampEffort(effort: AiEffort, max: AiEffort): OpenAIWireRequest['reasoning_effort'] {
  const level = Math.min(AI_EFFORTS.indexOf(effort), AI_EFFORTS.indexOf(max));
  const clamped = AI_EFFORTS[level] ?? 'high';
  return clamped;
}

/**
 * The streaming Chat Completions request for `request`. Throws
 * `AiError('unsupported_capability')` for content or features the server does
 * not support and `invalid_options` for bad `providerOptions.openaiCompatible`.
 */
export function buildOpenAIRequest(
  request: AiProviderRequest,
  config: OpenAICompatibleConfig,
): OpenAIWireRequest {
  const options = readOpenAICompatibleOptions(request.providerOptions);
  const capabilities = config.capabilities;
  if (request.tools.length > 0 && !capabilities.tools) throw unsupported(config, 'tools');
  if (request.output !== undefined && capabilities.structuredOutput !== 'native') {
    throw unsupported(config, 'structured_output');
  }
  const messages: OpenAIWireMessage[] = [];
  const instructions = request.instructions.map((block) => block.text).join('\n\n');
  if (instructions.length > 0) messages.push(operatorMessage(instructions, config));
  for (const message of request.messages) {
    if (message.role === 'user') {
      messages.push(...userMessages(message, config));
    } else if (message.role === 'assistant') {
      const wire = assistantMessage(message);
      if (wire !== undefined) messages.push(wire);
    } else {
      const text = message.parts
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n\n');
      messages.push(operatorMessage(text, config));
    }
  }
  const tools = request.tools.map(wireTool);
  const strictOutput = capabilities.schemaProfile === 'openai-strict';
  return {
    model: request.model,
    messages,
    ...(tools.length === 0 ? {} : { tools }),
    ...(tools.length > 0 && request.toolChoice === 'none' ? { tool_choice: 'none' as const } : {}),
    ...(tools.length > 0 && !request.parallelToolCalls && capabilities.parallelTools
      ? { parallel_tool_calls: false as const }
      : {}),
    ...(config.maxTokensField === 'max_tokens'
      ? { max_tokens: request.maxOutputTokens }
      : { max_completion_tokens: request.maxOutputTokens }),
    ...(request.stopSequences === undefined ? {} : { stop: [...request.stopSequences] }),
    ...(request.output === undefined
      ? {}
      : {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: request.output.name,
              schema: canonicalSchema(request.output.schema),
              strict: strictOutput,
            },
          },
        }),
    ...(request.effort !== undefined && capabilities.reasoning
      ? { reasoning_effort: clampEffort(request.effort, config.maxReasoningEffort) }
      : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.topP === undefined ? {} : { top_p: options.topP }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.promptCacheKey === undefined ? {} : { prompt_cache_key: options.promptCacheKey }),
    ...(options.user === undefined ? {} : { user: options.user }),
    stream: true,
    ...(config.streamUsage ? { stream_options: { include_usage: true as const } } : {}),
  };
}
