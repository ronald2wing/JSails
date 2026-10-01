/**
 * The `@jsails/ai` package: a provider-neutral AI runtime.
 *
 * The runtime and its contract are browser-safe; the built-in transports are
 * server-leaning but dependency-free beyond `fetch` or an MCP client.
 *
 * ```ts
 * import { createAiRuntime, createMcpTransport } from '@jsails/ai';
 * import { createInProcessMcpClient } from 'jsails/mcp';
 * const runtime = createAiRuntime(createMcpTransport({
 *   client: createInProcessMcpClient(registry),
 * }));
 * const reply = await runtime.chat([{ role: 'user', content: 'hi' }]);
 * ```
 */

export { createAiRuntime, type AiRuntime } from './runtime.js';
export {
  AiError,
  type AiErrorCode,
  type AiMessage,
  type AiRunOptions,
  type AiStreamEvent,
  type AiTool,
  type AiToolCall,
  type AiTransport,
  type AiTransportReply,
  type AiTransportRequest,
} from './contracts.js';
export {
  createHttpTransport,
  createMcpTransport,
  type HttpTransportOptions,
  type McpLikeClient,
  type McpTransportOptions,
} from './transports.js';
export { aiTool, type AiToolOptions } from './data-tool.js';
