/**
 * The Chat Completions wire shapes the OpenAI-compatible adapter sends, and
 * the structural client it sends them through.
 *
 * Written structurally so that neither this module nor its declarations
 * import the `openai` SDK (an optional peer); the adapter tests assign each
 * shape to the installed SDK's own parameter types, so a field the SDK does
 * not know fails the build. The official `OpenAI` client fits
 * {@link OpenAIChatClient}, and so does `AzureOpenAI`.
 */

/** One part of a user message. */
export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { file_data: string; filename: string } };

/** A function call an assistant message made. */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** One message of a request. */
export type OpenAIWireMessage =
  | { role: 'system'; content: string }
  | { role: 'developer'; content: string }
  | { role: 'user'; content: string | OpenAIContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** A function tool definition. */
export interface OpenAIWireTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: { [keyword: string]: unknown };
    strict?: true;
  };
}

/** A streaming chat completion request. */
export interface OpenAIWireRequest {
  model: string;
  messages: OpenAIWireMessage[];
  tools?: OpenAIWireTool[];
  tool_choice?: 'none';
  parallel_tool_calls?: false;
  max_completion_tokens?: number;
  max_tokens?: number;
  stop?: string[];
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; schema: { [keyword: string]: unknown }; strict: boolean };
  };
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  temperature?: number;
  top_p?: number;
  seed?: number;
  prompt_cache_key?: string;
  user?: string;
  stream: true;
  stream_options?: { include_usage: true };
}

/** Per-request transport options the adapter passes the client. */
export interface OpenAIRequestInit {
  readonly signal: AbortSignal;
  readonly headers: Record<string, string>;
}

/**
 * The Chat Completions client the adapter calls. `create` is called with
 * `stream: true` and must resolve to the stream of `chat.completion.chunk`
 * objects, pulled on demand.
 */
export interface OpenAIChatClient {
  readonly chat: {
    readonly completions: {
      create(
        body: OpenAIWireRequest,
        options: OpenAIRequestInit,
      ): PromiseLike<AsyncIterable<unknown>>;
    };
  };
}
