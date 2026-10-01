/**
 * The `@jsails/ai/anthropic` entry: the Claude Messages API as an
 * `AiProvider`, on the official `@anthropic-ai/sdk` (an optional peer).
 *
 * Server-only. Credentials are explicit (`apiKey` or an injected platform
 * client); nothing is read from the environment, and the SDK's own logging
 * and tracing are turned off so no prompt is recorded.
 *
 * ```ts
 * import { generate } from '@jsails/ai';
 * import { createAnthropic } from '@jsails/ai/anthropic';
 *
 * const anthropic = createAnthropic({ apiKey: secrets.anthropicKey });
 * const result = await generate({ model: anthropic.model('claude-opus-5-5'), input: 'Hello' });
 * ```
 */

export {
  createAnthropic,
  type AnthropicModelId,
  type AnthropicProvider,
} from './anthropic-provider.js';
export type { AnthropicProviderSettings, AnthropicRequestOptions } from './anthropic-options.js';
export type {
  AnthropicAssistantBlock,
  AnthropicCacheControl,
  AnthropicCountTokensRequest,
  AnthropicDocumentBlock,
  AnthropicImageBlock,
  AnthropicMessagesClient,
  AnthropicRequestInit,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserBlock,
  AnthropicWireMessage,
  AnthropicWireRequest,
  AnthropicWireTool,
} from './anthropic-wire.js';
