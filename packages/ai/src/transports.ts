/**
 * Built-in transports over the {@link AiTransport} contract.
 *
 * - {@link createHttpTransport} — a fetch-based backend: POST the request as
 *   JSON to a chat-completion endpoint and read `{ message, toolCalls }` back.
 * - {@link createMcpTransport} — an adapter over an MCP client, so a model
 *   reachable through an MCP server's `chat` tool is one transport.
 *
 * Both parse the backend's reply as untrusted JSON and reject a malformed
 * reply with a value-free {@link AiError}. Both bound each request with a
 * timeout (60 s by default) and honour the caller's abort signal, and every
 * failure (a network error, an MCP client rejection, an oversized reply) is a
 * value-free `AiError`: a raw fetch error can carry the backend's host and
 * address in its `cause`, so it never escapes. Server-leaning (they use the
 * global `fetch` or an MCP client) but otherwise dependency-free.
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

/** Default per-request timeout for both transports. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Default cap on an HTTP backend reply body. */
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Options for {@link createHttpTransport}. */
export interface HttpTransportOptions {
  /** The chat-completion endpoint (POST `{ messages, tools?, temperature?, model? }`). */
  readonly endpoint: string;
  /** Headers (auth) to send on every request. */
  readonly headers?: Record<string, string>;
  /** Injectable fetch (defaults to `globalThis.fetch`). */
  readonly fetch?: typeof fetch;
  /** Model identifier sent as `model` in every request body. */
  readonly model?: string;
  /**
   * Extra provider fields merged into every request body. The standard fields
   * (`messages`, `tools`, `temperature`, `model`) win over a same-named key.
   */
  readonly body?: Readonly<Record<string, unknown>>;
  /** Per-request timeout in milliseconds. Defaults to 60 000; `0` disables it. */
  readonly timeoutMs?: number;
  /** Largest reply body read, in bytes. Defaults to 4 MiB. */
  readonly maxResponseBytes?: number;
}

/** Validate a timeout option value-free; returns the effective value. */
function resolveTimeout(value: unknown): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new AiError('invalid_options', 'timeoutMs must be a non-negative finite number');
  }
  return timeoutMs;
}

/**
 * The signal one backend request runs under: the caller's signal and the
 * timeout, whichever fires first. `clear` stops the timer.
 */
function requestSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): {
  readonly signal: AbortSignal | undefined;
  readonly timeout: AbortSignal | undefined;
  clear(): void;
} {
  if (timeoutMs === 0) {
    return { signal: caller, timeout: undefined, clear: () => undefined };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Never keep the process alive just for this timer.
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    timer.unref();
  }
  const timeout = controller.signal;
  return {
    signal: caller === undefined ? timeout : AbortSignal.any([caller, timeout]),
    timeout,
    clear: () => clearTimeout(timer),
  };
}

/** Map a failed backend request to a value-free error. */
function requestFailure(
  caller: AbortSignal | undefined,
  timeout: AbortSignal | undefined,
  error: unknown,
): AiError {
  if (error instanceof AiError) return error;
  if (caller?.aborted === true) return new AiError('aborted', 'the AI call was aborted');
  if (timeout?.aborted === true) return new AiError('timed_out', 'the backend request timed out');
  return new AiError('transport_failed', 'the backend request failed');
}

/** Read a response body as text, refusing one larger than `maxBytes`. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new AiError('transport_failed', 'backend reply is too large');
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new AiError('transport_failed', 'backend reply is too large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * A fetch-based backend. Sends `{ messages }` (plus `tools`, `temperature`,
 * `model`, and the extra `body` fields when present) as JSON; the JSON
 * response is the assistant reply. `stream` is not negotiated here — the
 * runtime falls back to `complete` for this transport.
 */
export function createHttpTransport(options: HttpTransportOptions): AiTransport {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new AiError('invalid_options', 'maxResponseBytes must be a positive integer');
  }
  if (options.body !== undefined && !isRecord(options.body)) {
    throw new AiError('invalid_options', 'body must be an object');
  }
  if (options.model !== undefined && (typeof options.model !== 'string' || options.model === '')) {
    throw new AiError('invalid_options', 'model must be a non-empty string');
  }

  return {
    async complete(request: AiTransportRequest): Promise<AiTransportReply> {
      const body = JSON.stringify({
        ...(options.body ?? {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        messages: request.messages,
        ...(request.tools.length > 0 ? { tools: request.tools.map(toolSchema) } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      });
      const { signal, timeout, clear } = requestSignal(request.signal, timeoutMs);
      let text: string;
      try {
        const response = await fetchFn(options.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
          body,
          ...(signal !== undefined ? { signal } : {}),
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw new AiError('transport_failed', `backend responded ${String(response.status)}`);
        }
        text = await readBounded(response, maxResponseBytes);
      } catch (error) {
        throw requestFailure(request.signal, timeout, error);
      } finally {
        clear();
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
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
  /** Per-request timeout in milliseconds. Defaults to 60 000; `0` disables it. */
  readonly timeoutMs?: number;
}

/**
 * Settle with `promise`, or reject once `signal` fires. The MCP client takes
 * no signal, so an abandoned call keeps running; its late result is ignored.
 */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('failed'));
      },
    );
  });
}

/**
 * Adapt an MCP client as the AI backend. The model is reached through a
 * `chat` tool the MCP server exposes, called with `{ messages }` plus `tools`
 * and `temperature` when present. A JSON text result is read as
 * `{ message, toolCalls }`; any other text is the assistant's reply verbatim.
 */
export function createMcpTransport(options: McpTransportOptions): AiTransport {
  const chatTool = options.chatTool ?? 'chat';
  const timeoutMs = resolveTimeout(options.timeoutMs);
  return {
    async complete(request: AiTransportRequest): Promise<AiTransportReply> {
      const args: Record<string, unknown> = {
        messages: request.messages,
        ...(request.tools.length > 0 ? { tools: request.tools.map(toolSchema) } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      };
      const { signal, timeout, clear } = requestSignal(request.signal, timeoutMs);
      let result: Awaited<ReturnType<McpLikeClient['callTool']>>;
      try {
        result = await raceSignal(options.client.callTool(chatTool, args), signal);
      } catch (error) {
        throw requestFailure(request.signal, timeout, error);
      } finally {
        clear();
      }
      if (!isRecord(result) || !Array.isArray(result.content)) {
        throw new AiError('transport_failed', 'the MCP chat tool returned a malformed result');
      }
      const parts: readonly unknown[] = result.content;
      const part = parts.find(
        (candidate) =>
          isRecord(candidate) && candidate.type === 'text' && typeof candidate.text === 'string',
      );
      const text = isRecord(part) && typeof part.text === 'string' ? part.text : undefined;
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
