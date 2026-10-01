/**
 * The Messages API wire shapes the Anthropic adapter sends, and the
 * structural client it sends them through.
 *
 * These are the subset of `@anthropic-ai/sdk` request types the adapter
 * produces, written structurally so that neither this module nor its
 * declarations import the SDK (it is an optional peer). The adapter tests
 * assign each shape to the installed SDK's own parameter types, so a field
 * the SDK does not know, or a value it does not accept, fails the build.
 *
 * {@link AnthropicMessagesClient} is what the adapter calls: the official
 * `Anthropic` client fits it, and so do the platform clients (Bedrock Mantle,
 * Vertex, Foundry, Claude Platform on AWS), which expose the same `messages`
 * surface.
 */

import type { AiEffort, AiImageMediaType } from '../content/types.js';

/** A prompt-cache breakpoint. */
export interface AnthropicCacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

/** A text block. */
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

/** An image block. */
export interface AnthropicImageBlock {
  type: 'image';
  source:
    { type: 'base64'; media_type: AiImageMediaType; data: string } | { type: 'url'; url: string };
  cache_control?: AnthropicCacheControl;
}

/** A document block (PDF or plain text). */
export interface AnthropicDocumentBlock {
  type: 'document';
  source:
    | { type: 'base64'; media_type: 'application/pdf'; data: string }
    | { type: 'url'; url: string }
    | { type: 'text'; media_type: 'text/plain'; data: string };
  title?: string;
  cache_control?: AnthropicCacheControl;
}

/** A tool result block. */
export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | (AnthropicTextBlock | AnthropicImageBlock)[];
  is_error?: true;
  cache_control?: AnthropicCacheControl;
}

/** A tool call block, as the adapter rebuilds one from neutral parts. */
export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

/** A block a user message carries. */
export type AnthropicUserBlock =
  AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock | AnthropicToolResultBlock;

/**
 * A block an assistant message carries. Replayed native content is passed
 * through unchanged and may hold any block type the API returned (thinking,
 * citations, fallback, server-tool blocks); it is typed by the two shapes
 * the adapter itself builds.
 */
export type AnthropicAssistantBlock = AnthropicTextBlock | AnthropicToolUseBlock;

/** One message of a request. */
export type AnthropicWireMessage =
  | { role: 'user'; content: AnthropicUserBlock[] }
  | { role: 'assistant'; content: AnthropicAssistantBlock[] }
  | { role: 'system'; content: AnthropicTextBlock[] };

/** A client tool definition. */
export interface AnthropicWireTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; [keyword: string]: unknown };
  strict?: true;
  eager_input_streaming?: true;
}

/** The fields a token count and a message request share. */
export interface AnthropicCountTokensRequest {
  model: string;
  messages: AnthropicWireMessage[];
  system?: AnthropicTextBlock[];
  tools?: AnthropicWireTool[];
  tool_choice?: { type: 'auto'; disable_parallel_tool_use: true } | { type: 'none' };
  thinking?: { type: 'adaptive'; display: 'omitted' | 'summarized' };
  output_config?: {
    effort?: AiEffort;
    format?: { type: 'json_schema'; schema: { [keyword: string]: unknown } };
  };
  cache_control?: AnthropicCacheControl;
  speed?: 'fast';
}

/** A streaming message request. */
export interface AnthropicWireRequest extends AnthropicCountTokensRequest {
  max_tokens: number;
  stop_sequences?: string[];
  inference_geo?: string;
  metadata?: { user_id: string };
  /** Server-side refusal fallbacks (beta `server-side-fallback-2026-07-01`). */
  fallbacks?: 'default' | { model: string }[];
  stream: true;
}

/** Per-request transport options the adapter passes the client. */
export interface AnthropicRequestInit {
  readonly signal: AbortSignal;
  readonly headers: Record<string, string>;
}

/**
 * The Messages API client the adapter calls. `create` is called with
 * `stream: true` and must resolve to the raw server-sent event stream
 * (`message_start`, `content_block_*`, `message_delta`, `message_stop`),
 * pulled on demand. `countTokens` is optional; without it the provider
 * reports that it cannot count tokens.
 */
export interface AnthropicMessagesClient {
  readonly messages: {
    create(
      body: AnthropicWireRequest,
      options: AnthropicRequestInit,
    ): PromiseLike<AsyncIterable<unknown>>;
    countTokens?(
      body: AnthropicCountTokensRequest,
      options: AnthropicRequestInit,
    ): PromiseLike<{ readonly input_tokens: number }>;
  };
}
