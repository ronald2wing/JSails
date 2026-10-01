/**
 * The `@jsails/ai/openai-compatible` entry: an OpenAI Chat Completions
 * endpoint (OpenAI, Azure, vLLM, Ollama, OpenRouter, ...) as an
 * `AiProvider`, on the official `openai` SDK (an optional peer).
 *
 * Server-only. Credentials are explicit (`apiKey` or an injected client);
 * nothing is read from the environment, and the SDK's logging is off.
 *
 * ```ts
 * import { generate } from '@jsails/ai';
 * import { createOpenAICompatible } from '@jsails/ai/openai-compatible';
 *
 * const local = createOpenAICompatible({
 *   name: 'ollama',
 *   apiKey: 'unused',
 *   baseURL: 'http://localhost:11434/v1',
 *   maxTokensField: 'max_tokens',
 *   supports: { strictTools: false, streamUsage: true },
 * });
 * const result = await generate({ model: local.model('qwen3'), input: 'Hello' });
 * ```
 */

export { createOpenAICompatible, type OpenAICompatibleProvider } from './openai-provider.js';
export type {
  OpenAICompatibleRequestOptions,
  OpenAICompatibleSettings,
  OpenAICompatibleSupport,
} from './openai-options.js';
export type {
  OpenAIChatClient,
  OpenAIContentPart,
  OpenAIRequestInit,
  OpenAIToolCall,
  OpenAIWireMessage,
  OpenAIWireRequest,
  OpenAIWireTool,
} from './openai-wire.js';
