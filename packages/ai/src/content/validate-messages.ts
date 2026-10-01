/**
 * Transcript validation: {@link validateMessages} checks a message list
 * against the rules every first-party provider enforces and returns a
 * normalized, deep-frozen copy.
 *
 * Rules: known roles and part types, parts allowed per role, the first
 * message is a user message, a mid-conversation system message follows a user
 * message and is last or followed by an assistant message, every tool call is
 * answered by exactly one tool result in the immediately following user
 * message (results first in that message, names matching), tool-call and
 * tool-result ids are unique across the whole conversation, and, for a request
 * (as opposed to a stored transcript), the list does not end with an assistant
 * message (assistant prefill is rejected by current Claude models). Failures
 * are `AiError('invalid_messages')` carrying only the message index and a
 * static rule name.
 */

import { AiError } from '../errors/ai-error.js';
import { isAiUsage, type AiUsage } from '../usage/usage.js';
import { copyJson, isPlainObject } from './json-value.js';
import { isBase64, parseMediaUrl } from './media.js';
import {
  AI_FILE_MEDIA_TYPES,
  AI_FINISH_REASONS,
  AI_IMAGE_MEDIA_TYPES,
  AI_ROLES,
  type AiFileMediaType,
  type AiFinishReason,
  type AiMediaSource,
  type AiMessage,
  type AiMessageMeta,
  type AiNativeContent,
  type AiPart,
  type AiRole,
  type AiToolCallPart,
  type AiToolOutput,
  type AiToolOutputItem,
  type AiToolResultPart,
} from './types.js';

/** How {@link validateMessages} judges the end of the list. */
export interface ValidateMessagesOptions {
  /**
   * `'request'` (default): the list is about to be sent to a provider; it must
   * be non-empty and must not end with an assistant message. `'transcript'`:
   * a stored conversation; it may be empty, may end with an assistant
   * message, and its last message may hold tool calls still awaiting results.
   */
  readonly mode?: 'request' | 'transcript';
}

/** The longest id, name, provider, or model string accepted. */
const MAX_LABEL_LENGTH = 256;

/** A static rule name a validation failure reports. */
export type MessageRule =
  | 'not_array'
  | 'empty'
  | 'not_object'
  | 'role'
  | 'parts'
  | 'empty_message'
  | 'part_type'
  | 'part_role'
  | 'text'
  | 'media_source'
  | 'media_type'
  | 'title'
  | 'cache'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'native'
  | 'meta'
  | 'first_message'
  | 'trailing_assistant'
  | 'system_placement'
  | 'tool_result_order'
  | 'tool_result_unmatched'
  | 'tool_result_missing'
  | 'tool_result_name'
  | 'duplicate_tool_call_id'
  | 'duplicate_tool_result_id'
  | 'dangling_tool_call';

/** Raise the value-free `invalid_messages` error for `rule` at message `index`. */
export function invalidMessages(rule: MessageRule, index?: number): AiError {
  return new AiError('invalid_messages', 'the messages are invalid', {
    context: index === undefined ? { rule } : { rule, index },
  });
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LABEL_LENGTH;
}

function hasVisibleText(text: string): boolean {
  return text.trim().length > 0;
}

function readCache(record: Record<string, unknown>, index: number): { readonly cache?: true } {
  if (record.cache === undefined) return {};
  if (record.cache !== true) throw invalidMessages('cache', index);
  return { cache: true };
}

/** Parse a media source whose base64 media type must be one of `allowedTypes`. */
export function readMediaSource(
  value: unknown,
  index: number,
  allowedTypes: readonly string[],
): AiMediaSource {
  if (!isPlainObject(value)) throw invalidMessages('media_source', index);
  if (value.kind === 'base64') {
    if (typeof value.mediaType !== 'string' || !allowedTypes.includes(value.mediaType)) {
      throw invalidMessages('media_type', index);
    }
    if (typeof value.data !== 'string' || !isBase64(value.data)) {
      throw invalidMessages('media_source', index);
    }
    return Object.freeze({ kind: 'base64', mediaType: value.mediaType, data: value.data });
  }
  if (value.kind === 'url') {
    if (
      typeof value.url !== 'string' ||
      parseMediaUrl(value.url, ['https:', 'http:']) === undefined
    ) {
      throw invalidMessages('media_source', index);
    }
    return Object.freeze({ kind: 'url', url: value.url });
  }
  throw invalidMessages('media_source', index);
}

