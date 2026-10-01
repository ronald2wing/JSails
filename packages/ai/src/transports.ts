/**
 * Built-in transports over the {@link AiTransport} contract.
 *
 * - {@link createHttpTransport} — a fetch-based backend: POST the request as
 *   JSON to a chat-completion endpoint and read `{ message, toolCalls }` back.
 * - {@link createMcpTransport} — an adapter over an MCP client, so a model
 *   reachable through an MCP server's `chat` tool is one transport.
 *
 * Both parse the backend's reply as untrusted JSON and reject a malformed
 * reply with a value-free {@link AiError}. Server-leaning (they use the global
 * `fetch` or an MCP client) but otherwise dependency-free.
 */

import { isRecord } from 'jsails/plugin-sdk';
import {
  AiError,
  type AiMessage,
  type AiTool,
  type AiToolCall,
  type AiTransport,
  type AiTransportReply,
  type AiTransportRequest,
} from './contracts.js';

/** Options for {@link createHttpTransport}. */
export interface HttpTransportOptions {
  /** The chat-completion endpoint (POST `{ messages, tools? }`). */
  readonly endpoint: string;
  /** Headers (auth) to send on every request. */
  readonly headers?: Record<string, string>;
  /** Injectable fetch (defaults to `globalThis.fetch`). */
  readonly fetch?: typeof fetch;
}

/**
 * A fetch-based backend. Sends `{ messages }` (plus `tools` when present) as
 * JSON; the JSON response is the assistant reply. `stream` is not negotiated
 * here — the runtime falls back to `complete` for this transport.
 */
export function createHttpTransport(options: HttpTransportOptions): AiTransport {
  const fetchFn = options.fetch ?? globalThis.fetch;

  return {
    async complete(request: AiTransportRequest): Promise<AiTransportReply> {
      const response = await fetchFn(options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        body: JSON.stringify({
          messages: request.messages,
          ...(request.tools.length > 0 ? { tools: request.tools.map(toolSchema) } : {}),
        }),
      });
      if (!response.ok) {
        throw new AiError('transport_failed', `backend responded ${String(response.status)}`);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new AiError('transport_failed', 'backend reply is not JSON');
      }
      return parseReply(data, { role: 'assistant', content: '' });
    },
  };
}

/** Reduce a tool to its wire shape: name, description, and parameters. */
function toolSchema(tool: AiTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
  };
}

/** The MCP client surface the MCP transport consumes. */
export interface McpLikeClient {
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: readonly { type: string; text?: string }[];
  }>;
}

/** Options for {@link createMcpTransport}. */
export interface McpTransportOptions {
  /** The MCP client (or registry-wrapping client) to talk to. */
  readonly client: McpLikeClient;
  /** The chat-completion tool name on the MCP server (default `chat`). */
  readonly chatTool?: string;
}

/**
 * Adapt an MCP client as the AI backend. The model is reached through a
 * `chat` tool the MCP server exposes. A JSON text result is read as
 * `{ message, toolCalls }`; any other text is the assistant's reply verbatim.
 */
export function createMcpTransport(options: McpTransportOptions): AiTransport {
  const chatTool = options.chatTool ?? 'chat';
  return {
    async complete(request: AiTransportRequest): Promise<AiTransportReply> {
      const result = await options.client.callTool(chatTool, { messages: request.messages });
      const text = result.content.find(
        (part) => part.type === 'text' && part.text !== undefined,
      )?.text;
      if (text === undefined) {
        throw new AiError('transport_failed', 'the MCP chat tool returned no text');
      }
      const plain: AiMessage = { role: 'assistant', content: text };
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { message: plain, toolCalls: [] };
      }
      return isRecord(parsed) ? parseReply(parsed, plain) : { message: plain, toolCalls: [] };
    },
  };
}

const MESSAGE_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'tool']);

/** Whether an untrusted value has the {@link AiMessage} shape. */
function isMessage(value: unknown): value is AiMessage {
  return (
    isRecord(value) &&
    typeof value.role === 'string' &&
    MESSAGE_ROLES.has(value.role) &&
    typeof value.content === 'string' &&
    (value.toolCallId === undefined || typeof value.toolCallId === 'string')
  );
}

/** Whether an untrusted value has the {@link AiToolCall} shape. */
function isToolCall(value: unknown): value is AiToolCall {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isRecord(value.arguments)
  );
}

/**
 * Read an untrusted backend reply. A missing `message` becomes `fallback`; a
 * malformed message or tool call is rejected rather than passed to the loop.
 */
function parseReply(data: unknown, fallback: AiMessage): AiTransportReply {
  if (!isRecord(data)) {
    throw new AiError('transport_failed', 'backend reply is not an object');
  }
  if (data.message !== undefined && !isMessage(data.message)) {
    throw new AiError('transport_failed', 'backend reply carries a malformed message');
  }
  const toolCalls = data.toolCalls ?? [];
  if (!Array.isArray(toolCalls) || !toolCalls.every(isToolCall)) {
    throw new AiError('transport_failed', 'backend reply carries a malformed tool call');
  }
  return { message: data.message ?? fallback, toolCalls };
}
