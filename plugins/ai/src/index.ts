/**
 * AI runtime — barrel.
 *
 * Browser-safe runtime + types, plus the built-in transports (server-leaning,
 * but dependency-free beyond `fetch`). Import the pure runtime:
 *
 * ```ts
 * import { createAiRuntime, createMcpTransport, createInProcessMcpClient } from 'jsails/ai';
 * const runtime = createAiRuntime(createMcpTransport({
 *   client: createInProcessMcpClient(registry),
 * }));
 * const reply = await runtime.chat([{ role: 'user', content: 'hi' }]);
 * ```
 */

export { createAiRuntime } from './runtime.js';
export { assertValidMessages } from './transport-contract.js';
export type { AiRuntime } from './runtime.js';
export type { AiTransport, AiTransportReply, AiTransportRequest } from './transport-contract.js';

export { createHttpTransport, createMcpTransport } from './transports.js';
export type { HttpTransportOptions, McpTransportOptions, McpLikeClient } from './transports.js';

export { aiTool, type AiToolFromDataOptions } from './data-tool.js';

export { AiError } from './contracts.js';
export type { AiMessage, AiRunOptions, AiStreamEvent, AiTool, AiToolCall } from './contracts.js';
