/**
 * The value-free {@link AiError} and its stable {@link AiErrorCode} set.
 *
 * Every failure the package raises is an `AiError`. Its message is a fixed
 * sentence per call site and never echoes a prompt, a tool input or output, a
 * provider reply, or a credential; `context` carries only static scalars such
 * as a message index or a rule name. `retryAfterMs` is set on `rate_limited`
 * and `provider_unavailable` when the provider said how long to wait.
 * `checkpoint_failed` wraps an error thrown by the app's own checkpoint hook,
 * kept as `cause`. `stream_failed` is a browser-side event stream that is not
 * a well-formed ai.v1 stream (a non-2xx status, a wrong content type, a
 * malformed event, or a stream cut before `finish`); `mcp_failed` is an MCP
 * server whose tool listing failed or broke the protocol.
 */

import { JsailsError } from 'jsails/support';

/** Stable failure codes carried by {@link AiError}. */
export type AiErrorCode =
  | 'invalid_options'
  | 'invalid_messages'
  | 'invalid_input'
  | 'invalid_tool'
  | 'invalid_conversation'
  | 'conversation_conflict'
  | 'tool_input_invalid'
  | 'tool_output_invalid'
  | 'tool_failed'
  | 'tool_denied'
  | 'unknown_tool'
  | 'tool_timed_out'
  | 'step_limit'
  | 'tool_call_limit'
  | 'budget_exceeded'
  | 'output_invalid'
  | 'output_truncated'
  | 'refused'
  | 'context_length_exceeded'
  | 'aborted'
  | 'timed_out'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'provider_auth'
  | 'provider_rejected'
  | 'provider_failed'
  | 'unsupported_capability'
  | 'checkpoint_failed'
  | 'stream_failed'
  | 'mcp_failed';

/** Every {@link AiErrorCode}, in declaration order. */
export const AI_ERROR_CODES: readonly AiErrorCode[] = Object.freeze([
  'invalid_options',
  'invalid_messages',
  'invalid_input',
  'invalid_tool',
  'invalid_conversation',
  'conversation_conflict',
  'tool_input_invalid',
  'tool_output_invalid',
  'tool_failed',
  'tool_denied',
  'unknown_tool',
  'tool_timed_out',
  'step_limit',
  'tool_call_limit',
  'budget_exceeded',
  'output_invalid',
  'output_truncated',
  'refused',
  'context_length_exceeded',
  'aborted',
  'timed_out',
  'rate_limited',
  'provider_unavailable',
  'provider_auth',
  'provider_rejected',
  'provider_failed',
  'unsupported_capability',
  'checkpoint_failed',
  'stream_failed',
  'mcp_failed',
]);

/** Options an {@link AiError} accepts beyond its code and message. */
export interface AiErrorOptions {
  /** Static scalars describing the failure; never a prompt, input, or secret. */
  readonly context?: Readonly<Record<string, string | number | boolean>>;
  /** The one-line fix to try next. Static text, never interpolated. */
  readonly suggestion?: string;
  /** Milliseconds the provider asked the caller to wait before retrying. */
  readonly retryAfterMs?: number;
  /**
   * The app's own error this one wraps (a failed checkpoint hook). Kept for
   * the app's logs; never copied into the message or context.
   */
  readonly cause?: unknown;
}

/** Raised for every AI failure. The message never echoes content, inputs, or provider replies. */
export class AiError extends JsailsError {
  readonly code: AiErrorCode;
  /** Milliseconds to wait before retrying, when the provider said so. */
  readonly retryAfterMs: number | undefined;

  constructor(code: AiErrorCode, message: string, options: AiErrorOptions = {}) {
    super(message, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...(options.context === undefined ? {} : { context: options.context }),
      ...(options.suggestion === undefined ? {} : { suggestion: options.suggestion }),
    });
    this.code = code;
    const retryAfterMs = options.retryAfterMs;
    this.retryAfterMs =
      retryAfterMs !== undefined && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0
        ? retryAfterMs
        : undefined;
  }
}

/** Whether `value` is an {@link AiError}, optionally with one of `codes`. */
export function isAiError(value: unknown, ...codes: readonly AiErrorCode[]): value is AiError {
  return value instanceof AiError && (codes.length === 0 || codes.includes(value.code));
}
