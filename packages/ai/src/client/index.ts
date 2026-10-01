/**
 * The `@jsails/ai/client` entry: browser-safe reading of an ai.v1 event
 * stream. A WHATWG-conformant SSE parser, `readAiEvents(response)` over a
 * `fetch` response, and `reduceAiEvents` to fold the events into one
 * renderable message. It loads no `node:*` module, no provider SDK, and no
 * server-only `jsails` module.
 *
 * ```ts
 * import { readAiEvents, reduceAiEvents, type AiClientMessage } from '@jsails/ai/client';
 *
 * const response = await fetch('/chat', { method: 'POST', body, signal });
 * let message: AiClientMessage | undefined;
 * for await (const event of readAiEvents(response, { signal })) {
 *   message = reduceAiEvents(message, event);
 *   render(message);
 * }
 * ```
 */

export { createSseParser, type SseEvent, type SseParser } from './sse-parser.js';
export { decodeWireEvent } from './wire-decoding.js';
export { readAiEvents, type ReadAiEventsOptions } from './read-ai-events.js';
export {
  reduceAiEvents,
  type AiClientMessage,
  type AiClientPart,
  type AiClientToolPart,
  type AiClientToolState,
} from './reduce-ai-events.js';
export type {
  AiWireApprovalCall,
  AiWireEvent,
  AiWireEventName,
  AiWireFinish,
  AiWireTool,
  AiWireToolState,
} from '../event-stream/wire-events.js';