/** Parse a tool output (a string, or text and image items). */
export function readToolOutput(value: unknown, index: number): AiToolOutput {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw invalidMessages('tool_result', index);
  const items: AiToolOutputItem[] = [];
  for (const item of value as readonly unknown[]) {
    if (!isPlainObject(item)) throw invalidMessages('tool_result', index);
    if (item.type === 'text' && typeof item.text === 'string') {
      items.push(Object.freeze({ type: 'text', text: item.text }));
    } else if (item.type === 'image') {
      items.push(
        Object.freeze({
          type: 'image',
          source: readMediaSource(item.source, index, AI_IMAGE_MEDIA_TYPES),
        }),
      );
    } else {
      throw invalidMessages('tool_result', index);
    }
  }
  return Object.freeze(items);
}

const PARTS_BY_ROLE: Readonly<Record<AiRole, readonly AiPart['type'][]>> = {
  user: ['text', 'image', 'file', 'tool-result'],
  assistant: ['text', 'reasoning', 'tool-call'],
  system: ['text'],
};

function readPart(value: unknown, role: AiRole, index: number): AiPart {
  if (!isPlainObject(value) || typeof value.type !== 'string') {
    throw invalidMessages('part_type', index);
  }
  const type = value.type;
  if (!['text', 'image', 'file', 'reasoning', 'tool-call', 'tool-result'].includes(type)) {
    throw invalidMessages('part_type', index);
  }
  if (!PARTS_BY_ROLE[role].includes(type as AiPart['type'])) {
    throw invalidMessages('part_role', index);
  }
  switch (type) {
    case 'text': {
      if (typeof value.text !== 'string') throw invalidMessages('text', index);
      if (role !== 'assistant' && !hasVisibleText(value.text)) throw invalidMessages('text', index);
      return Object.freeze({ type: 'text', text: value.text, ...readCache(value, index) });
    }
    case 'image':
      return Object.freeze({
        type: 'image',
        source: readMediaSource(value.source, index, AI_IMAGE_MEDIA_TYPES),
        ...readCache(value, index),
      });
    case 'file': {
      const mediaType = value.mediaType;
      if (
        typeof mediaType !== 'string' ||
        !AI_FILE_MEDIA_TYPES.includes(mediaType as AiFileMediaType)
      ) {
        throw invalidMessages('media_type', index);
      }
      const source = readMediaSource(value.source, index, [mediaType]);
      if (
        value.title !== undefined &&
        (typeof value.title !== 'string' || value.title.length > 512)
      ) {
        throw invalidMessages('title', index);
      }
      return Object.freeze({
        type: 'file',
        mediaType: mediaType as AiFileMediaType,
        source,
        ...(value.title === undefined ? {} : { title: value.title }),
        ...readCache(value, index),
      });
    }
    case 'reasoning':
      if (typeof value.text !== 'string') throw invalidMessages('reasoning', index);
      return Object.freeze({ type: 'reasoning', text: value.text });
    case 'tool-call': {
      if (!isLabel(value.id) || !isLabel(value.name)) throw invalidMessages('tool_call', index);
      const input = copyJson(value.input);
      if (input === undefined) throw invalidMessages('tool_call', index);
      return Object.freeze({ type: 'tool-call', id: value.id, name: value.name, input });
    }
    default: {
      if (!isLabel(value.id) || !isLabel(value.name) || typeof value.isError !== 'boolean') {
        throw invalidMessages('tool_result', index);
      }
      return Object.freeze({
        type: 'tool-result',
        id: value.id,
        name: value.name,
        output: readToolOutput(value.output, index),
        isError: value.isError,
        ...readCache(value, index),
      });
    }
  }
}

function readNative(value: unknown, index: number): AiNativeContent {
  if (!isPlainObject(value) || !isLabel(value.provider) || !isLabel(value.model)) {
    throw invalidMessages('native', index);
  }
  const content = copyJson(value.content);
  if (content === undefined || !Array.isArray(content)) throw invalidMessages('native', index);
  return Object.freeze({
    provider: value.provider,
    model: value.model,
    content: content as readonly unknown[],
  });
}

function readMeta(value: unknown, index: number): AiMessageMeta {
  if (!isPlainObject(value)) throw invalidMessages('meta', index);
  const meta: {
    provider?: string;
    model?: string;
    responseId?: string;
    finishReason?: AiFinishReason;
    usage?: AiUsage;
  } = {};
  for (const key of ['provider', 'model', 'responseId'] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (!isLabel(field)) throw invalidMessages('meta', index);
    meta[key] = field;
  }
  if (value.finishReason !== undefined) {
    if (!AI_FINISH_REASONS.includes(value.finishReason as AiFinishReason)) {
      throw invalidMessages('meta', index);
    }
    meta.finishReason = value.finishReason as AiFinishReason;
  }
  if (value.usage !== undefined) {
    if (!isAiUsage(value.usage)) throw invalidMessages('meta', index);
    const usage = value.usage;
    meta.usage = Object.freeze({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    });
  }
  return Object.freeze(meta);
}

/** Parse one message's shape (role, parts per role, native, meta); no cross-message rules. */
export function readMessage(value: unknown, index: number): AiMessage {
  if (!isPlainObject(value)) throw invalidMessages('not_object', index);
  const role = value.role;
  if (typeof role !== 'string' || !AI_ROLES.includes(role as AiRole)) {
    throw invalidMessages('role', index);
  }
  if (!Array.isArray(value.parts)) throw invalidMessages('parts', index);
  const parts = (value.parts as readonly unknown[]).map((part) =>
    readPart(part, role as AiRole, index),
  );
  let native: AiNativeContent | undefined;
  if (value.native !== undefined) {
    if (role !== 'assistant') throw invalidMessages('native', index);
    native = readNative(value.native, index);
  }
  if (parts.length === 0 && (native === undefined || native.content.length === 0)) {
    throw invalidMessages('empty_message', index);
  }
  return Object.freeze({
    role: role as AiRole,
    parts: Object.freeze(parts),
    ...(native === undefined ? {} : { native }),
    ...(value.meta === undefined ? {} : { meta: readMeta(value.meta, index) }),
  });
}

/** The message's tool-call parts, in order. */
export function toolCallsOf(message: AiMessage): readonly AiToolCallPart[] {
  return message.parts.filter((part): part is AiToolCallPart => part.type === 'tool-call');
}

/** The message's tool-result parts, in order. */
export function toolResultsOf(message: AiMessage): readonly AiToolResultPart[] {
  return message.parts.filter((part): part is AiToolResultPart => part.type === 'tool-result');
}

/** Check the cross-message rules over already-shaped messages. */
export function checkTranscript(
  messages: readonly AiMessage[],
  mode: 'request' | 'transcript',
): void {
  if (mode === 'request' && messages.length === 0) throw invalidMessages('empty');
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  messages.forEach((message, index) => {
    const previous = index > 0 ? messages[index - 1] : undefined;
    const next = messages[index + 1];
    if (index === 0 && message.role !== 'user') throw invalidMessages('first_message', index);

    if (message.role === 'system') {
      if (previous?.role !== 'user') throw invalidMessages('system_placement', index);
      if (next !== undefined && next.role !== 'assistant') {
        throw invalidMessages('system_placement', index);
      }
    }

    const results = toolResultsOf(message);
    if (results.length > 0) {
      const firstOther = message.parts.findIndex((part) => part.type !== 'tool-result');
      if (firstOther !== -1 && firstOther < results.length) {
        throw invalidMessages('tool_result_order', index);
      }
      const answered = previous?.role === 'assistant' ? toolCallsOf(previous) : [];
      for (const result of results) {
        if (resultIds.has(result.id)) throw invalidMessages('duplicate_tool_result_id', index);
        resultIds.add(result.id);
        const call = answered.find((candidate) => candidate.id === result.id);
        if (call === undefined) throw invalidMessages('tool_result_unmatched', index);
        if (call.name !== result.name) throw invalidMessages('tool_result_name', index);
      }
    }

    const calls = toolCallsOf(message);
    for (const call of calls) {
      if (callIds.has(call.id)) throw invalidMessages('duplicate_tool_call_id', index);
      callIds.add(call.id);
    }
    if (calls.length > 0) {
      if (next === undefined) {
        if (mode === 'request') throw invalidMessages('trailing_assistant', index);
      } else {
        const answers = next.role === 'user' ? toolResultsOf(next) : [];
        for (const call of calls) {
          if (!answers.some((answer) => answer.id === call.id)) {
            throw invalidMessages(
              next.role === 'user' ? 'tool_result_missing' : 'dangling_tool_call',
              index,
            );
          }
        }
      }
    }
  });
  const last = messages.at(-1);
  if (mode === 'request' && last?.role === 'assistant') {
    throw invalidMessages('trailing_assistant', messages.length - 1);
  }
}

/**
 * Validate `value` as a message list and return a normalized, deep-frozen
 * copy (unknown fields dropped). Throws `AiError('invalid_messages')` with the
 * failing message index and rule name in `context`.
 */
export function validateMessages(
  value: unknown,
  options: ValidateMessagesOptions = {},
): readonly AiMessage[] {
  const mode = options.mode ?? 'request';
  if (!Array.isArray(value)) throw invalidMessages('not_array');
  const messages = (value as readonly unknown[]).map((message, index) =>
    readMessage(message, index),
  );
  checkTranscript(messages, mode);
  return Object.freeze(messages);
}
